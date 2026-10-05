// A stand-in for py-child.mjs / qjs-child.mjs that speaks the same IPC protocol (../protocol.ts) without
// Pyodide or QuickJS, so the pool, the kill paths, the limits and the desk round trip are tested in
// milliseconds. The job's `code` is a command; the cases are in ../fake-ship.ts.
//
// It is started exactly like the real children: node --permission --allow-fs-read=<ship> ... with an empty
// environment and an IPC channel.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHIP = path.dirname(fileURLToPath(import.meta.url));
const mode = fs.existsSync(path.join(SHIP, "boot-mode.txt"))
  ? fs.readFileSync(path.join(SHIP, "boot-mode.txt"), "utf8").trim()
  : "ok";

if (mode === "fatal") {
  process.send({ type: "fatal", error: "sha256 mismatch: pyodide.asm.wasm" });
  process.exit(2);
} else if (mode === "exit") {
  process.exit(3);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  process.send({ type: "ready", timings: { totalMs: 1 } });
}

const bytes = (text) => new TextEncoder().encode(text);
const base = {
  error: null,
  errorName: null,
  why: null,
  value: null,
  stdout: "",
  stderr: "",
  files: {},
  skipped: [],
  tooLarge: false,
  discard: false,
  runMs: 1,
};

function respond(job, patch) {
  process.send({ type: "result", id: job.id, ...base, ...patch });
}

function tryRead(file) {
  try {
    fs.readFileSync(file);
    return "READ";
  } catch (error) {
    return error?.code ?? "ERR";
  }
}

async function handle(job) {
  const [command, ...rest] = String(job.code).split(":");
  switch (command) {
    case "echo":
      return respond(job, { stdout: rest.join(":") || "echo" });
    case "pid":
      return respond(job, { stdout: String(process.pid) });
    case "files":
      return respond(job, { stdout: JSON.stringify(job.files) });
    case "env":
      return respond(job, {
        stdout: JSON.stringify({
          keys: Object.keys(process.env).sort(),
          secret: process.env.AGENTFORGE_SECRETS_KEY ?? "absent",
        }),
      });
    case "argv":
      return respond(job, { stdout: JSON.stringify(process.execArgv) });
    case "fs-escape":
      // The ship directory is readable; its parent is not.
      return respond(job, {
        stdout: JSON.stringify({
          inside: tryRead(path.join(SHIP, "py-child.mjs")),
          outside: tryRead(path.join(SHIP, "..", "outside.txt")),
        }),
      });
    case "spawn-escape": {
      try {
        const cp = await import("node:child_process");
        cp.execSync("whoami");
        return respond(job, { stdout: "SPAWNED" });
      } catch (error) {
        return respond(job, { stdout: error?.code ?? "ERR" });
      }
    }
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, Number(rest[0] ?? "100")));
      return respond(job, { stdout: "slept" });
    case "hang":
      return undefined;
    case "crash":
      process.stderr.write(
        "node:internal/process: Error [ERR_ACCESS_DENIED]: Access to this API has been restricted. Use --allow-child-process to manage permissions.\n",
      );
      process.exit(1);
      return undefined;
    case "oom":
      process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
      process.exit(134);
      return undefined;
    case "write":
      return respond(job, { files: { [rest[0]]: bytes(rest.slice(1).join(":")) } });
    case "binary":
      return respond(job, { files: { "out/blob.bin": new Uint8Array([0xff, 0xfe, 0xfd, 0x00]) } });
    case "nul":
      return respond(job, { files: { "out/nul.txt": bytes("a\u0000b") } });
    case "badname":
      return respond(job, {
        files: { "out/../escape.txt": bytes("x"), "notout.txt": bytes("y"), "out/ok.txt": bytes("fine") },
      });
    case "many":
      return respond(job, {
        files: Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`out/f${String(i).padStart(2, "0")}.txt`, bytes(String(i))]),
        ),
      });
    case "big":
      return respond(job, { files: { "out/big.txt": new Uint8Array(2 * 1024 * 1024 + 1).fill(97) } });
    case "tooLarge":
      return respond(job, { tooLarge: true });
    case "discard":
      return respond(job, { stdout: "discarded", discard: true });
    case "noise":
      return respond(job, { stdout: "x".repeat(200_000), stderr: "y".repeat(200_000) });
    case "error": {
      const [name, ...text] = rest;
      return respond(job, { error: text.join(":"), errorName: name });
    }
    case "partial-fail":
      return respond(job, {
        error: "RuntimeError: boom",
        errorName: "RuntimeError",
        files: { "out/half.txt": bytes("half") },
      });
    case "value":
      return respond(job, { stdout: "printed", value: rest.join(":") });
    default:
      return respond(job, { error: `unknown command ${command}`, errorName: "Error" });
  }
}

process.on("message", (job) => {
  if (job?.type === "job") {
    void handle(job);
  }
});
