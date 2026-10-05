/**
 * The `run_code` contract. Both engines (Pyodide for Python, QuickJS for JavaScript) run with no
 * network, no host filesystem and no host environment. Desk files named in `files` are copied into
 * `/workspace`; anything written under `/workspace/out` comes back as agent versions on the desk.
 */

export type CodeLanguage = "python" | "javascript";

export type CodeRunInput = {
  readonly language: CodeLanguage;
  readonly code: string;
  /** Desk paths copied into `/workspace` before the run. */
  readonly files?: readonly string[];
};

export type CodeRunFailure = "timeout" | "memory" | "syntax" | "runtime" | "too_large" | "busy" | "unavailable";

export type CodeRunResult = {
  readonly ok: boolean;
  /** Capped. */
  readonly stdout: string;
  /** Capped; host paths and stack frames are reduced before it leaves the runner. */
  readonly stderr: string;
  readonly filesWritten: ReadonlyArray<{ readonly path: string; readonly version: number }>;
  readonly reason?: CodeRunFailure;
};
