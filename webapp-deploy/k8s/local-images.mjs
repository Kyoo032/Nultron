/**
 * Build the two LOCAL images for the rehearsal from a safe snapshot of the working tree, and never
 * push them. `node webapp-deploy/k8s/local-images.mjs [--force]` runs this on its own.
 *
 *   nultron-ent:local-<shortsha>-dirty      webapp-deploy/Dockerfile        (the app image)
 *   nultron-portal:local-<shortsha>-dirty   webapp-deploy/portal.Dockerfile (the portal stand-in)
 *
 * The context is NEVER the checkout. It is `git ls-files -co --exclude-standard` copied into a temp
 * directory, so a git-ignored `.env`, a webdev data dir with its .master-key or `apps/web/.env.local` cannot be
 * packed into a layer (SR-49 half 2, the reason release-web.mjs builds from `git archive <sha>`).
 * This path is for a working tree that is not committed, so the tag says `dirty` and the image is
 * not something to ship: the release path stays `scripts/release-web.mjs` from a sha.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  K8S_DIR,
  REPO_ROOT,
  copySnapshot,
  gitShortSha,
  imageTag,
  mustSucceed,
  portalContextFiles,
  run,
  snapshotFileList,
  untrackedSecrets,
} from "./local-lib.mjs";

export const APP_IMAGE_NAME = "nultron-ent";
export const PORTAL_IMAGE_NAME = "nultron-portal";

function dockerImageId(ref) {
  const result = run("docker", ["image", "inspect", "--format", "{{.Id}}", ref]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function dockerBuild(args, label, log) {
  log(`docker build ${label} (output follows)`);
  const result = run("docker", ["build", ...args], { stdio: "inherit", encoding: undefined });
  if (result.error) throw new Error(`docker build ${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`docker build ${label} exited ${result.status}`);
}

/** A digest of what went into the snapshot, recorded as an image label so a stale tag is visible. */
function snapshotDigest(copied, contextDir) {
  const hash = createHash("sha256");
  for (const path of [...copied].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(join(contextDir, path))).digest());
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Builds both images unless they already exist and `force` is off. Returns the refs and ids.
 * Aborts BEFORE copying anything if an untracked, un-ignored file looks like a secret.
 */
export function buildLocalImages({ force = false, log = console.log, repoRoot = REPO_ROOT, tag: tagOverride = null } = {}) {
  // The compose rehearsal (webapp-deploy/pilot-local.mjs) passes its own tag, so building for it never retags
  // an image the Kubernetes rehearsal's pods are running.
  const tag = tagOverride ?? imageTag(gitShortSha(repoRoot));
  const appImage = `${APP_IMAGE_NAME}:${tag}`;
  const portalImage = `${PORTAL_IMAGE_NAME}:${tag}`;

  if (!force && dockerImageId(appImage) && dockerImageId(portalImage)) {
    log(`images ${appImage} and ${portalImage} already exist; reusing them (--force rebuilds)`);
    return { appImage, portalImage, appId: dockerImageId(appImage), portalId: dockerImageId(portalImage), built: false };
  }

  const list = snapshotFileList(repoRoot);
  const secrets = untrackedSecrets(list);
  if (secrets.length > 0) {
    throw new Error(
      `refusing to build: ${secrets.length} untracked file(s) look like secrets and git does not ignore them:\n  ${secrets.join("\n  ")}\n` +
        "Add them to .gitignore or delete them, then run again.",
    );
  }
  log(`snapshot: ${list.tracked.length} tracked + ${list.untracked.length} untracked-not-ignored files (git ls-files -co --exclude-standard)`);
  if (list.untracked.length > 0) {
    const roots = [...new Set(list.untracked.map((path) => path.split("/").slice(0, 2).join("/")))].sort();
    log(`untracked files that WILL be in the image (by folder): ${roots.slice(0, 12).join(", ")}${roots.length > 12 ? ", ..." : ""}`);
  }

  const work = mkdtempSync(join(tmpdir(), "nultron-k8s-build-"));
  try {
    const all = [...list.tracked, ...list.untracked];
    const appContext = join(work, "app");
    const { copied, skipped } = copySnapshot(repoRoot, appContext, all);
    log(`app context: ${copied.length} files copied, ${skipped.length} skipped`);
    const digest = snapshotDigest(copied, appContext);

    dockerBuild(
      [
        "-f", join(appContext, "webapp-deploy", "Dockerfile"),
        "--label", `io.nultron.snapshot=${digest}`,
        "--label", "io.nultron.local-build=true",
        "-t", appImage, appContext,
      ],
      appImage,
      log,
    );

    const portalContext = join(work, "portal");
    const portalFiles = portalContextFiles(copied);
    // The Dockerfile and its allowlist ignore file are webapp-deploy/portal.Dockerfile{,.dockerignore} (the same
    // files scripts/release-web.mjs builds the release image from); they are tracked once committed, and always
    // copied here.
    copySnapshot(
      repoRoot,
      portalContext,
      [...new Set([...portalFiles, "webapp-deploy/portal.Dockerfile", "webapp-deploy/portal.Dockerfile.dockerignore"])],
    );
    dockerBuild(
      [
        "-f", join(portalContext, "webapp-deploy", "portal.Dockerfile"),
        "--label", `io.nultron.snapshot=${digest}`,
        "--label", "io.nultron.local-build=true",
        "-t", portalImage, portalContext,
      ],
      portalImage,
      log,
    );
    mustSucceed(run("docker", ["image", "inspect", appImage, portalImage]), "docker image inspect");
    return { appImage, portalImage, appId: dockerImageId(appImage), portalId: dockerImageId(portalImage), built: true, digest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = buildLocalImages({ force: process.argv.includes("--force") });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { K8S_DIR };
