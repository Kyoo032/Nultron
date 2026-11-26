/**
 * The file → Markdown child entry (F7a, DFIND-177).
 *
 * An untrusted document is parsed HERE, in a process the host can kill, never in the host process
 * itself: a napi conversion that ignores its deadline, a zip bomb that eats memory, or a crash in a
 * native parser now costs one disposable child instead of stalling every tenant on the box. The
 * parent (`child-parse.ts`) spawns this file under `--permission` (fs read on the repository for
 * module loading only, no write, no child process) plus `--max-old-space-size`, sends the bytes over
 * IPC, and SIGKILLs the process at the deadline.
 *
 * THE NETWORK STAYS SHUT. The permission model does not cover sockets, so the first thing this
 * process does — before any module it may not fully control is evaluated — is disable every egress
 * primitive a document parser could reach: `net`/`tls`/`http`/`https`/`http2`/`dgram`/`dns`,
 * `fetch` and `WebSocket`. Builtins are patched through `createRequire` (their exports are the same
 * mutable objects every later `require` or `import` of them receives). The `network` probe job lets
 * `child-parse.test.ts` prove the seal from outside.
 *
 * Protocol (advanced serialization, one job per child):
 *   in : {type:"job", id, filename, timeoutMs, bytes:Uint8Array}
 *      | {type:"probe", id, probe:"sleep"|"allocate"|"network", ms?, mb?}   (tests only)
 *   out: {type:"ready"}                       sent once, after the egress seal
 *      | {type:"result", id, ok:true, file} | {type:"result", id, ok:false, code, apiCode?, status?}
 *      | {type:"probe_result", id, ok, detail?}
 *      | {type:"fatal", error}
 */
import { createRequire } from "node:module";

const BLOCKED = "network is not permitted in the parse worker";

function block(): never {
  throw new Error(BLOCKED);
}

/**
 * Rebind the egress functions of one builtin module. `require` on a builtin returns the shared
 * exports object, so assigning on it rebinds the same object an `import` later resolves to.
 */
function sealModule(require: NodeRequire, name: string, keys: readonly string[]): void {
  try {
    const mod = require(name) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof mod[key] === "function") {
        mod[key] = block;
      }
    }
    const socket = mod.Socket as { prototype?: Record<string, unknown> } | undefined;
    if (socket?.prototype && typeof socket.prototype.connect === "function") {
      socket.prototype.connect = block;
    }
  } catch {
    // A builtin that cannot be patched stays unpatched only if it does not exist; nothing to do.
  }
}

/** Every way out of the process, closed before any converter or parser is loaded. */
function sealNetwork(): void {
  const require = createRequire(import.meta.url);
  sealModule(require, "node:net", ["connect", "connectSync", "createConnection", "createServer"]);
  sealModule(require, "node:tls", ["connect", "createServer", "createSecureServer"]);
  sealModule(require, "node:http", ["request", "get", "createServer"]);
  sealModule(require, "node:https", ["request", "get", "createServer"]);
  sealModule(require, "node:http2", ["connect", "createServer", "createSecureServer"]);
  sealModule(require, "node:dgram", ["createSocket", "bind", "send"]);
  sealModule(require, "node:dns", [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCname",
    "resolveMx",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ]);
  globalThis.fetch = () => Promise.reject(new Error(BLOCKED));
  // @ts-expect-error -- WebSocket is not in the TS DOM lib for this package.
  globalThis.WebSocket = class {
    constructor() {
      throw new Error(BLOCKED);
    }
  };
}

type JobMessage = {
  readonly type: "job";
  readonly id: string;
  readonly filename: string;
  readonly timeoutMs: number;
  readonly bytes: Uint8Array;
};

type ProbeMessage = {
  readonly type: "probe";
  readonly id: string;
  readonly probe: "sleep" | "allocate" | "network";
  readonly ms?: number;
  readonly mb?: number;
};

type Inbound = JobMessage | ProbeMessage;

function post(message: unknown): void {
  process.send?.(message);
}

/** Error the parent can map back onto `FileExtractError` without a stack ever crossing. */
function errorBody(error: unknown): { readonly code: string; readonly apiCode?: string; readonly status?: number } {
  const shaped = error as { code?: unknown; statusCode?: unknown; localeKey?: unknown; name?: unknown } | null;
  if (shaped && shaped.name === "FileExtractError" && typeof shaped.code === "string") {
    return { code: shaped.code };
  }
  if (shaped && typeof shaped.code === "string" && typeof shaped.statusCode === "number") {
    // An ApiError (e.g. the gate's too_many_jobs) keeps both halves of its shape.
    return { code: shaped.code, apiCode: shaped.code, status: shaped.statusCode };
  }
  return { code: "malformed" };
}

async function runJob(message: JobMessage): Promise<void> {
  // Lazy: the seal above is in place before ANY of the pipeline's modules (anydoc binding included)
  // is evaluated in this process.
  const { extractFileInProcess } = await import("./index");
  try {
    const file = await extractFileInProcess(
      { bytes: message.bytes, filename: message.filename },
      { timeoutMs: message.timeoutMs },
    );
    post({ type: "result", id: message.id, ok: true, file });
  } catch (error) {
    post({ type: "result", id: message.id, ok: false, ...errorBody(error) });
  }
}

const held: unknown[] = [];

async function runProbe(message: ProbeMessage): Promise<void> {
  if (message.probe === "sleep") {
    // Never settles inside the job: the parent's deadline is what ends it. Kept so the suite can
    // prove a conversion that ignores its deadline is killed, not merely raced.
    await new Promise<void>(() => undefined);
    return;
  }
  if (message.probe === "allocate") {
    // Grow the JS heap past the child's --max-old-space-size until the runtime kills us. Arrays, not
    // typed arrays (their backing store is off-heap) and not repeated strings (V8 shares them lazily).
    const mb = Math.max(1, Math.floor(message.mb ?? 512));
    for (let index = 0; index < mb; index += 1) {
      held.push(new Array(1_000_000).fill(index));
    }
    post({ type: "probe_result", id: message.id, ok: true, detail: "allocated" });
    return;
  }
  // "network": every egress primitive must refuse.
  const results: string[] = [];
  const attempts: Array<() => Promise<unknown>> = [
    async () => (await import("node:net")).createConnection({ host: "169.254.169.254", port: 80 }),
    async () => (await import("node:http")).request({ host: "169.254.169.254", path: "/" }),
    async () => (await import("node:dns")).lookup("metadata.google.internal", () => undefined),
    async () => globalThis.fetch("http://169.254.169.254/"),
  ];
  for (const attempt of attempts) {
    try {
      const outcome = await attempt();
      if (outcome && typeof (outcome as { destroy?: unknown }).destroy === "function") {
        (outcome as { destroy: () => void }).destroy();
      }
      // `dns.lookup` with a callback returns nothing; check the request objects above instead.
      results.push("open");
    } catch {
      results.push("blocked");
    }
  }
  const allBlocked = results.every((result) => result === "blocked");
  post({
    type: "probe_result",
    id: message.id,
    ok: allBlocked,
    detail: allBlocked ? "all egress blocked" : `egress open: ${results.join(",")}`,
  });
}

process.on("message", (raw: unknown) => {
  const message = raw as Inbound | null;
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.type === "job") {
    void runJob(message).catch((error) => {
      post({ type: "result", id: message.id, ok: false, code: "malformed", detail: String(error) });
    });
    return;
  }
  if (message.type === "probe") {
    void runProbe(message).catch((error) => {
      post({ type: "probe_result", id: message.id, ok: false, detail: String(error).slice(0, 200) });
    });
  }
});

sealNetwork();
post({ type: "ready" });
