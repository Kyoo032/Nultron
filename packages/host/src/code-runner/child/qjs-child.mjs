// Sandboxed QuickJS child process for `run_code` (JavaScript). Ported from the 2026-10-03 prototype; the
// protocol is documented in ../protocol.ts. Started by ../child-process.ts with the same hardening as
// py-child.mjs:
//   <node or Electron-as-node> --permission --allow-fs-read=<shipDir> --disallow-code-generation-from-strings
//     --max-old-space-size=<MB> qjs-child.mjs <json-config>
//
// Guest contract (also written into the tool description):
//   files       object: desk path -> text, for every file named in `files`
//   outFiles    object: name -> text. Whatever is set here is saved to the desk under out/<name>
//   console.log / info / debug -> stdout, console.error / warn -> stderr
//   the value of the last expression is shown after the output
//
// Each job gets a fresh QuickJS runtime and context. A run that hit a limit (out of memory, stack
// overflow, the interrupt deadline) leaves QuickJS in a state its dispose asserts on, so such a run is
// reported with `discard: true` and the parent kills this process instead of reusing it.
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { Buffer } from "node:buffer";

const proc = process;
const send = proc.send.bind(proc);
const cfg = JSON.parse(proc.argv[2] ?? "{}");
const WASM_MAX_MB = cfg.wasmMaxMb ?? 256;
const MAX_OUT_FILES = cfg.maxOutFiles ?? 20;
const MAX_OUT_FILE_BYTES = cfg.maxOutFileBytes ?? 2 * 1024 * 1024;
const MAX_WORKSPACE_FILES = cfg.maxWorkspaceFiles ?? 500;
const MAX_WORKSPACE_BYTES = cfg.maxWorkspaceBytes ?? 64 * 1024 * 1024;
const STREAM_CAP_CHARS = cfg.streamCapChars ?? 1_000_000;
const LINE_CAP_CHARS = 100_000;
const DISCARD_WASM_BYTES = 64 * 1024 * 1024;

const t0 = performance.now();
const mod = await newQuickJSWASMModuleFromVariant(
  newVariant(releaseSync, {
    wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: (WASM_MAX_MB * 1048576) / 65536 }),
  }),
);
send({ type: "ready", timings: { totalMs: +(performance.now() - t0).toFixed(0) } });

/** A guest output name becomes the part after `out/`: `/workspace/out/x`, `out/x` and `x` all mean out/x. */
function outName(raw) {
  let name = String(raw);
  if (name.startsWith("/workspace/")) name = name.slice("/workspace/".length);
  if (name.startsWith("out/")) name = name.slice("out/".length);
  return name;
}

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

function runJob(job) {
  const deadlineMs = job.deadlineMs ?? 25_000;
  const stackKb = job.stackKb ?? 256;
  const heapLimitBytes = job.heapLimitBytes ?? 128 * 1024 * 1024;
  const wasmCapBytes = job.wasmCapBytes ?? (WASM_MAX_MB - 16) * 1024 * 1024;
  const started = performance.now();

  const out = [];
  const err = [];
  let outChars = 0;
  let errChars = 0;
  let why = null;
  let discard = false;

  const rt = mod.newRuntime();
  rt.setMemoryLimit(heapLimitBytes);
  rt.setMaxStackSize(stackKb * 1024);
  const deadline = Date.now() + deadlineMs;
  const wasmMem = mod.getWasmMemory();
  rt.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      why = "deadline";
      return true;
    }
    if (wasmMem.buffer.byteLength > wasmCapBytes) {
      why = "wasm-memory";
      return true;
    }
    return false;
  });
  const vm = rt.newContext();

  const consoleObj = vm.newObject();
  const logTo = (isErr) =>
    vm.newFunction(isErr ? "error" : "log", (...args) => {
      const room = STREAM_CAP_CHARS - (isErr ? errChars : outChars);
      if (room <= 0) return;
      const line = args
        .map((a) => {
          const v = vm.dump(a);
          return typeof v === "string" ? v : JSON.stringify(v);
        })
        .join(" ")
        .slice(0, Math.min(room, LINE_CAP_CHARS));
      if (isErr) {
        err.push(line);
        errChars += line.length + 1;
      } else {
        out.push(line);
        outChars += line.length + 1;
      }
    });
  const logFn = logTo(false);
  const errFn = logTo(true);
  for (const name of ["log", "info", "debug"]) vm.setProp(consoleObj, name, logFn);
  for (const name of ["error", "warn"]) vm.setProp(consoleObj, name, errFn);
  vm.setProp(vm.global, "console", consoleObj);
  consoleObj.dispose();
  logFn.dispose();
  errFn.dispose();

  const filesObj = vm.newObject();
  for (const [name, text] of Object.entries(job.files ?? {})) {
    const h = vm.newString(String(text));
    vm.setProp(filesObj, name, h);
    h.dispose();
  }
  vm.setProp(vm.global, "files", filesObj);
  filesObj.dispose();
  const outObj = vm.newObject();
  vm.setProp(vm.global, "outFiles", outObj);
  outObj.dispose();

  let error = null;
  let errorName = null;
  let value = null;
  const r = vm.evalCode(String(job.code ?? ""), "<exec>");
  if (r.error) {
    const e = vm.dump(r.error);
    errorName = String(e?.name ?? "Error");
    error = (typeof e === "string" ? e : `${e?.name ?? "Error"}: ${e?.message ?? ""}\n${e?.stack ?? ""}`).slice(
      -16_000,
    );
    r.error.dispose();
  } else {
    const jobs = rt.executePendingJobs(10_000);
    if (jobs.error) {
      const e = vm.dump(jobs.error);
      errorName = String(e?.name ?? "Error");
      error = `${e?.name ?? "Error"}: ${e?.message ?? ""}\n${e?.stack ?? ""}`.slice(-16_000);
      jobs.error.dispose();
    }
    const v = vm.dump(r.value);
    r.value.dispose();
    if (v !== undefined && v !== null) {
      value = (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 100_000);
    }
  }
  if (why || (error && /out of memory|stack overflow|interrupted/i.test(error))) discard = true;

  // Outputs: list names and sizes inside the guest first, then pull only what the limits allow.
  const files = {};
  const skipped = [];
  let tooLarge = false;
  if (!why) {
    const listing = vm.evalCode(
      `(() => { const o = globalThis.outFiles; if (o === null || typeof o !== "object") return "[]"; return JSON.stringify(Object.keys(o).map((n) => [n, typeof o[n] === "string" ? o[n].length : -1])); })()`,
    );
    if (listing.error) {
      listing.error.dispose();
    } else {
      const entries = JSON.parse(vm.dump(listing.value));
      listing.value.dispose();
      let totalChars = 0;
      for (const [, len] of entries) totalChars += Math.max(len, 0);
      if (entries.length > MAX_WORKSPACE_FILES || totalChars > MAX_WORKSPACE_BYTES) {
        tooLarge = true;
      } else {
        for (const [rawName, len] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          const name = outName(rawName);
          if (!safeRelative(name)) {
            skipped.push({ name: String(rawName).slice(0, 120), why: "bad_name" });
          } else if (len < 0) {
            skipped.push({ name: `out/${name}`, why: "not_text" });
          } else if (len > MAX_OUT_FILE_BYTES) {
            skipped.push({ name: `out/${name}`, why: "too_large" });
          } else if (Object.keys(files).length >= MAX_OUT_FILES) {
            skipped.push({ name: `out/${name}`, why: "too_many" });
          } else {
            const got = vm.evalCode(`globalThis.outFiles[${JSON.stringify(rawName)}]`);
            if (got.error) {
              got.error.dispose();
            } else {
              const text = vm.dump(got.value);
              got.value.dispose();
              const bytes = Buffer.from(String(text), "utf8");
              if (bytes.length > MAX_OUT_FILE_BYTES) skipped.push({ name: `out/${name}`, why: "too_large" });
              else if (bytes.includes(0)) skipped.push({ name: `out/${name}`, why: "binary" });
              else files[`out/${name}`] = bytes;
            }
          }
        }
      }
    }
  }

  const wasmBytes = wasmMem.buffer.byteLength;
  if (wasmBytes > DISCARD_WASM_BYTES) discard = true;
  if (!discard) {
    try {
      vm.dispose();
      rt.dispose();
    } catch {
      discard = true; // QuickJS asserted on teardown; the instance is no longer trustworthy
    }
  }
  const ran = performance.now() - started;
  return {
    error: error ?? (why === "deadline" ? "InternalError: interrupted" : null),
    errorName: errorName ?? (why ? "InternalError" : null),
    why,
    value,
    stdout: out.join("\n"),
    stderr: err.join("\n"),
    files,
    skipped,
    tooLarge,
    discard,
    runMs: +ran.toFixed(0),
    mem: { wasmBytes },
  };
}

proc.on("message", (job) => {
  if (job?.type !== "job") return;
  let result;
  try {
    result = runJob(job);
  } catch (e) {
    result = {
      error: `InternalError: ${String(e?.message || e).slice(0, 500)}`,
      errorName: "InternalError",
      why: null,
      value: null,
      stdout: "",
      stderr: "",
      files: {},
      skipped: [],
      tooLarge: false,
      discard: true,
      runMs: 0,
      mem: {},
    };
  }
  send({ type: "result", id: job.id, ...result });
});
