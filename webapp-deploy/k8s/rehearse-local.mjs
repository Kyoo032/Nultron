#!/usr/bin/env node
/**
 * Rehearse the Nultron Enterprise Kubernetes manifests on Docker Desktop's built-in cluster, reachable
 * on THIS machine only. HARNESS: it applies overlays/local and nothing else, never pushes an image,
 * never opens a tunnel and never listens on anything but loopback.
 *
 *   node webapp-deploy/k8s/rehearse-local.mjs [--email <address>] [--skip-build | --force-build] [--no-forward]
 *
 * In order: preflight (the docker-desktop context answers and its node is Ready) -> secrets.env and
 * pki/ (generated once, gitignored) -> build the two local images from a safe working-tree snapshot
 * -> kubectl apply -k -> wait for Postgres, the portal and the app -> seed one tenant and one account
 * -> store the client secret the seed prints once, restart the app on it -> start the loopback
 * port-forward -> print the URL. Re-running it is safe: nothing is rotated, only changed.
 *
 * Every kubectl call names `--context docker-desktop`, so the cluster your current context points at
 * is never touched.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runningSupervisor } from "./forward-local.mjs";
import { buildLocalImages } from "./local-images.mjs";
import {
  APP_HOST,
  APP_ORIGIN,
  CLIENT_SECRET_PLACEHOLDER,
  CONTEXT,
  K8S_DIR,
  LOCAL_PORT,
  NAMESPACE,
  PKI_DIR,
  PORTAL_ORIGIN,
  STATE_DIR,
  completeSecrets,
  ensurePki,
  findOpenssl,
  gitShortSha,
  imageTag,
  kubectl,
  mustSucceed,
  readSecrets,
  run,
  writeGeneratedOverlay,
  writeSecrets,
} from "./local-lib.mjs";

const DEFAULT_EMAIL = "tester@nultron.test";
const STATE_FILE = join(STATE_DIR, "state.json");
const log = (line) => console.log(`rehearse-local: ${line}`);

function parseArgs(argv) {
  const flags = { email: DEFAULT_EMAIL, skipBuild: false, forceBuild: false, forward: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") flags.email = argv[++i];
    else if (arg === "--skip-build") flags.skipBuild = true;
    else if (arg === "--force-build") flags.forceBuild = true;
    else if (arg === "--no-forward") flags.forward = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node webapp-deploy/k8s/rehearse-local.mjs [--email <address>] [--skip-build | --force-build] [--no-forward]");
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!flags.email?.includes("@")) throw new Error("--email needs an address");
  if (flags.skipBuild && flags.forceBuild) throw new Error("--skip-build and --force-build contradict each other");
  return flags;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), ...next }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function preflight() {
  mustSucceed(run("kubectl", ["version", "--client"]), "kubectl --client");
  const contexts = run("kubectl", ["config", "get-contexts", "-o", "name"]).stdout.split(/\r?\n/).map((s) => s.trim());
  if (!contexts.includes(CONTEXT)) {
    throw new Error(`no kubectl context named "${CONTEXT}". Docker Desktop > Settings > Kubernetes > Enable Kubernetes, then wait for it to say "Running".`);
  }
  const nodes = JSON.parse(mustSucceed(kubectl(["get", "nodes", "-o", "json"]), `kubectl get nodes (${CONTEXT})`).stdout);
  if (nodes.items.length === 0) throw new Error(`the ${CONTEXT} cluster has no nodes`);
  for (const node of nodes.items) {
    const ready = node.status.conditions.find((c) => c.type === "Ready");
    if (ready?.status !== "True") throw new Error(`node ${node.metadata.name} is not Ready (${ready?.reason ?? "unknown"})`);
  }
  const info = nodes.items[0].status.nodeInfo;
  log(`cluster ok: ${nodes.items.length} node(s), kubelet ${info.kubeletVersion}, runtime ${info.containerRuntimeVersion}, ${info.osImage}`);
  mustSucceed(run("docker", ["info", "--format", "{{.ServerVersion}}"]), "docker info");
  log(`openssl: ${findOpenssl()}`);
  return { runtime: info.containerRuntimeVersion };
}

// ---------------------------------------------------------------------------
// waiting and diagnosing
// ---------------------------------------------------------------------------

function diagnose() {
  console.error("\n--- diagnostics ---");
  console.error(kubectl(["-n", NAMESPACE, "get", "pods", "-o", "wide"]).stdout);
  const pods = JSON.parse(kubectl(["-n", NAMESPACE, "get", "pods", "-o", "json"]).stdout || '{"items":[]}');
  for (const pod of pods.items) {
    const statuses = [...(pod.status.initContainerStatuses ?? []), ...(pod.status.containerStatuses ?? [])];
    for (const status of statuses.filter((s) => !s.ready)) {
      console.error(`\n[${pod.metadata.name}/${status.name}] ${JSON.stringify(status.state)}`);
      const logs = kubectl(["-n", NAMESPACE, "logs", pod.metadata.name, "-c", status.name, "--tail=25"]);
      console.error(logs.stdout || logs.stderr);
    }
  }
  console.error(kubectl(["-n", NAMESPACE, "get", "events", "--sort-by=.lastTimestamp"]).stdout.split("\n").slice(-15).join("\n"));
}

function waitRollout(kind, name, seconds = 420) {
  log(`waiting for ${kind}/${name} (up to ${seconds}s)`);
  const result = kubectl(["-n", NAMESPACE, "rollout", "status", `${kind}/${name}`, `--timeout=${seconds}s`]);
  if (result.status !== 0) {
    diagnose();
    throw new Error(`${kind}/${name} did not become ready\n${result.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// the seed
// ---------------------------------------------------------------------------

/** The line after "Client secret ... shown once" in `portal:seed` output. Exported shape for the test. */
export function parseSeedSecret(output) {
  const lines = output.split(/\r?\n/);
  const at = lines.findIndex((line) => /^Client secret/.test(line));
  if (at === -1) return null;
  const secretLine = lines.slice(at + 1).find((line) => line.trim() !== "");
  return secretLine ? secretLine.trim() : null;
}

function seedPortal(email, rotate) {
  const args = [
    "-n", NAMESPACE, "exec", "deploy/nultron-portal", "-c", "portal", "--",
    "./node_modules/.bin/tsx", "scripts/seed.ts",
    "--email", email,
    "--tenant", "nultron", "--tenant-name", "Nultron", "--org", "Kyo", "--seat-cap", "5",
    "--redirect", `${APP_ORIGIN}/auth/callback`,
    ...(rotate ? ["--rotate-secret"] : []),
  ];
  const result = mustSucceed(kubectl(args), "portal seed");
  const secret = parseSeedSecret(result.stdout);
  log(`seeded tenant "nultron" and ${email}${secret ? " (a client secret was minted)" : " (client already existed, secret kept)"}`);
  return secret;
}

// ---------------------------------------------------------------------------
// the loopback forward
// ---------------------------------------------------------------------------

function startForward() {
  const running = runningSupervisor();
  if (running) {
    log(`port-forward supervisor already running (pid ${running}); it follows the new pod by itself`);
    return;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  const out = openSync(join(STATE_DIR, "forward.log"), "a");
  const child = spawn(process.execPath, [join(K8S_DIR, "forward-local.mjs")], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  writeState({ forwardPid: child.pid });
  log(`port-forward supervisor started (pid ${child.pid}), 127.0.0.1:${LOCAL_PORT} -> svc/nultron-edge:443`);
}

/** GET /healthz over the forward, verifying the certificate against the throwaway CA, not skipping it. */
function probeHealthz(host) {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: LOCAL_PORT, path: "/healthz", method: "GET", servername: host, headers: { host: `${host}:${LOCAL_PORT}` }, ca: readFileSync(join(PKI_DIR, "ca.crt")), timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, body: error.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function waitForHealthz(host, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  let last = { status: 0, body: "not tried" };
  while (Date.now() < deadline) {
    last = await probeHealthz(host);
    if (last.status === 200) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`https://${host}:${LOCAL_PORT}/healthz did not answer 200 within ${seconds}s (last: ${last.status} ${last.body})`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const { runtime } = preflight();

  const secretsBefore = readSecrets();
  const { values, generated } = completeSecrets(secretsBefore);
  if (generated.length > 0) {
    writeSecrets(values);
    log(`secrets.env: generated ${generated.join(", ")} (gitignored, never rotated by a re-run)`);
  }
  if (ensurePki()) log("pki/: generated a throwaway CA and two leaf certificates (gitignored)");

  let images;
  if (flags.skipBuild) {
    const tag = imageTag(gitShortSha());
    images = { appImage: `nultron-ent:${tag}`, portalImage: `nultron-portal:${tag}` };
    log(`--skip-build: expecting ${images.appImage} and ${images.portalImage} to exist already`);
  } else {
    images = buildLocalImages({ force: flags.forceBuild, log });
  }
  if (!runtime.startsWith("docker://")) {
    log(`note: the node runtime is ${runtime}, not docker. A locally built image is visible to the cluster only when Docker Desktop's containerd image store is on; if pods report ErrImagePull for a local tag, that is why.`);
  }

  const overlay = writeGeneratedOverlay(images);
  log(`kubectl apply -k ${overlay}`);
  mustSucceed(kubectl(["apply", "-k", overlay]), "kubectl apply -k");

  const before = readState();
  const imagesChanged = images.appId && before.appImageId && before.appImageId !== images.appId;
  if (imagesChanged || (images.portalId && before.portalImageId && before.portalImageId !== images.portalId)) {
    log("a local image changed under an unchanged tag: restarting the Deployments that use it");
    kubectl(["-n", NAMESPACE, "rollout", "restart", "deploy/nultron-app", "deploy/nultron-portal"]);
  }

  waitRollout("statefulset", "nultron-portal-db");
  waitRollout("deployment", "mailpit");
  waitRollout("deployment", "nultron-portal");

  // The seed prints the client secret only when it creates the client or rotates it. A placeholder in
  // secrets.env asks for a rotation; a database that was wiped (teardown keeps secrets.env) makes the seed
  // create the client afresh, and then the secret it prints is the only one that will ever match.
  const needsClientSecret = values.AGENTFORGE_PORTAL_CLIENT_SECRET === CLIENT_SECRET_PLACEHOLDER;
  const minted = seedPortal(flags.email, needsClientSecret);
  if (needsClientSecret && !minted) throw new Error("the seed minted no client secret; run it again with --rotate-secret by hand");
  if (minted && minted !== values.AGENTFORGE_PORTAL_CLIENT_SECRET) {
    writeSecrets({ ...values, AGENTFORGE_PORTAL_CLIENT_SECRET: minted });
    mustSucceed(kubectl(["apply", "-k", overlay]), "kubectl apply -k (client secret)");
    mustSucceed(kubectl(["-n", NAMESPACE, "rollout", "restart", "deploy/nultron-app"]), "restart the app on the client secret");
    log("the portal's one-time client secret is now in secrets.env and the app was restarted on it");
  }
  waitRollout("deployment", "nultron-app");
  writeState({ appImageId: images.appId, portalImageId: images.portalId, email: flags.email });

  if (flags.forward) {
    startForward();
    const answer = await waitForHealthz(APP_HOST);
    log(`GET ${APP_ORIGIN}/healthz -> ${answer.status} ${answer.body} (certificate verified against pki/ca.crt)`);
  }

  console.log(`
READY (localhost only)
  app      ${APP_ORIGIN}            (your browser must resolve *.localhost to 127.0.0.1: Chrome, Edge and Firefox do)
  portal   ${PORTAL_ORIGIN}
  sign in  ${flags.email}  -> the one-time code lands in Mailpit, not in your inbox:
           kubectl --context ${CONTEXT} -n ${NAMESPACE} port-forward svc/mailpit 8025:8025   then   http://127.0.0.1:8025
  certificate is signed by a throwaway CA. Your browser will warn once. It is ${join("webapp-deploy", "k8s", "overlays", "local", "pki", "ca.crt")} if you choose to trust it (do not).
  pods     kubectl --context ${CONTEXT} -n ${NAMESPACE} get pods
  forward  node webapp-deploy/k8s/forward-local.mjs [--stop]    (re-run it after you delete the app pod)
  teardown node webapp-deploy/k8s/teardown-local.mjs            (deletes the namespace AND its volumes)
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`\nrehearse-local failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
