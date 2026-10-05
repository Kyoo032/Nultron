#!/usr/bin/env node
/**
 * Undo the local rehearsal: stop the loopback forward and delete the `nultron` namespace on the
 * docker-desktop cluster. THE NAMESPACE'S PERSISTENT VOLUMES GO WITH IT: the app's data volume (the
 * SQLite database, sealed settings, media), the portal's Postgres volume and the backups. That is the
 * point of a rehearsal, and it is not recoverable.
 *
 *   node webapp-deploy/k8s/teardown-local.mjs [--purge-local-files]
 *
 * `--purge-local-files` also removes the gitignored overlays/local/secrets.env, overlays/local/pki/
 * and .local/. Without it they stay, so the next rehearsal reuses the same wrap key and CA. The two
 * local images are left in Docker (`docker rmi nultron-ent:<tag> nultron-portal:<tag>` to remove).
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CONTEXT, K8S_DIR, LOCAL_OVERLAY_DIR, NAMESPACE, STATE_DIR, kubectl, run } from "./local-lib.mjs";
import { join } from "node:path";

const log = (line) => console.log(`teardown-local: ${line}`);

function main() {
  const purge = process.argv.includes("--purge-local-files");
  const contexts = run("kubectl", ["config", "get-contexts", "-o", "name"]).stdout.split(/\r?\n/).map((s) => s.trim());
  if (!contexts.includes(CONTEXT)) {
    log(`no "${CONTEXT}" context; nothing to delete on a cluster`);
  } else {
    spawnSync(process.execPath, [join(K8S_DIR, "forward-local.mjs"), "--stop"], { stdio: "inherit" });
    const exists = kubectl(["get", "namespace", NAMESPACE, "-o", "name"]);
    if (exists.status !== 0) {
      log(`namespace ${NAMESPACE} does not exist on ${CONTEXT}`);
    } else {
      log(`deleting namespace ${NAMESPACE} on ${CONTEXT}; its volumes are deleted with it`);
      const deleted = kubectl(["delete", "namespace", NAMESPACE, "--wait=true", "--timeout=300s"]);
      if (deleted.status !== 0) throw new Error(deleted.stderr.trim() || "kubectl delete namespace failed");
      log(deleted.stdout.trim());
    }
  }
  if (purge) {
    rmSync(join(LOCAL_OVERLAY_DIR, "secrets.env"), { force: true });
    rmSync(join(LOCAL_OVERLAY_DIR, "pki"), { recursive: true, force: true });
    rmSync(STATE_DIR, { recursive: true, force: true });
    log("removed secrets.env, pki/ and .local/");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`teardown-local failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
