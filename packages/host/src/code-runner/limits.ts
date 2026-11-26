/**
 * Every number the code runner enforces, in one place. The child scripts receive the output limits in
 * their boot config, so the parent and the child can never disagree about them.
 */

/** Longest `code` argument, in UTF-8 bytes. */
export const MAX_CODE_BYTES = 100 * 1024;
/** Desk files a single run may copy in. */
export const MAX_INPUT_FILES = 20;
/** Plain-text bytes across all input files. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** A cold start is 11 to 25 s on a loaded machine (Pyodide with numpy and pandas); QuickJS is under a second. */
export const BOOT_TIMEOUT_MS = 60_000;
/** Wall clock for one run, from the moment the job is sent. The child is SIGKILLed when it passes. */
export const RUN_TIMEOUT_MS = 30_000;
/** QuickJS stops its own loop this long before the kill, so the common runaway loop gets a clean error. */
export const JS_DEADLINE_MARGIN_MS = 3_000;

/**
 * Memory budget for one sandbox child on a 768 MiB desk (DFIND-166): the child shares the desk's
 * container limit with the host. A Python child can hold about 256 MB of wasm, 128 MB of V8 old space
 * and roughly 40 MB of Node baseline, about 430 MB worst case, which leaves the host 300+ MB.
 * One warm child and one run at a time keep that bound; raising it needs a bigger desk, not a config.
 */
/** Cap on the linear memory of the Pyodide wasm instance (the grow wrapper in py-child.mjs). */
export const PY_WASM_MAX_MB = 256;
/** Cap on the QuickJS wasm instance, and the heap and stack it gives one script. */
export const JS_WASM_MAX_MB = 128;
export const JS_HEAP_LIMIT_BYTES = 64 * 1024 * 1024;
export const JS_STACK_KB = 256;
/** V8 old-space cap of the child process itself (the guest's memory is the wasm instance, not this). */
export const CHILD_OLD_SPACE_MB = 128;

/** What the model sees of stdout and stderr, each, in UTF-8 bytes. */
export const MAX_STREAM_BYTES = 64 * 1024;
/** Files saved back to the desk per run, and the size of each. The desk store is text only. */
export const MAX_OUTPUT_FILES = 20;
export const MAX_OUTPUT_FILE_BYTES = 2 * 1024 * 1024;
/**
 * A run that leaves more than this in /workspace (files, or bytes) is an oversize result: the child is
 * discarded and the run answers `too_large`.
 */
export const MAX_WORKSPACE_FILES = 500;
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
/** Each child caps its own output streams at this many characters before the parent cuts them again. */
export const CHILD_STREAM_CAP_CHARS = 1_000_000;

/** A warm child nobody has used for this long is killed. */
export const IDLE_TIMEOUT_MS = 5 * 60_000;
/** How long a run waits for a free slot before it answers `busy`. */
export const QUEUE_WAIT_MS = 5_000;

/**
 * Personal keeps one warm child per language; hosted keeps this many in total, least recently used out
 * first. One warm child is the most a 768 MiB desk holds beside the host (DFIND-166).
 */
export const PERSONAL_WARM_PER_LANGUAGE = 1;
export const HOSTED_WARM_TOTAL = 1;

/** Concurrent runs: one on a desk, and on the hosted server one overall and one per tenant. */
export const PERSONAL_MAX_RUNS = 1;
export const HOSTED_MAX_RUNS = 1;
export const HOSTED_MAX_RUNS_PER_TENANT = 1;
/** Hosted operators can raise the global caps without a rebuild; Personal is never configurable. */
export const MAX_CODE_RUNS_ENV = "AGENTFORGE_MAX_CODE_RUNS";
export const MAX_CODE_RUNS_PER_TENANT_ENV = "AGENTFORGE_MAX_CODE_RUNS_PER_TENANT";
export const SANDBOX_DIR_ENV = "AGENTFORGE_SANDBOX_DIR";
/** The kill switch for `run_code`: "on" or "off" (see enabled.ts). Unset means on for Personal, off on the hosted server. */
export const CODE_RUNS_ENV = "AGENTFORGE_CODE_RUNS";
