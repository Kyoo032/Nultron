// Sandboxed Pyodide child process for `run_code` (Python). Ported from the 2026-10-03 prototype; the
// protocol is documented in ../protocol.ts. Started by ../child-process.ts as
//   <node or Electron-as-node> --permission --allow-fs-read=<shipDir> --disallow-code-generation-from-strings
//     --max-old-space-size=<MB> py-child.mjs <json-config>
// with an empty environment (Electron adds only ELECTRON_RUN_AS_NODE=1), no stdin and an IPC channel.
//
// This file is copied unchanged into the ship directory next to vendor/pyodide. It must stay plain
// ESM with no dependency outside Node and the shipped Pyodide files.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer, isUtf8 } from "node:buffer"; // captured: the global is deleted before guest code runs
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const proc = process; // captured: the global is deleted before guest code runs
const send = proc.send.bind(proc);
const cfg = JSON.parse(proc.argv[2] ?? "{}");
const SHIP = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(SHIP, "vendor", "pyodide");
const WORKSPACE = "/workspace";
const MAX_OUT_FILES = cfg.maxOutFiles ?? 20;
const MAX_OUT_FILE_BYTES = cfg.maxOutFileBytes ?? 2 * 1024 * 1024;
const MAX_WORKSPACE_FILES = cfg.maxWorkspaceFiles ?? 500;
const MAX_WORKSPACE_BYTES = cfg.maxWorkspaceBytes ?? 64 * 1024 * 1024;
const STREAM_CAP_CHARS = cfg.streamCapChars ?? 1_000_000;
const ERROR_CAP_CHARS = 16_000;
const t0 = performance.now();

// (a) emscripten NODEFS init calls process.binding('constants'), which --permission denies. Provide the public equivalent.
const origBinding = proc.binding;
proc.binding = (name) => (name === "constants" ? { fs: fs.constants, os: os.constants } : origBinding.call(proc, name));

// (b) hard cap on wasm linear memory. Pyodide defines its own memory inside the module (not imported), so wrap grow():
// emscripten_resize_heap catches the throw and returns 0 -> malloc fails -> MemoryError.
const CAP_PAGES = Math.floor(((cfg.wasmMaxMb ?? 512) * 1048576) / 65536);
const origGrow = WebAssembly.Memory.prototype.grow;
WebAssembly.Memory.prototype.grow = function (delta) {
  if (this.buffer.byteLength / 65536 + delta > CAP_PAGES) throw new RangeError("wasm memory cap reached");
  return origGrow.call(this, delta);
};

// (b2) offline proof (test hook): poison every JS-level network entry point BEFORE boot and count attempts.
const netAttempts = [];
if (cfg.poison) {
  const boom =
    (what) =>
    (...a) => {
      netAttempts.push(`${what} ${String(a[0]?.href ?? a[0]?.url ?? a[0] ?? "").slice(0, 120)}`);
      throw new Error(`NETWORK BLOCKED: ${what}`);
    };
  globalThis.fetch = boom("fetch");
  const net = await import("node:net");
  const http = await import("node:http");
  const https = await import("node:https");
  const dns = await import("node:dns");
  net.default.Socket.prototype.connect = boom("net.Socket.connect");
  net.default.connect = boom("net.connect");
  http.default.request = boom("http.request");
  https.default.request = boom("https.request");
  dns.default.lookup = boom("dns.lookup");
}

// (c) integrity: every shipped Pyodide file must match the pinned manifest
const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR, "MANIFEST.json"), "utf8"));
for (const f of manifest.files) {
  const h = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(VENDOR, f.name)))
    .digest("hex");
  if (h !== f.sha256) {
    send({ type: "fatal", error: `sha256 mismatch: ${f.name}` });
    proc.exit(2);
  }
}
const tVerified = performance.now();

// Guest output. Two streams, each capped; the parent cuts them again for the model.
let outParts = [];
let errParts = [];
let outChars = 0;
let errChars = 0;
// Pyodide hands the sinks whole lines; text after the last newline waits in a buffer. To keep one run's
// unfinished line out of the next run's output, every job ends by writing this marker plus a newline to
// both streams. A line carrying it is cut back to what the guest wrote, and a bare marker is dropped.
const FLUSH_MARK = `\u0001flush-${crypto.randomUUID()}`;
const sink = (isErr) => (line) => {
  let text = String(line);
  if (text.endsWith(FLUSH_MARK)) {
    text = text.slice(0, -FLUSH_MARK.length);
    if (text === "") return;
  }
  const room = STREAM_CAP_CHARS - (isErr ? errChars : outChars);
  if (room <= 0) return;
  text = text.slice(0, room);
  if (isErr) {
    errParts.push(text);
    errChars += text.length + 1;
  } else {
    outParts.push(text);
    outChars += text.length + 1;
  }
};

// (d) boot offline with a lock trimmed to what we ship, so an unknown package can never trigger a CDN lookup
const full = JSON.parse(fs.readFileSync(path.join(VENDOR, "pyodide-lock.json"), "utf8"));
const keep = new Set(manifest.files.map((f) => f.name));
const lock = {
  info: full.info,
  packages: Object.fromEntries(Object.entries(full.packages).filter(([, v]) => keep.has(v.file_name))),
};
const { loadPyodide } = await import(pathToFileURL(path.join(VENDOR, "pyodide.mjs")).href);
const py = await loadPyodide({
  indexURL: VENDOR + path.sep,
  packageCacheDir: VENDOR,
  lockFileContents: lock,
  jsglobals: {},
  fullStdLib: false,
  env: { HOME: "/home/pyodide" },
  stdin: () => undefined, // input() gets EOF at once instead of waiting on a descriptor that does not exist
  stdout: sink(false),
  stderr: sink(true),
});
const tCore = performance.now();
await py.loadPackage(cfg.packages ?? ["numpy", "pandas"], { messageCallback: () => {}, errorCallback: () => {} });
const tPkgs = performance.now();
if (cfg.pyc !== false && fs.existsSync(path.join(VENDOR, "pyc-cache.json.gz"))) {
  const pycs = JSON.parse(gunzipSync(fs.readFileSync(path.join(VENDOR, "pyc-cache.json.gz"))).toString());
  for (const [p, b64] of Object.entries(pycs)) {
    py.FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
    py.FS.writeFile(p, Buffer.from(b64, "base64"));
  }
}
const tPyc = performance.now();
if (cfg.preimport) {
  await py.runPythonAsync(cfg.preimport);
}
const tPre = performance.now();
py.FS.mkdirTree(WORKSPACE);

// Pyodide turns an uncaught SystemExit into the exit of this whole process, which would cost the next run a
// cold start for what is an ordinary way to end a script (sys.exit(1) after printing an error). The guest runs
// through this harness instead, which catches SystemExit and reports it as data. os._exit is routed to the same
// path. The harness lives in its own namespace, away from the guest globals.
const harnessNs = py.globals.get("dict")();
py.runPython(
  [
    "import os, sys",
    "from pyodide.code import eval_code_async",
    "def _exit(code=0):",
    "    raise SystemExit(code)",
    "os._exit = _exit",
    "async def run(code, ns):",
    "    try:",
    "        return await eval_code_async(code, ns), 0",
    "    except SystemExit as e:",
    "        code = e.code",
    "        if code is None:",
    "            return None, 0",
    "        if isinstance(code, int):",
    "            return None, code",
    "        print(code, file=sys.stderr)",
    "        return None, 1",
  ].join("\n"),
  { globals: harnessNs },
);
const runGuest = harnessNs.get("run");

// (e) strip network / process primitives from the realm before any guest code runs
const deleted = [];
for (const k of [
  "process",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "require",
  "Buffer",
  "Worker",
  "navigator",
  "BroadcastChannel",
]) {
  try {
    if (k in globalThis) {
      delete globalThis[k];
      if (!(k in globalThis)) deleted.push(k);
    }
  } catch {}
}
send({
  type: "ready",
  netAttempts: cfg.poison ? netAttempts.slice() : undefined,
  timings: {
    verifyMs: +(tVerified - t0).toFixed(0),
    loadPyodideMs: +(tCore - tVerified).toFixed(0),
    loadPackagesMs: +(tPkgs - tCore).toFixed(0),
    pycInjectMs: +(tPyc - tPkgs).toFixed(0),
    preimportMs: +(tPre - tPyc).toFixed(0),
    totalMs: +(tPre - t0).toFixed(0),
  },
  deleted,
  capPages: CAP_PAGES,
});

// (f) the job loop
const isDir = (mode) => py.FS.isDir(mode);

/** Removes everything inside `dir` without following links. The directory itself stays. */
function emptyDir(dir) {
  let names = [];
  try {
    names = py.FS.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const p = `${dir}/${name}`;
    try {
      const st = py.FS.lstat(p);
      if (isDir(st.mode) && !py.FS.isLink(st.mode)) {
        emptyDir(p);
        py.FS.rmdir(p);
      } else {
        py.FS.unlink(p);
      }
    } catch {}
  }
}

/** `/workspace` listing without reading any file: [{ rel, size }]. Links are listed, never followed. */
function listWorkspace() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of py.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const p = `${dir}/${name}`;
      const st = py.FS.lstat(p);
      if (py.FS.isLink(st.mode)) continue;
      if (isDir(st.mode)) walk(p, `${prefix}${name}/`);
      else if (py.FS.isFile(st.mode)) out.push({ rel: `${prefix}${name}`, size: st.size });
      if (out.length > MAX_WORKSPACE_FILES) return;
    }
  };
  walk(WORKSPACE, "");
  return out;
}

/** An input name from the parent is a relative POSIX path; refuse anything that could climb out of /workspace. */
function safeRelative(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\u0000") &&
    !name.split("/").some((part) => part === "" || part === "..")
  );
}

function formatValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && typeof value.toString === "function") {
    const text = value.toString();
    if (typeof value.destroy === "function") {
      try {
        value.destroy();
      } catch {}
    }
    return String(text).slice(0, 100_000);
  }
  return String(value).slice(0, 100_000);
}

/** Collects what the run left under /workspace/out: new or changed text candidates, within the limits. */
function collectOutputs(inputs) {
  const listing = listWorkspace();
  const total = listing.reduce((sum, f) => sum + f.size, 0);
  if (listing.length > MAX_WORKSPACE_FILES || total > MAX_WORKSPACE_BYTES) {
    return { files: {}, skipped: [], tooLarge: true };
  }
  const files = {};
  const skipped = [];
  const candidates = listing.filter((f) => f.rel.startsWith("out/")).sort((a, b) => (a.rel < b.rel ? -1 : 1));
  for (const f of candidates) {
    if (f.size > MAX_OUT_FILE_BYTES) {
      skipped.push({ name: f.rel, why: "too_large" });
      continue;
    }
    const bytes = py.FS.readFile(`${WORKSPACE}/${f.rel}`);
    const before = inputs.get(f.rel);
    if (before && Buffer.from(bytes).equals(before)) continue; // an input the run did not change
    if (!isUtf8(bytes) || bytes.includes(0)) {
      skipped.push({ name: f.rel, why: "binary" }); // the desk keeps text only; it does not count toward the file limit
      continue;
    }
    if (Object.keys(files).length >= MAX_OUT_FILES) {
      skipped.push({ name: f.rel, why: "too_many" });
      continue;
    }
    files[f.rel] = bytes;
  }
  return { files, skipped, tooLarge: false };
}

proc.on("message", async (job) => {
  if (job?.type !== "job") return;
  outParts = [];
  errParts = [];
  outChars = 0;
  errChars = 0;
  emptyDir(WORKSPACE);
  emptyDir("/tmp");
  const inputs = new Map();
  let inputError = null;
  try {
    for (const [name, text] of Object.entries(job.files ?? {})) {
      if (!safeRelative(name)) {
        inputError = "an input file name is not a plain relative path";
        break;
      }
      const bytes = Buffer.from(String(text), "utf8");
      const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
      if (dir) py.FS.mkdirTree(`${WORKSPACE}/${dir}`);
      py.FS.writeFile(`${WORKSPACE}/${name}`, bytes);
      inputs.set(name, bytes);
    }
  } catch {
    inputError = "the input files could not be placed in /workspace (two names may clash)";
  }
  let error = null;
  let errorName = null;
  let value = null;
  const started = performance.now();
  if (inputError) {
    error = inputError;
  } else {
    try {
      py.FS.chdir(WORKSPACE);
    } catch {}
    let ns = null;
    try {
      ns = py.globals.get("dict")(); // fresh globals for every job: variables never leak into the next run
      ns.set("__name__", "__main__");
      const outcome = await runGuest(String(job.code ?? ""), ns);
      const [guestValue, exitCode] = outcome.toJs({ depth: 1 });
      outcome.destroy();
      value = formatValue(guestValue);
      if (exitCode) {
        error = `SystemExit: ${exitCode}`;
        errorName = "SystemExit";
      }
    } catch (e) {
      error = String(e?.message || e).slice(-ERROR_CAP_CHARS);
      errorName = String((e && (e.type || e.name)) || "Error");
    } finally {
      try {
        ns?.destroy();
      } catch {}
    }
    try {
      const mark = JSON.stringify(FLUSH_MARK);
      py.runPython(
        `import sys\nfor _s in (sys.__stdout__, sys.__stderr__):\n    try:\n        _s.write(${mark} + "\\n")\n        _s.flush()\n    except Exception:\n        pass`,
      );
    } catch {}
  }
  const ran = performance.now() - started;
  let outputs = { files: {}, skipped: [], tooLarge: false };
  try {
    outputs = collectOutputs(inputs);
  } catch {
    outputs = { files: {}, skipped: [], tooLarge: true };
  }
  const mu = proc.memoryUsage ? proc.memoryUsage() : {};
  send({
    type: "result",
    id: job.id,
    error,
    errorName,
    value,
    stdout: outParts.join("\n"),
    stderr: errParts.join("\n"),
    files: outputs.files,
    skipped: outputs.skipped,
    tooLarge: outputs.tooLarge,
    discard: false,
    runMs: +ran.toFixed(0),
    mem: {
      rssMB: +(mu.rss / 1048576).toFixed(0),
      heapUsedMB: +(mu.heapUsed / 1048576).toFixed(0),
      wasmHeapMB: +(py._module.HEAPU8.length / 1048576).toFixed(0),
    },
  });
});
