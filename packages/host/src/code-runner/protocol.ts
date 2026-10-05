/**
 * The IPC protocol between the host and one sandbox child (`child/py-child.mjs`, `child/qjs-child.mjs`).
 *
 * Messages travel over the `fork` channel with `serialization: "advanced"`, so a `Uint8Array` crosses
 * as bytes. The child runs guest code, so everything it sends is untrusted data: `parseChildMessage`
 * checks the shape and drops anything else rather than casting.
 *
 *   host -> child   argv[2]  JSON `ChildBootConfig`
 *   child -> host   { type: "ready", timings }                     boot finished, jobs are accepted
 *                   { type: "fatal", error }                        boot failed (integrity), the process exits
 *   host -> child   { type: "job", id, code, files, ...limits }     files: relative path -> UTF-8 text
 *   child -> host   { type: "result", id, ... }                     see `ChildResult`
 *
 * A child answers one job at a time. The host never sends a second job before the result of the first.
 */

export type ChildBootConfig = {
  /** Linear-memory cap of the wasm instance. */
  readonly wasmMaxMb: number;
  /** Pyodide only: packages loaded at boot, and the statement run once to warm the import cache. */
  readonly packages?: readonly string[];
  readonly preimport?: string;
  /** Test hook: poison the JS network entry points before boot and report the attempts. */
  readonly poison?: boolean;
  readonly maxOutFiles: number;
  readonly maxOutFileBytes: number;
  readonly maxWorkspaceFiles: number;
  readonly maxWorkspaceBytes: number;
  readonly streamCapChars: number;
};

export type ChildJob = {
  readonly type: "job";
  readonly id: string;
  readonly code: string;
  readonly files: Readonly<Record<string, string>>;
  /** QuickJS only: the loop deadline, the stack and heap it gives the script. */
  readonly deadlineMs?: number;
  readonly stackKb?: number;
  readonly heapLimitBytes?: number;
};

export type SkippedOutput = { readonly name: string; readonly why: string };

export type ChildResult = {
  readonly type: "result";
  readonly id: string;
  /** The guest's exception text (a Python traceback, a JS error with its stack), or null. */
  readonly error: string | null;
  /** Python exception type or JS error name, when known. */
  readonly errorName: string | null;
  /** QuickJS: why the interrupt handler stopped the script ("deadline" or "wasm-memory"). */
  readonly why: string | null;
  /** The value of the last expression, already formatted, or null. */
  readonly value: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** New or changed files under out/, keyed by path relative to /workspace (so "out/summary.csv"). */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly skipped: readonly SkippedOutput[];
  /** The run left more in /workspace than the limits allow; no files are returned. */
  readonly tooLarge: boolean;
  /** The child says it must not be reused (QuickJS after a limit hit). */
  readonly discard: boolean;
  readonly runMs: number;
};

export type ChildReady = { readonly type: "ready"; readonly timings?: Readonly<Record<string, number>> };
export type ChildFatal = { readonly type: "fatal"; readonly error: string };
export type ChildMessage = ChildReady | ChildFatal | ChildResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseFiles(value: unknown): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  if (!isRecord(value)) {
    return files;
  }
  for (const [name, bytes] of Object.entries(value)) {
    if (bytes instanceof Uint8Array) {
      files[name] = bytes;
    }
  }
  return files;
}

function parseSkipped(value: unknown): SkippedOutput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const skipped: SkippedOutput[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.name === "string" && typeof entry.why === "string") {
      skipped.push({ name: entry.name, why: entry.why });
    }
  }
  return skipped;
}

function parseResult(raw: Record<string, unknown>): ChildResult | null {
  if (typeof raw.id !== "string") {
    return null;
  }
  return {
    type: "result",
    id: raw.id,
    error: stringOrNull(raw.error),
    errorName: stringOrNull(raw.errorName),
    why: stringOrNull(raw.why),
    value: stringOrNull(raw.value),
    stdout: stringOrNull(raw.stdout) ?? "",
    stderr: stringOrNull(raw.stderr) ?? "",
    files: parseFiles(raw.files),
    skipped: parseSkipped(raw.skipped),
    tooLarge: raw.tooLarge === true,
    discard: raw.discard === true,
    runMs: typeof raw.runMs === "number" ? raw.runMs : 0,
  };
}

/** A message the child sent, or null when it is not one of the three shapes above. */
export function parseChildMessage(raw: unknown): ChildMessage | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.type === "ready") {
    return { type: "ready" };
  }
  if (raw.type === "fatal") {
    return { type: "fatal", error: stringOrNull(raw.error) ?? "unknown" };
  }
  if (raw.type === "result") {
    return parseResult(raw);
  }
  return null;
}
