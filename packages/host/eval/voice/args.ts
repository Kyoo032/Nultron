import { parseArgs as parseNodeArgs } from "node:util";

/** A command line the tool refuses. The message is the whole explanation. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Rizky's own desks: webdev and the tester. The runner never talks to a host on these ports, on any host, with no override. */
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3200];

export type VoiceArgs = {
  /** The origin of `--base-url`, with no path. */
  baseUrl: string;
  cases: string[];
  repeat: number;
  out: string | null;
  compare: string | null;
  locale: "id" | "en";
  showText: boolean;
  noCleanup: boolean;
  list: boolean;
  help: boolean;
  runId: string;
};

export const DEFAULT_REPEAT = 5;
const MAX_REPEAT = 50;

export const USAGE = `voice eval: plays recorded speech into a running desk over the real voice protocol and reports how fast the
answer started, whether turn-taking was right and whether the turns were saved.

  npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300 [flags]      (from packages/host)

  --base-url <url>   the desk to drive (required). Never port 3000 or 3200, on any host: those are Rizky's own desks.
  --case <name>      run only this case; repeat the flag or comma-separate for more (default: all)
  --repeat <n>       runs per latency case and for barge-in-stops (default ${DEFAULT_REPEAT})
  --out <file>       where the JSON result goes (default eval/voice/results/<run-id>.json, gitignored)
  --compare <file>   after the run, list what differs from an earlier result file
  --locale id|en     sent as Accept-Language and checked against the desk's own language (default id)
  --show-text        print captions and saved text; without it only their length and a short hash are shown
  --no-cleanup       keep the threads the run created
  --list             print the case names and stop
  --help

It never starts or stops a desk. The desk needs AGENTFORGE_VOICE=on and a live gateway key.
Exit code: 0 no case failed, 1 a case failed or errored, 2 the run could not start.`;

/** The port a URL really uses, with the scheme's default when none is written. */
export function portOf(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

/** The origin of `raw`, or a `UsageError` for anything the runner must not drive. */
export function requireAllowedBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--base-url must be a URL such as http://127.0.0.1:3300, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--base-url must be http or https, got ${url.protocol}`);
  }
  const port = portOf(url);
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new UsageError(
      `refusing to run against port ${port}: ${FORBIDDEN_PORTS.join(" and ")} are Rizky's own desks, on any host, with no override. ` +
        "Start an isolated desk on another PORT with its own AGENTFORGE_DATA_DIR (see eval/voice/README.md).",
    );
  }
  return url.origin;
}

function splitIds(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((id) => id.trim())
    .filter(Boolean);
}

export function runIdFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

const OPTIONS = {
  "base-url": { type: "string" },
  case: { type: "string", multiple: true },
  repeat: { type: "string" },
  out: { type: "string" },
  compare: { type: "string" },
  locale: { type: "string" },
  "show-text": { type: "boolean" },
  "no-cleanup": { type: "boolean" },
  list: { type: "boolean" },
  help: { type: "boolean" },
} as const;

export function parseVoiceArgs(argv: readonly string[], defaults: { caseIds: readonly string[]; now: Date }): VoiceArgs {
  let values: ReturnType<typeof parseNodeArgs<{ options: typeof OPTIONS; allowPositionals: false }>>["values"];
  try {
    values = parseNodeArgs({ args: [...argv], allowPositionals: false, options: OPTIONS }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "bad command line");
  }

  const list = values.list === true;
  const help = values.help === true;

  const wanted = splitIds(values.case);
  for (const id of wanted) {
    if (!defaults.caseIds.includes(id)) {
      throw new UsageError(`unknown case ${JSON.stringify(id)}; the cases are ${defaults.caseIds.join(", ")}`);
    }
  }
  // Keep the cases in their fixed order whatever order the flags named them in.
  const cases = defaults.caseIds.filter((id) => wanted.length === 0 || wanted.includes(id));

  let repeat = DEFAULT_REPEAT;
  if (values.repeat !== undefined) {
    repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
      throw new UsageError(`--repeat must be a whole number from 1 to ${MAX_REPEAT}, got ${JSON.stringify(values.repeat)}`);
    }
  }

  const locale = values.locale ?? "id";
  if (locale !== "id" && locale !== "en") {
    throw new UsageError(`--locale must be id or en, got ${JSON.stringify(values.locale)}`);
  }

  let baseUrl = "";
  if (!list && !help) {
    if (!values["base-url"]) {
      throw new UsageError("--base-url is required");
    }
    baseUrl = requireAllowedBase(values["base-url"]);
  }

  return {
    baseUrl,
    cases,
    repeat,
    out: values.out ?? null,
    compare: values.compare ?? null,
    locale,
    showText: values["show-text"] === true,
    noCleanup: values["no-cleanup"] === true,
    list,
    help,
    runId: runIdFor(defaults.now),
  };
}
