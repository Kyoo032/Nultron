/**
 * Tests for the Kubernetes rehearsal toolkit. Run with:
 *   node --test webapp-deploy/k8s/k8s-rehearsal.test.mjs
 * (scripts/ci-local.mjs only globs scripts/*.test.mjs, so this one is run by hand or by its own step.)
 *
 * What they pin: the Caddy header block cannot drift from the reviewed webapp-deploy/Caddyfile, the
 * build snapshot refuses files that look like secrets, the generated secrets have the shapes the
 * hosted app and the portal accept, and the app pod stays single-replica with a loopback bind.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scramVerifier, sqlLiteral } from "./base/scripts/prepare-db.mjs";
import {
  K8S_DIR,
  REPO_ROOT,
  SECRET_RECIPES,
  completeSecrets,
  formatEnvFile,
  generatedKustomization,
  leafExtensions,
  looksSecret,
  parseEnvFile,
  portalContextFiles,
} from "./local-lib.mjs";
import { parseSeedSecret } from "./rehearse-local.mjs";

const read = (...parts) => readFileSync(join(...parts), "utf8");

/** The `Name "value"` / `-Name` lines inside the first `header {` block that follows `after`. */
function headerLines(text, after) {
  const from = after ? text.indexOf(after) : 0;
  assert.notEqual(from, -1, `${after} not found`);
  const open = text.indexOf("header {", from);
  assert.notEqual(open, -1, "no header block");
  const close = text.indexOf("\n\t}", open);
  const block = text.slice(open + "header {".length, close === -1 ? undefined : close);
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

describe("caddy parity", () => {
  it("nultron_headers in security.caddy equals the header block of webapp-deploy/Caddyfile", () => {
    const reviewed = headerLines(read(REPO_ROOT, "webapp-deploy", "Caddyfile"), "{$NULTRON_DOMAIN} {");
    const copy = headerLines(read(K8S_DIR, "base", "caddy", "security.caddy"), "(nultron_headers)");
    assert.ok(reviewed.length >= 10, "the reviewed block should carry the full header set");
    assert.deepEqual(copy, reviewed);
  });

  it("the filter that keeps the sign-in code out of the log is the reviewed one", () => {
    const reviewed = read(REPO_ROOT, "webapp-deploy", "Caddyfile");
    const copy = read(K8S_DIR, "base", "caddy", "security.caddy");
    for (const needle of ["request>headers>Cookie delete", "request>headers>Authorization delete", "request>headers>Set-Cookie delete", "delete code", "delete state"]) {
      assert.ok(reviewed.includes(needle), `reviewed Caddyfile lost ${needle}`);
      assert.ok(copy.includes(needle), `security.caddy lost ${needle}`);
    }
    // The portal is behind this proxy, so its 302 Location carries the authorization code. The rehearsal found
    // it here first; webapp-deploy/Caddyfile has the same filter since 2026-10-01 (SR-72).
    for (const text of [reviewed, copy]) {
      assert.match(text, /resp_headers>Location query \{\s*delete code\s*delete state\s*\}/);
    }
    // And Caddy's default logger, where the error line for a failed upstream request is written, is filtered the
    // same way. scripts/pilot-deploy.test.mjs compares the whole filter list between the two files.
    for (const text of [reviewed, copy]) assert.match(text, /log default \{/);
  });

  it("security.caddy is imported before the global block that uses its default_log snippet", () => {
    const text = read(K8S_DIR, "base", "caddy", "Caddyfile");
    assert.ok(text.indexOf("import /etc/caddy/security.caddy") < text.indexOf("import default_log"));
  });

  it("the billing webhook is blocked at the edge here too, before the app (SR-03)", () => {
    const text = read(K8S_DIR, "base", "caddy", "Caddyfile");
    assert.match(text, /@billing_webhook path \/api\/v1\/billing\/webhook\*/);
    assert.ok(text.indexOf("respond @billing_webhook 404") < text.indexOf("reverse_proxy 127.0.0.1:3000"));
  });

  it("the rehearsal found the code in a response Location; the filter for it stays", () => {
    assert.match(read(K8S_DIR, "base", "caddy", "security.caddy"), /resp_headers>Location/);
  });

  it("the portal image is webapp-deploy/portal.Dockerfile, one copy, and the snapshot carries it with its allowlist", () => {
    const all = ["webapp-deploy/portal.Dockerfile", "webapp-deploy/portal.Dockerfile.dockerignore", "webapp-deploy/portal-entry.sh", "webapp-deploy/k8s/base/scripts/prepare-db.mjs"];
    assert.deepEqual(portalContextFiles(all).sort(), [...all].sort());
    assert.equal(existsSync(join(K8S_DIR, "images", "Dockerfile.portal")), false, "the second copy is gone");
  });

  it("the app upstream is the loopback port, flushed for SSE, with the health check", () => {
    const text = read(K8S_DIR, "base", "caddy", "Caddyfile")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    assert.match(text, /reverse_proxy 127\.0\.0\.1:3000 \{/);
    assert.match(text, /flush_interval -1/);
    assert.match(text, /health_uri \/healthz/);
    assert.doesNotMatch(text, /header_up Host/, "Host must pass through unchanged");
    assert.doesNotMatch(text, /trusted_proxies/, "exactly one proxy hop (SR-18)");
  });
});

describe("snapshot secret guard", () => {
  it("flags names that look like secrets", () => {
    for (const path of [".env", "apps/web/.env.local", ".webdev-data-design/.master-key", "x/settings.enc", "a/b/agentforge.sqlite", "pki/ca.key", "review.env", "certs/site.pem", "webapp-deploy/k8s/overlays/local/secrets.env"]) {
      assert.equal(looksSecret(path), true, path);
    }
  });

  it("lets ordinary source and the committed examples through", () => {
    for (const path of [".env.example", "apps/web/server.ts", "webapp-deploy/k8s/overlays/local/secrets.env.example", "docs/internal/security-register.md", "apps/web/public/brand/logo.png"]) {
      assert.equal(looksSecret(path), false, path);
    }
  });

  it("the portal context holds the manifests, the portal and the migrations only", () => {
    const all = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "apps/web/package.json", "apps/web/server.ts", "apps/portal/package.json", "apps/portal/src/main.ts", "packages/core/package.json", "packages/core/src/index.ts", "docs/internal/portal/migrations/0001_extensions_and_roles.sql", "docs/internal/security-register.md", "apps/desktop/main.cjs"];
    assert.deepEqual(portalContextFiles(all).sort(), ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "apps/web/package.json", "apps/portal/package.json", "apps/portal/src/main.ts", "packages/core/package.json", "docs/internal/portal/migrations/0001_extensions_and_roles.sql"].sort());
  });
});

describe("generated secrets", () => {
  it("keeps every value that is already there and fills only the gaps", () => {
    const { values, generated } = completeSecrets({ AGENTFORGE_SECRETS_KEY: "keep-me" });
    assert.equal(values.AGENTFORGE_SECRETS_KEY, "keep-me");
    assert.ok(!generated.includes("AGENTFORGE_SECRETS_KEY"));
    assert.equal(Object.keys(SECRET_RECIPES).filter((name) => !(name in values)).length, 0);
  });

  it("has the shapes the hosted app and the portal accept", () => {
    const { values } = completeSecrets({});
    assert.match(values.AGENTFORGE_SECRETS_KEY, /^[0-9a-f]{64}$/, "wrap key: 32 bytes as hex");
    assert.equal(Buffer.from(values.PORTAL_SIGNING_KEY, "base64url").length, 32, "Ed25519 seed: 32 bytes");
    for (const name of ["PORTAL_POSTGRES_PASSWORD", "PORTAL_APP_DB_PASSWORD", "BACKUP_KEY"]) {
      assert.match(values[name], /^[\x21-\x7e]{24,}$/, `${name}: printable ASCII, long enough`);
    }
    assert.notEqual(values.PORTAL_POSTGRES_PASSWORD, values.PORTAL_APP_DB_PASSWORD);
  });

  it("round-trips through the env-file format without leaking a comment into a value", () => {
    const { values } = completeSecrets({});
    assert.deepEqual(parseEnvFile(formatEnvFile(values)), values);
  });
});

describe("generated overlay and certificates", () => {
  it("pins both local image tags", () => {
    const text = generatedKustomization({ appImage: "nultron-ent:local-abc1234-dirty", portalImage: "nultron-portal:local-abc1234-dirty" });
    assert.match(text, /newTag: local-abc1234-dirty/g);
    assert.match(text, /- \.\.\/\.\.\/overlays\/local/);
  });

  it("issues server-auth leaves with the names the browser and the portal use", () => {
    const ext = leafExtensions(["nultron.localhost", "portal.nultron.localhost"]);
    assert.match(ext, /CA:FALSE/);
    assert.match(ext, /extendedKeyUsage=serverAuth/);
    assert.match(ext, /DNS:nultron\.localhost,DNS:portal\.nultron\.localhost/);
  });
});

describe("prepare-db", () => {
  it("writes a SCRAM-SHA-256 verifier whose stored key follows from the password", () => {
    const salt = Buffer.from("0123456789abcdef");
    const verifier = scramVerifier("correct horse", salt, 4096);
    const [, rest] = verifier.split("SCRAM-SHA-256$");
    const [params, keys] = rest.split("$");
    assert.equal(params, `4096:${salt.toString("base64")}`);
    const salted = pbkdf2Sync("correct horse", salt, 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    const [storedKey, serverKey] = keys.split(":");
    assert.equal(storedKey, createHash("sha256").update(clientKey).digest("base64"));
    assert.equal(serverKey, createHmac("sha256", salted).update("Server Key").digest("base64"));
  });

  it("quotes a SQL literal", () => {
    assert.equal(sqlLiteral("a'b"), "'a''b'");
  });
});

describe("seed output", () => {
  it("reads the one-time client secret from the line after its heading", () => {
    const output = ["tenant  nultron  (x)  [created]", "", "Client secret — shown once, and never again. Put it in AGENTFORGE_PORTAL_CLIENT_SECRET:", "", "    s3cr3t-value", ""].join("\n");
    assert.equal(parseSeedSecret(output), "s3cr3t-value");
  });

  it("returns null when the client already existed", () => {
    assert.equal(parseSeedSecret("The OAuth client nultron-web already exists and only its sha256 is stored"), null);
  });
});

describe("the app pod", () => {
  const app = read(K8S_DIR, "base", "app.yaml");

  it("is one replica, Recreate, non-root, read-only, with every capability dropped", () => {
    assert.match(app, /replicas: 1\b/);
    assert.match(app, /type: Recreate/);
    assert.match(app, /runAsNonRoot: true/);
    assert.match(app, /readOnlyRootFilesystem: true/);
    assert.match(app, /drop: \["ALL"\]/);
    assert.doesNotMatch(app, /BIND_HOST/, "the app keeps its loopback bind; the proxy shares the pod");
  });

  it("gives the proxy container no application secret", () => {
    const caddy = app.slice(app.indexOf("- name: caddy"), app.indexOf("volumes:"));
    assert.doesNotMatch(caddy, /secretKeyRef/);
    assert.match(caddy, /nultron-edge-env/);
  });
});

describe("overlays", () => {
  it("every overlay pins the namespace itself (the base's namespace does not reach what an overlay declares)", () => {
    for (const overlay of ["local", "production"]) {
      assert.match(read(K8S_DIR, "overlays", overlay, "kustomization.yaml"), /^namespace: nultron$/m, overlay);
    }
    assert.match(generatedKustomization({ appImage: "a:1", portalImage: "b:1" }), /^namespace: nultron$/m);
  });
});

describe("prepare-db entry point", () => {
  it("still runs when it is started through a symbolic link, as a ConfigMap volume mounts it", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-db-link-"));
    const link = join(dir, "prepare-db.mjs");
    try {
      symlinkSync(join(K8S_DIR, "base", "scripts", "prepare-db.mjs"), link);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      t.skip("this machine does not allow creating a symbolic link");
      return;
    }
    try {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
      const result = spawnSync(process.execPath, [link], { encoding: "utf8", env });
      // Without the real-path comparison the script exits 0 and prints nothing: an init container
      // that "succeeds" having migrated nothing. With it, main runs and refuses the missing variable.
      assert.equal(result.status, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
      assert.match(result.stderr, /PORTAL_MIGRATE_DATABASE_URL is not set/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("portal sign-in mode", () => {
  // Comments are not configuration: a comment may name the variable.
  const settings = (...path) =>
    read(K8S_DIR, ...path)
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

  it("the base portal ConfigMap pins PORTAL_SIGNIN_MODE to password, the Enterprise default (2026-10-09)", () => {
    assert.match(settings("base", "kustomization.yaml"), /^ {6}- PORTAL_SIGNIN_MODE=password$/m);
  });

  it("the production overlay leaves it to the base, and only the Mailpit rehearsal overlay pins the e-mailed code", () => {
    assert.doesNotMatch(settings("overlays", "production", "kustomization.yaml"), /PORTAL_SIGNIN_MODE/);
    assert.match(settings("overlays", "local", "kustomization.yaml"), /^ {6}- PORTAL_SIGNIN_MODE=code$/m);
    assert.match(settings("overlays", "local", "kustomization.yaml"), /^ {6}- PORTAL_SMTP_HOST=mailpit$/m);
  });
});
