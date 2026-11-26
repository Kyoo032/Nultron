/**
 * Spawning and supervising the file → Markdown child (F7a, DFIND-177).
 *
 * Every conversion `extractFile` runs happens in a process the host can kill, spawned once per job
 * with the same posture the code sandbox has (`code-runner/child-process.ts`): `--permission` with
 * an fs read grant (the repository, for module loading — the document's bytes arrive over IPC, so no
 * document path needs a grant), no fs write anywhere, no child-process permission, and an old-space
 * cap from `AGENTFORGE_PARSE_CHILD_MAX_MB`. Two extra grants are structural, not optional:
 * `--allow-addons` because the anydoc binding is a `.node` file, and `--allow-worker` because the
 * TypeScript loader (esbuild inside tsx) compiles on a worker thread. The entry point
 * (`parse-worker.ts`) disables every network primitive itself before it loads the pipeline, since
 * the permission model does not reach sockets.
 *
 * The child gets an EMPTY environment — never the parent's, which on the hosted server holds
 * `AGENTFORGE_SECRETS_KEY` and every tenant's keys — plus `TSX_DISABLE_CACHE` so the loader's cache
 * cannot demand the fs write grant the child does not have.
 *
 * A job that passes its wall-clock deadline is SIGKILLed: unlike the old in-process deadline, which
 * could only race a timer against the napi promise, this actually stops the native work.
 */
import { type ChildProcess, fork, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "@agentforge/core";
import { trackChild } from "../child-processes";
import { componentsRootDir } from "../components/paths";
import { FileExtractError, type FileExtractErrorCode } from "./errors";
import type { ExtractedFile } from "./index";

/** Env: the child's JS heap cap, MiB. Old space bounds the glue; a converter's native memory is bounded by the kill switch and the container. */
export const PARSE_CHILD_MAX_MB_ENV = "AGENTFORGE_PARSE_CHILD_MAX_MB";
/** Default heap cap for one parse child. Room for tsx + esbuild + a 25 MB document's Markdown. */
export const DEFAULT_PARSE_CHILD_MAX_MB = 384;

/** Boot and a graceful answer each get this long before SIGKILL. */
const BOOT_TIMEOUT_MS = 15_000;
const EXIT_DRAIN_MS = 2_000;

/** Thrown only when no child can be spawned at all; the caller then degrades in-process (logged). */
export class ParseChildUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ParseChildUnavailableError";
  }
}

export type ParseJob = {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly timeoutMs: number;
};

type ResultMessage =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: string; readonly ok: true; readonly file: ExtractedFile }
  | {
      readonly type: "result";
      readonly id: string;
      readonly ok: false;
      readonly code?: string;
      readonly apiCode?: string;
      readonly status?: number;
    }
  | { readonly type: "probe_result"; readonly id: string; readonly ok: boolean; readonly detail?: string }
  | { readonly type: "fatal"; readonly error?: string };

/** The directory containing this module, in tsx (ESM) and in the esbuild CJS bundle alike. */
function moduleDirectory(): string | null {
  try {
    const url = import.meta.url;
    if (typeof url === "string" && url.startsWith("file:")) {
      return dirname(fileURLToPath(url));
    }
  } catch {
    // Inside host.cjs `import.meta` is empty; fall through.
  }
  return typeof __dirname === "string" ? __dirname : null;
}

/**
 * The repository root: `packages/host/src/file-extract` up four. Everything the child reads (its own
 * entry, the tsx loader, the workspace sources, the anydoc binding) lives under it.
 */
export function repoRoot(): string | null {
  const dir = moduleDirectory();
  return dir ? resolve(dir, "..", "..", "..", "..") : null;
}

export function parseWorkerPath(root: string): string {
  return join(root, "packages", "host", "src", "file-extract", "parse-worker.ts");
}

/**
 * The tsx loader's ESM entry as a `file://` specifier for `--import`. Resolved against `apps/web`,
 * which is the workspace that depends on tsx and whose `start` script runs it.
 */
export function resolveTsxEsmImport(root: string): string {
  const anchor = join(root, "apps", "web", "package.json");
  const resolved = createRequire(anchor).resolve("tsx/esm");
  return resolved.startsWith("file:") ? resolved : `file://${resolved}`;
}

/** The argv a child parses under: a permission wall plus the loader that runs the repository's TS. */
export function parseChildExecArgv(root: string, maxOldSpaceMb: number, componentsDir?: string): string[] {
  // The components root is a second read grant: the installed (downloaded) converter lives there,
  // outside the repository, and without this flag PowerPoint uploads fail after setup reports success.
  const reads =
    componentsDir && componentsDir !== root
      ? [`--allow-fs-read=${root}`, `--allow-fs-read=${componentsDir}`]
      : [`--allow-fs-read=${root}`];
  return [
    "--permission",
    ...reads,
    "--allow-addons",
    "--allow-worker",
    `--max-old-space-size=${Math.max(64, Math.floor(maxOldSpaceMb))}`,
    "--import",
    resolveTsxEsmImport(root),
  ];
}

/**
 * Never the parent's env. The loader override is set explicitly, and only the three variables the
 * child needs to find the components root — never a secret or a tenant key — pass through.
 */
export function parseChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {
    TSX_DISABLE_CACHE: "1",
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  for (const key of ["AGENTFORGE_COMPONENTS_DIR", "AGENTFORGE_DATA_DIR", "AGENTFORGE_SERVER"] as const) {
    const value = env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function parseChildMaxMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PARSE_CHILD_MAX_MB_ENV]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PARSE_CHILD_MAX_MB;
}

export type SpawnParseChild = () => ChildProcess;

/** Default spawn: one fresh process per job. Exposed as a seam so tests can inspect the flags. */
export function spawnParseChild(root: string = repoRoot() ?? ""): ChildProcess {
  if (!root) {
    throw new ParseChildUnavailableError("cannot locate the repository root for the parse child");
  }
  const options: ForkOptions & { windowsHide: boolean } = {
    execPath: process.execPath,
    execArgv: parseChildExecArgv(root, parseChildMaxMb(), componentsRootDir()),
    env: parseChildEnv(),
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    cwd: root,
    windowsHide: true,
  };
  const child = fork(parseWorkerPath(root), [], options);
  trackChild(child);
  return child;
}

function failureFrom(message: Extract<ResultMessage, { type: "result" } & { ok: false }>): Error {
  if (message.apiCode && typeof message.status === "number") {
    return new ApiError(message.apiCode, FILE_EXTRACT_COPY_TIMEOUT_OR_BUSY, message.status);
  }
  return new FileExtractError((message.code as FileExtractErrorCode | undefined) ?? "malformed");
}

const FILE_EXTRACT_COPY_TIMEOUT_OR_BUSY = "Too many documents are being read at once. Try again in a moment.";

type Pending = {
  readonly resolve: (file: ExtractedFile) => void;
  readonly reject: (error: Error) => void;
};

/**
 * One supervised child. `send` delivers a job or a test probe; the promise settles on the result,
 * on the deadline (after a SIGKILL), or on the child dying. The process is killed once settled —
 * a child never outlives its job.
 */
export class ParseChild {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null };
  private stderrTail = "";

  constructor(spawn: SpawnParseChild = () => spawnParseChild()) {
    this.child = spawn();
    this.child.stdout?.on("data", () => undefined);
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    this.child.on("message", (raw: unknown) => {
      const message = raw as ResultMessage | null;
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.type === "ready") {
        this.readyResolve?.();
        return;
      }
      if (message.type === "fatal") {
        this.readyReject?.(new ParseChildUnavailableError(String(message.error ?? "worker fatal")));
        this.kill();
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (message.type === "probe_result") {
        entry.resolve({
          format: "csv",
          markdown: "",
          text: "",
          tables: [],
          meta: { truncated: false, bytes: 0, engine: "anydoc" },
        });
        // probe results are read by tests through sendProbe below, not through this map.
        return;
      }
      if (message.ok) {
        entry.resolve(message.file);
      } else {
        entry.reject(failureFrom(message));
      }
    });
    this.child.once("error", (error) => {
      this.failAll(new ParseChildUnavailableError(error.message.slice(0, 200)));
    });
    this.child.once("close", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.readyReject?.(new ParseChildUnavailableError(`parse worker exited ${code ?? signal}`));
      this.failAll(
        code === null || signal === "SIGKILL" || signal === "SIGTERM"
          ? new FileExtractError("resource_limit")
          : new FileExtractError("malformed"),
      );
    });
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** Waits for `ready`. A boot failure (or timeout) rejects, so the caller can degrade. */
  ready(timeoutMs: number = BOOT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new ParseChildUnavailableError("parse worker did not boot in time"));
      }, timeoutMs);
      timer.unref?.();
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  /** True until the process exits. */
  get alive(): boolean {
    return !this.exited && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** SIGKILL, idempotent. */
  kill(): void {
    if (!this.exited) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  /** Sends one parse job; rejects `timeout` at the deadline (the child is then SIGKILLed). */
  parse(job: ParseJob): Promise<ExtractedFile> {
    const id = randomUUID();
    return new Promise<ExtractedFile>((resolve, reject) => {
      const settle = (error: Error | null, file?: ExtractedFile): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) {
          reject(error);
        } else {
          resolve(file as ExtractedFile);
        }
      };
      const timer = setTimeout(
        () => {
          this.kill();
          settle(new FileExtractError("timeout"));
        },
        Math.max(1, job.timeoutMs),
      );
      timer.unref?.();
      this.pending.set(id, { resolve: (file) => settle(null, file), reject: (error) => settle(error) });
      this.child.send(
        { type: "job", id, filename: job.filename, timeoutMs: job.timeoutMs, bytes: job.bytes },
        (error) => {
          if (error) {
            settle(new FileExtractError("malformed"));
          }
        },
      );
    });
  }

  /** Test seam: a probe (sleep / allocate / network) answered with its ok flag. */
  probe(
    body: { probe: "sleep" | "allocate" | "network"; ms?: number; mb?: number },
    timeoutMs: number,
  ): Promise<{ ok: boolean; detail?: string }> {
    const id = randomUUID();
    return new Promise<{ ok: boolean; detail?: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.kill();
          reject(new FileExtractError("timeout"));
        },
        Math.max(1, timeoutMs),
      );
      timer.unref?.();
      const onMessage = (raw: unknown): void => {
        const message = raw as ResultMessage | null;
        if (message?.type === "probe_result" && message.id === id) {
          clearTimeout(timer);
          this.child.off("message", onMessage);
          resolve({ ok: message.ok, detail: message.detail });
        }
      };
      this.child.on("message", onMessage);
      const onClose = (): void => {
        clearTimeout(timer);
        this.child.off("message", onMessage);
        reject(new FileExtractError("resource_limit"));
      };
      this.child.once("close", onClose);
      this.child.send({ type: "probe", id, ...body }, (error) => {
        if (error) {
          clearTimeout(timer);
          reject(new FileExtractError("malformed"));
        }
      });
    });
  }

  /** How the process ended, for assertions and logs. */
  exit(): { code: number | null; signal: string | null } {
    return this.exitInfo;
  }

  get stderr(): string {
    return this.stderrTail;
  }
}

const CHILD_DRAIN = EXIT_DRAIN_MS;

/**
 * Parse one document in a fresh child. Throws {@link ParseChildUnavailableError} only when no child
 * could even start; every parse failure comes back as `FileExtractError` (or the gate's ApiError).
 */
export async function parseFileInChild(job: ParseJob, spawn?: SpawnParseChild): Promise<ExtractedFile> {
  const child = new ParseChild(spawn);
  try {
    await child.ready();
    return await child.parse(job);
  } finally {
    child.kill();
    // A moment for the OS to reap before the promise settles; callers never wait on this.
    setTimeout(() => undefined, CHILD_DRAIN).unref?.();
  }
}
