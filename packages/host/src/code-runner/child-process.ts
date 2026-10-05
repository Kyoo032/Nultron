import { type ChildProcess, fork, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CodeLanguage } from "@agentforge/core";
import { trackChild } from "../child-processes";
import { log } from "../log";
import {
  BOOT_TIMEOUT_MS,
  CHILD_OLD_SPACE_MB,
  CHILD_STREAM_CAP_CHARS,
  JS_WASM_MAX_MB,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_FILES,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILES,
  PY_WASM_MAX_MB,
} from "./limits";
import { type ChildBootConfig, type ChildJob, type ChildResult, parseChildMessage } from "./protocol";
import { JS_ENTRY, PY_ENTRY } from "./ship";

/** How much of the child's own stderr is kept to classify a crash. It is never shown to the model. */
const STDERR_TAIL_BYTES = 4096;

export type BootOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: "fatal" | "timeout" | "exit"; readonly detail: string };

export type RunOutcome =
  | { readonly kind: "result"; readonly result: ChildResult }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "crashed";
      readonly code: number | null;
      readonly signal: string | null;
      /** The child's stderr tail, for classification and the server log only. */
      readonly stderrTail: string;
    };

export type RunJob = Pick<ChildJob, "code" | "files" | "deadlineMs" | "stackKb" | "heapLimitBytes">;

/** One sandbox process. A pool leases it to one run at a time. */
export type SandboxChild = {
  readonly language: CodeLanguage;
  /** True until the process has exited. */
  alive(): boolean;
  /** Waits for `ready`. Calling it again returns the same answer. */
  boot(): Promise<BootOutcome>;
  /** Sends one job and waits for its result, the wall-clock kill, or the process dying. One at a time. */
  run(job: RunJob, wallMs: number): Promise<RunOutcome>;
  /** SIGKILL. Idempotent. */
  kill(): void;
  /** Called once when the process exits, however it ended. */
  onExit(listener: () => void): void;
};

export type SpawnOptions = {
  readonly shipDir: string;
  readonly language: CodeLanguage;
  readonly bootTimeoutMs?: number;
  /** Test hook: merged into the boot config sent to the child. */
  readonly config?: Partial<ChildBootConfig>;
};

function bootConfig(language: CodeLanguage, overrides: Partial<ChildBootConfig> | undefined): ChildBootConfig {
  return {
    wasmMaxMb: language === "python" ? PY_WASM_MAX_MB : JS_WASM_MAX_MB,
    ...(language === "python" ? { packages: ["numpy", "pandas"], preimport: "import numpy, pandas" } : {}),
    maxOutFiles: MAX_OUTPUT_FILES,
    maxOutFileBytes: MAX_OUTPUT_FILE_BYTES,
    maxWorkspaceFiles: MAX_WORKSPACE_FILES,
    maxWorkspaceBytes: MAX_WORKSPACE_BYTES,
    streamCapChars: CHILD_STREAM_CAP_CHARS,
    ...overrides,
  };
}

/**
 * The process flags that make a child a sandbox. `--permission` with a read grant on the ship directory
 * only (no write, no child process, no worker, no addon) and `--disallow-code-generation-from-strings`
 * apply to the whole process, which a worker thread cannot get (the 2026-10-03 prototype matrix). The
 * old-space cap bounds the glue; the guest's own memory is the wasm instance, capped inside the child.
 */
export function childExecArgv(shipDir: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${shipDir}`,
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${CHILD_OLD_SPACE_MB}`,
  ];
}

/**
 * The child's environment. NEVER the parent's: the hosted parent holds `AGENTFORGE_SECRETS_KEY` and
 * every tenant's keys. Under Electron the executable is the app itself, which needs this one variable
 * to behave as plain Node.
 */
export function childEnv(): Record<string, string> {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}

/** Starts a sandbox child and registers it with the shell so Cmd+Q cannot orphan it. */
export function spawnSandboxChild(options: SpawnOptions): SandboxChild {
  const { shipDir, language } = options;
  const entry = join(shipDir, language === "python" ? PY_ENTRY : JS_ENTRY);
  // `windowsHide` is honoured by spawn but missing from the typings of fork.
  const forkOptions: ForkOptions & { windowsHide: boolean } = {
    execPath: process.execPath,
    execArgv: childExecArgv(shipDir),
    env: childEnv(),
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    cwd: shipDir,
    windowsHide: true,
  };
  const child: ChildProcess = fork(entry, [JSON.stringify(bootConfig(language, options.config))], forkOptions);
  trackChild(child);

  let stderrTail = "";
  let exited = false;
  let exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null };
  let ready: BootOutcome | null = null;
  const exitListeners: Array<() => void> = [];
  const waiters = new Set<(message: ReturnType<typeof parseChildMessage> | "exit") => void>();

  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  child.on("message", (raw: unknown) => {
    const message = parseChildMessage(raw);
    if (message) {
      for (const waiter of [...waiters]) {
        waiter(message);
      }
    }
  });
  const onGone = (code: number | null, signal: string | null) => {
    if (exited) {
      return;
    }
    exited = true;
    exitInfo = { code, signal };
    for (const waiter of [...waiters]) {
      waiter("exit");
    }
    for (const listener of exitListeners) {
      listener();
    }
  };
  // `close`, not `exit`: it fires after stderr is drained, so a crash can be classified from its last words.
  child.once("close", (code, signal) => onGone(code, signal));
  child.once("error", (error) => {
    log.warn("code_runner_child_error", { language, detail: error.message.slice(0, 200) });
    onGone(null, null);
  });

  const kill = (): void => {
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };

  let bootPromise: Promise<BootOutcome> | null = null;
  const boot = (): Promise<BootOutcome> => {
    bootPromise ??= new Promise<BootOutcome>((resolve) => {
      const settle = (outcome: BootOutcome): void => {
        clearTimeout(timer);
        waiters.delete(waiter);
        ready = outcome;
        resolve(outcome);
      };
      const waiter = (message: ReturnType<typeof parseChildMessage> | "exit"): void => {
        if (message === "exit") {
          settle({ ok: false, why: "exit", detail: `exit ${exitInfo.code ?? exitInfo.signal ?? "unknown"}` });
        } else if (message?.type === "ready") {
          settle({ ok: true });
        } else if (message?.type === "fatal") {
          settle({ ok: false, why: "fatal", detail: message.error.slice(0, 200) });
          kill();
        }
      };
      const timer = setTimeout(() => {
        settle({ ok: false, why: "timeout", detail: "boot timed out" });
        kill();
      }, options.bootTimeoutMs ?? BOOT_TIMEOUT_MS);
      timer.unref?.();
      if (exited) {
        waiter("exit");
      } else {
        waiters.add(waiter);
      }
    });
    return bootPromise;
  };

  const run = (job: RunJob, wallMs: number): Promise<RunOutcome> =>
    new Promise<RunOutcome>((resolve) => {
      if (exited || ready?.ok !== true) {
        resolve({ kind: "crashed", code: exitInfo.code, signal: exitInfo.signal, stderrTail });
        return;
      }
      const id = randomUUID();
      let killedByTimer = false;
      const settle = (outcome: RunOutcome): void => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(outcome);
      };
      const waiter = (message: ReturnType<typeof parseChildMessage> | "exit"): void => {
        if (message === "exit") {
          settle(
            killedByTimer
              ? { kind: "timeout" }
              : { kind: "crashed", code: exitInfo.code, signal: exitInfo.signal, stderrTail },
          );
        } else if (message?.type === "result" && message.id === id) {
          settle({ kind: "result", result: message });
        }
      };
      const timer = setTimeout(() => {
        killedByTimer = true;
        kill();
        // The exit event settles the promise; settle here too in case it is slow to arrive.
        settle({ kind: "timeout" });
      }, wallMs);
      timer.unref?.();
      waiters.add(waiter);
      const message: ChildJob = { type: "job", id, ...job };
      child.send(message, (error) => {
        if (error) {
          kill();
          settle({ kind: "crashed", code: exitInfo.code, signal: exitInfo.signal, stderrTail });
        }
      });
    });

  return {
    language,
    alive: () => !exited && child.exitCode === null && child.signalCode === null,
    boot,
    run,
    kill,
    onExit(listener) {
      if (exited) {
        listener();
      } else {
        exitListeners.push(listener);
      }
    },
  };
}
