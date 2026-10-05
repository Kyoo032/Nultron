import type { CodeLanguage, CodeRunFailure } from "@agentforge/core";
import {
  JS_WASM_MAX_MB,
  MAX_CODE_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_FILES,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILES,
  PY_WASM_MAX_MB,
  RUN_TIMEOUT_MS,
} from "./limits";
import type { ChildResult } from "./protocol";

/**
 * Turning what a child did into a reason class and a sentence the model can act on. The sentences are
 * fixed here, chosen from the failure, never copied out of a process error (SR-48): a path, a stack or a
 * port can only reach the model through the guest's own exception text, which `sanitize.ts` scrubs.
 */

const PY_SYNTAX = new Set(["SyntaxError", "IndentationError", "TabError"]);
const MEMORY_TEXT = /MemoryError|wasm memory cap|Cannot enlarge memory|out of memory/i;
/** Node's permission model killed the child: the program reached for files, processes or the network. */
const PERMISSION_DENIED = /Access to this API has been restricted|ERR_ACCESS_DENIED/;
const HEAP_EXHAUSTED = /heap out of memory|Reached heap limit|Allocation failed|FATAL ERROR/i;

export const NOTES = {
  unavailable: "[run_code] Code execution is not available right now.",
  disabled:
    "[run_code] Code execution is turned off here, so this program was not run. Say so rather than retrying, and work the answer out another way.",
  busy: "[run_code] Another code run is still going. Wait a moment and call run_code again.",
  timeout: `[run_code] The run took longer than ${RUN_TIMEOUT_MS / 1000} seconds and was stopped. Nothing from it was saved. Make the code faster or work on less data.`,
  memory: `[run_code] The run used more memory than the sandbox allows (${PY_WASM_MAX_MB} MB for Python, ${JS_WASM_MAX_MB} MB for JavaScript) and was stopped. Nothing from it was saved. Work on less data at a time.`,
  denied:
    "[run_code] The sandbox stopped this program because it tried to use something that is not allowed: files outside /workspace, other programs, or the network. Only /workspace is available.",
  crashed: "[run_code] The sandbox process stopped unexpectedly. Try again; if it keeps happening, simplify the code.",
  workspace: `[run_code] The program left too much in /workspace (more than ${MAX_WORKSPACE_FILES} files or ${MAX_WORKSPACE_BYTES / (1024 * 1024)} MB). Nothing from it was saved.`,
  codeTooLong: `[run_code] The code is longer than ${MAX_CODE_BYTES / 1024} KB. Split it, or put data in a file instead of in the code.`,
  tooManyInputs: `[run_code] At most ${MAX_INPUT_FILES} input files are allowed per run.`,
  inputsTooLarge: `[run_code] The input files are larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB together. Name fewer or smaller files.`,
  discarded: "[run_code] The run failed, so none of the files it wrote were saved.",
} as const;

/** The reason class of a guest exception. Used only when the child reported an error. */
export function classifyGuestError(language: CodeLanguage, result: ChildResult): CodeRunFailure {
  const text = result.error ?? "";
  if (language === "javascript") {
    if (result.why === "deadline") {
      return "timeout";
    }
    if (result.why === "wasm-memory" || MEMORY_TEXT.test(text)) {
      return "memory";
    }
    return result.errorName === "SyntaxError" ? "syntax" : "runtime";
  }
  if (result.errorName && PY_SYNTAX.has(result.errorName)) {
    return "syntax";
  }
  if (result.errorName === "MemoryError" || MEMORY_TEXT.test(text)) {
    return "memory";
  }
  return "runtime";
}

/** What a child's death was, from the last words on its stderr. Never shown to the model as is. */
export function classifyCrash(stderrTail: string): { reason: CodeRunFailure; note: string } {
  if (PERMISSION_DENIED.test(stderrTail)) {
    return { reason: "runtime", note: NOTES.denied };
  }
  if (HEAP_EXHAUSTED.test(stderrTail)) {
    return { reason: "memory", note: NOTES.memory };
  }
  return { reason: "runtime", note: NOTES.crashed };
}

/** A fixed phrase for an output file the child or the runner left out. */
export function skippedNote(name: string, why: string): string {
  const reasons: Record<string, string> = {
    too_large: "larger than 2 MB",
    too_many: "more than 20 files in one run; only the first 20 are saved",
    not_text: "not text; the desk only keeps text files",
    binary: "not valid UTF-8 text; the desk only keeps text files",
    bad_name: "not a valid file name",
  };
  return `[run_code] Skipped ${name}: ${reasons[why] ?? "not saved"}.`;
}
