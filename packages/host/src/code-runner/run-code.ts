import { type CodeLanguage, type CodeRunFailure, isServerMode } from "@agentforge/core";
import { isFileRefusal, parseDeskPath } from "@agentforge/core/tools/files";
import type { Release } from "../concurrency";
import { log } from "../log";
import { type CodeLimiter, createCodeLimiter } from "./code-limiter";
import { type RunJob, type RunOutcome, type SandboxChild, spawnSandboxChild } from "./child-process";
import {
  JS_DEADLINE_MARGIN_MS,
  JS_HEAP_LIMIT_BYTES,
  JS_STACK_KB,
  MAX_CODE_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_FILES,
  RUN_TIMEOUT_MS,
} from "./limits";
import { classifyCrash, classifyGuestError, NOTES, skippedNote } from "./outcome";
import { type ChildPool, createChildPool, type Lease } from "./pool";
import type { ChildResult } from "./protocol";
import { cleanGuestError, composeStream, hostRedactions } from "./sanitize";
import { checkShip, type ShipStatus } from "./ship";

/**
 * One sandboxed run, start to finish, with no knowledge of the desk: text files in, text files out.
 * `run-code-tool.ts` puts the desk on either side.
 */

export type SandboxRunRequest = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly language: CodeLanguage;
  readonly code: string;
  /** Path relative to /workspace (a desk path) -> UTF-8 text. */
  readonly files: Readonly<Record<string, string>>;
};

export type SandboxOutputFile = { readonly path: string; readonly text: string };

export type SandboxRunResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: CodeRunFailure;
  /** New or changed text files the run left under out/, ready to save. Empty when the run failed. */
  readonly outputs: readonly SandboxOutputFile[];
};

export type SandboxRunner = {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  /** Kills every warm child. */
  shutdown(): void;
};

export type RunnerDeps = {
  readonly pool?: ChildPool;
  readonly limiter?: CodeLimiter;
  readonly checkShip?: () => Promise<ShipStatus>;
  readonly runTimeoutMs?: number;
  readonly spawn?: (language: CodeLanguage, shipDir: string) => SandboxChild;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

function failure(reason: CodeRunFailure, note: string): SandboxRunResult {
  return { ok: false, stdout: "", stderr: note, reason, outputs: [] };
}

function checkRequest(request: SandboxRunRequest): SandboxRunResult | null {
  if (Buffer.byteLength(request.code, "utf8") > MAX_CODE_BYTES) {
    return failure("too_large", NOTES.codeTooLong);
  }
  const names = Object.keys(request.files);
  if (names.length > MAX_INPUT_FILES) {
    return failure("too_large", NOTES.tooManyInputs);
  }
  const bytes = Object.values(request.files).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
  return bytes > MAX_INPUT_BYTES ? failure("too_large", NOTES.inputsTooLarge) : null;
}

/** A guest-chosen file name made safe to print: no control characters, no more than 120 characters. */
function printable(name: string): string {
  return Array.from(name)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? "?" : ch))
    .join("")
    .slice(0, 120);
}

type Collected = { readonly outputs: SandboxOutputFile[]; readonly notes: string[] };

/** The files the child returned, re-checked here: the child ran guest code and its word is not enough. */
function collectOutputs(result: ChildResult): Collected {
  const outputs: SandboxOutputFile[] = [];
  const notes = result.skipped.map((entry) => skippedNote(printable(entry.name), entry.why));
  for (const [name, bytes] of Object.entries(result.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shown = printable(name);
    const parsed = parseDeskPath(name);
    if (isFileRefusal(parsed) || !name.startsWith("out/")) {
      notes.push(skippedNote(shown, "bad_name"));
    } else if (bytes.byteLength > MAX_OUTPUT_FILE_BYTES) {
      notes.push(skippedNote(shown, "too_large"));
    } else if (outputs.length >= MAX_OUTPUT_FILES) {
      notes.push(skippedNote(shown, "too_many"));
    } else {
      try {
        const text = utf8.decode(bytes);
        if (text.includes("\u0000")) {
          notes.push(skippedNote(shown, "binary"));
        } else {
          outputs.push({ path: parsed, text });
        }
      } catch {
        notes.push(skippedNote(shown, "binary"));
      }
    }
  }
  return { outputs, notes };
}

function joinSections(...parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

type Interpreted = { readonly result: SandboxRunResult; readonly reuse: boolean };

function interpretResult(language: CodeLanguage, result: ChildResult, redactions: readonly string[]): Interpreted {
  if (result.tooLarge) {
    return { result: failure("too_large", NOTES.workspace), reuse: false };
  }
  const reason = result.error === null ? undefined : classifyGuestError(language, result);
  const failedHard = reason === "memory" || reason === "timeout";
  const collected = collectOutputs(result);
  const notes = [...collected.notes];
  const errorText = result.error === null ? "" : cleanGuestError(result.error, redactions);
  const hardNote = reason === "memory" ? NOTES.memory : reason === "timeout" ? NOTES.timeout : "";
  if (reason && collected.outputs.length > 0) {
    notes.push(NOTES.discarded);
  }
  if (hardNote) {
    notes.push(hardNote);
  }
  const stdout = joinSections(result.stdout, result.value ?? "");
  const stderr = composeStream(joinSections(result.stderr, errorText), notes);
  return {
    result: {
      ok: reason === undefined,
      stdout: composeStream(stdout, []),
      stderr,
      ...(reason ? { reason } : {}),
      outputs: reason ? [] : collected.outputs,
    },
    reuse: !result.discard && !failedHard,
  };
}

function interpretOutcome(language: CodeLanguage, outcome: RunOutcome, redactions: readonly string[]): Interpreted {
  if (outcome.kind === "timeout") {
    return { result: failure("timeout", NOTES.timeout), reuse: false };
  }
  if (outcome.kind === "crashed") {
    const crash = classifyCrash(outcome.stderrTail);
    log.warn("code_runner_child_crashed", {
      language,
      reason: crash.reason,
      signal: outcome.signal ?? "none",
      exit: outcome.code ?? "none",
      tail: outcome.stderrTail.slice(-300),
    });
    return { result: failure(crash.reason, crash.note), reuse: false };
  }
  return interpretResult(language, outcome.result, redactions);
}

function jobFor(request: SandboxRunRequest, runTimeoutMs: number): RunJob {
  return {
    code: request.code,
    files: request.files,
    ...(request.language === "javascript"
      ? {
          deadlineMs: Math.max(runTimeoutMs - JS_DEADLINE_MARGIN_MS, 1000),
          stackKb: JS_STACK_KB,
          heapLimitBytes: JS_HEAP_LIMIT_BYTES,
        }
      : {}),
  };
}

export function createSandboxRunner(deps: RunnerDeps = {}): SandboxRunner {
  const runTimeoutMs = deps.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const verify = deps.checkShip ?? checkShip;
  const limiter = deps.limiter ?? createCodeLimiter();
  let shipDir = "";
  const pool =
    deps.pool ??
    createChildPool({
      serverMode: isServerMode(),
      spawn: (language) =>
        (deps.spawn ?? ((l, dir) => spawnSandboxChild({ shipDir: dir, language: l })))(language, shipDir),
    });

  const runLeased = async (request: SandboxRunRequest, redactions: readonly string[]): Promise<SandboxRunResult> => {
    const checkout = await pool.checkout({
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      language: request.language,
    });
    if (!checkout.ok) {
      if (checkout.why === "busy") {
        return failure("busy", NOTES.busy);
      }
      log.warn("code_runner_boot_failed", {
        language: request.language,
        why: checkout.boot.why,
        detail: checkout.boot.detail,
      });
      return failure("unavailable", NOTES.unavailable);
    }
    const lease: Lease = checkout.lease;
    let reuse = false;
    const started = Date.now();
    try {
      const outcome = await lease.child.run(jobFor(request, runTimeoutMs), runTimeoutMs);
      const interpreted = interpretOutcome(request.language, outcome, redactions);
      reuse = interpreted.reuse;
      log.info("code_run", {
        language: request.language,
        cold: lease.cold,
        ms: Date.now() - started,
        reason: interpreted.result.reason ?? "ok",
      });
      return interpreted.result;
    } finally {
      lease.release(reuse);
    }
  };

  return {
    async run(request) {
      const refused = checkRequest(request);
      if (refused) {
        return refused;
      }
      const ship = await verify();
      if (!ship.ok || !ship.languages.has(request.language)) {
        return failure("unavailable", NOTES.unavailable);
      }
      shipDir = ship.dir;
      const release: Release | null = await limiter.acquire(request.tenantId);
      if (!release) {
        return failure("busy", NOTES.busy);
      }
      try {
        return await runLeased(request, hostRedactions([ship.dir]));
      } finally {
        release();
      }
    },
    shutdown: () => pool.shutdown(),
  };
}

let sharedRunner: SandboxRunner | null = null;

/** The process-wide runner. Created on first use; its children are killed when the process exits. */
export function sandboxRunner(): SandboxRunner {
  if (!sharedRunner) {
    sharedRunner = createSandboxRunner();
    const runner = sharedRunner;
    process.once("exit", () => runner.shutdown());
  }
  return sharedRunner;
}

/** Test seam: replace (or clear) the shared runner. The previous one is shut down. */
export function setSandboxRunnerForTests(next: SandboxRunner | null): void {
  sharedRunner?.shutdown();
  sharedRunner = next;
}
