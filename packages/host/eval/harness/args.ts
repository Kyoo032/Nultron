import { parseArgs as parseNodeArgs } from "node:util";
import { requireLoopbackBase } from "./client";

/** A command line the tool refuses. The message is the whole explanation. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type HarnessArgs = {
  base: string;
  runId: string;
  /** The results file is `<name>.json`; the evidence copy is named the same. Defaults to the run id. */
  name: string;
  cases: string[];
  resultsDir: string;
  /** Root of `evidence/harness/`; the run's folder is `<evidenceDir>/<runId>/`. */
  evidenceDir: string;
  doctor: boolean;
  cleanup: boolean;
  compare: string | null;
  list: boolean;
  help: boolean;
};

export const USAGE = `harness smoke: drives Chat, Data, Documents, Presentation and Research once each on the running webdev.

  npx tsx eval/harness/run.ts [flags]          (from packages/host)

  --base <url>         the host to drive; loopback only (default http://127.0.0.1:3000)
  --case <ids>         run only these cases, comma separated or repeated
  --skip <ids>         leave these cases out
  --name <name>        results file name, results/<name>.json (default: the run id); "baseline" is the H0 file
  --run-id <id>        label for the run and its evidence folder (default: the start time)
  --results-dir <dir>  where result files go (default eval/harness/results, gitignored)
  --evidence-dir <dir> evidence/harness root; a copy of the doctor JSON and the result goes to <dir>/<run-id>/
  --compare <file>     after the run, list what differs from an earlier result file (completion, tools, failures)
  --no-doctor          do not run the verify skill's doctor first (the run still needs /api/v1/workspaces = 200)
  --no-cleanup         keep the threads, datasets and artifacts the run made
  --list               print the case ids and stop
  --help

It never starts or stops a server. Every case calls the model once through a real, billed gateway key.
Exit code: 0 all selected cases completed and met their expectations, 1 some did not, 2 the run could not start.`;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function splitIds(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((id) => id.trim())
    .filter(Boolean);
}

function safeName(flag: string, value: string): string {
  if (!SAFE_NAME.test(value)) {
    throw new UsageError(
      `${flag} may hold letters, digits, dot, dash and underscore only, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** `2026-10-03T07:12:45.123Z` becomes `2026-10-03T07-12-45-123Z`, which is a legal file name everywhere. */
export function runIdFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const OPTIONS = {
  base: { type: "string" },
  case: { type: "string", multiple: true },
  skip: { type: "string", multiple: true },
  name: { type: "string" },
  "run-id": { type: "string" },
  "results-dir": { type: "string" },
  "evidence-dir": { type: "string" },
  compare: { type: "string" },
  "no-doctor": { type: "boolean" },
  "no-cleanup": { type: "boolean" },
  list: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function readOptions(argv: readonly string[]) {
  try {
    return parseNodeArgs({ args: [...argv], allowPositionals: false, options: OPTIONS }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "bad command line");
  }
}

export function parseHarnessArgs(
  argv: readonly string[],
  defaults: { resultsDir: string; evidenceDir: string; caseIds: readonly string[]; now: Date },
): HarnessArgs {
  const values = readOptions(argv);

  const wanted = splitIds(values.case);
  const skipped = splitIds(values.skip);
  for (const id of [...wanted, ...skipped]) {
    if (!defaults.caseIds.includes(id)) {
      throw new UsageError(`unknown case ${JSON.stringify(id)}; the cases are ${defaults.caseIds.join(", ")}`);
    }
  }
  const selected = (wanted.length > 0 ? wanted : [...defaults.caseIds]).filter((id) => !skipped.includes(id));
  // Keep the cases in their fixed order whatever order the flags named them in.
  const cases = defaults.caseIds.filter((id) => selected.includes(id));
  if (cases.length === 0 && !values.list && !values.help) {
    throw new UsageError("no case is left to run");
  }

  const runId = safeName("--run-id", values["run-id"] ?? runIdFor(defaults.now));
  let base: string;
  try {
    base = requireLoopbackBase(values.base ?? "http://127.0.0.1:3000");
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "bad --base");
  }

  return {
    base,
    runId,
    name: safeName("--name", values.name ?? runId),
    cases,
    resultsDir: values["results-dir"] ?? defaults.resultsDir,
    evidenceDir: values["evidence-dir"] ?? defaults.evidenceDir,
    doctor: !values["no-doctor"],
    cleanup: !values["no-cleanup"],
    compare: values.compare ?? null,
    list: values.list === true,
    help: values.help === true,
  };
}
