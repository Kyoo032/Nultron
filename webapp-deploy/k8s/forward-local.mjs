#!/usr/bin/env node
/**
 * Keep `kubectl port-forward` running to the edge Service, on loopback only, and start it again when
 * it drops. `kubectl port-forward` follows ONE pod: when that pod is deleted or restarted (a rollout,
 * the restart test) the forward exits, and this loop brings it back.
 *
 *   node webapp-deploy/k8s/forward-local.mjs           run in the foreground (rehearse-local.mjs starts it detached)
 *   node webapp-deploy/k8s/forward-local.mjs --stop    stop the detached one
 *
 * Why a port-forward and not a NodePort: Docker Desktop publishes NodePort and LoadBalancer Services
 * on the host's interfaces, which can include the LAN. `kubectl port-forward` binds loopback unless
 * told otherwise, and this script never passes `--address`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTEXT, LOCAL_PORT, NAMESPACE, STATE_DIR } from "./local-lib.mjs";

const PID_FILE = join(STATE_DIR, "forward.pid");
const SERVICE = "svc/nultron-edge";

/** The recorded supervisor, when that process is still alive. */
export function runningSupervisor(pidFile = PID_FILE) {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function stop() {
  if (!existsSync(PID_FILE)) {
    console.log("forward-local: no forward is recorded");
    return;
  }
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  if (process.platform === "win32") {
    // The supervisor and its kubectl child: /T takes the tree.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid);
    } catch {
      // already gone
    }
  }
  writeFileSync(PID_FILE, "");
  console.log(`forward-local: stopped supervisor ${pid}`);
}

function supervise() {
  const existing = runningSupervisor();
  if (existing && existing !== process.pid) {
    console.log(`forward-local: a forward is already running (supervisor ${existing}); not starting a second one`);
    return;
  }
  writeFileSync(PID_FILE, String(process.pid));
  const args = ["--context", CONTEXT, "-n", NAMESPACE, "port-forward", SERVICE, `${LOCAL_PORT}:443`];
  const start = () => {
    console.log(`${new Date().toISOString()} forward-local: kubectl ${args.join(" ")}`);
    const child = spawn("kubectl", args, { stdio: "inherit", windowsHide: true });
    child.on("exit", (code) => {
      console.log(`${new Date().toISOString()} forward-local: kubectl exited ${code}; restarting in 2s`);
      setTimeout(start, 2000);
    });
    child.on("error", (error) => console.log(`forward-local: ${error.message}`));
  };
  start();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--stop")) stop();
  else supervise();
}
