/**
 * Entry point of the harness smoke lever (dev only, never bundled). Thin wiring: argument parsing is in
 * `args.ts`, the cases in `cases.ts`, the folds in `observe.ts`, the table and comparison in `rows.ts`.
 *
 *   cd packages/host && npx tsx eval/harness/run.ts [--name baseline] [--case data] ...
 *
 * The host it drives is the owner's isolated webdev and it is already running: this file never starts,
 * stops or restarts a server.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { USAGE, UsageError, parseHarnessArgs, type HarnessArgs } from "./args";
import { CASES, CASE_IDS, type CaseContext, type Desk } from "./cases";
import { cleanUp, createTracker, findStrayArtifacts, listArtifactIds, type Tracker } from "./cleanup";
import { createHttp, describeError, errorText, isOk, type Http } from "./client";
import { runDoctor } from "./doctor";
import {
  compareRuns,
  failedRow,
  formatDifferences,
  formatTable,
  shapeRow,
  summarize,
  type CaseRow,
  type CleanupRecord,
  type RunFile,
} from "./rows";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const DOCTOR_PATH = join(REPO_ROOT, ".cursor/skills/verify-agentforge/scripts/doctor.mjs");
const DEFAULT_RESULTS_DIR = join(HERE, "results");
const DEFAULT_EVIDENCE_DIR = join(REPO_ROOT, ".cursor/skills/verify-agentforge/evidence/harness");

/** The run cannot start; the message says why and nothing has been spent. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function readDesk(http: Http): Promise<Desk> {
  const workspaces = await http.get("/api/v1/workspaces");
  if (workspaces.status !== 200) {
    throw new Refusal(`GET /api/v1/workspaces answered ${workspaces.status}; the webdev on ${http.base} is not ready`);
  }
  const chat = await http.get("/api/v1/chat");
  if (!isOk(chat.status)) {
    throw new Refusal(`GET /api/v1/chat failed: ${errorText(chat.body, chat.status)}`);
  }
  const agentId = record(record(chat.body).agent).id;
  const defaultModel = record(chat.body).defaultModel;
  if (typeof agentId !== "string" || typeof defaultModel !== "string" || !defaultModel) {
    throw new Refusal("GET /api/v1/chat did not name the desk's Chat agent and default model");
  }
  const workspaceId = record(workspaces.body).currentWorkspaceId;
  return { workspaceId: typeof workspaceId === "string" ? workspaceId : null, agentId, defaultModel };
}

async function runOne(id: string, context: CaseContext): Promise<CaseRow> {
  const harnessCase = CASES.find((item) => item.id === id);
  if (!harnessCase) {
    throw new Refusal(`unknown case ${id}`);
  }
  const started = performance.now();
  try {
    const outcome = await harnessCase.run(context);
    return shapeRow({ id, mode: harnessCase.mode, wallMs: performance.now() - started, outcome });
  } catch (error) {
    return failedRow({
      id,
      mode: harnessCase.mode,
      wallMs: performance.now() - started,
      error: describeError(error, harnessCase.timeoutMs),
    });
  }
}

async function finish(
  http: Http,
  args: HarnessArgs,
  tracker: Tracker,
  known: ReadonlySet<string>,
): Promise<CleanupRecord | null> {
  if (!args.cleanup) {
    return null;
  }
  const questions = new Set(CASES.filter((item) => args.cases.includes(item.id)).flatMap((item) => item.questions));
  for (const id of await findStrayArtifacts(http, known, questions)) {
    tracker.artifact(id);
  }
  return cleanUp(http, tracker.snapshot());
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<number> {
  const args = parseHarnessArgs(process.argv.slice(2), {
    resultsDir: DEFAULT_RESULTS_DIR,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    caseIds: CASE_IDS,
    now: new Date(),
  });
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.list) {
    process.stdout.write(
      `${CASES.map((item) => `${item.id.padEnd(14)} ${item.mode.padEnd(14)} ${item.title}`).join("\n")}\n`,
    );
    return 0;
  }

  const http = createHttp({ base: args.base });
  const desk = await readDesk(http);
  const doctor = args.doctor ? runDoctor(DOCTOR_PATH, args.base) : null;
  if (doctor && !doctor.ok) {
    throw new Refusal(`the doctor did not pass: ${doctor.verdict || "no output"}`);
  }
  const known = await listArtifactIds(http);
  const tracker = createTracker();
  const context: CaseContext = { http, tracker, desk, knownArtifacts: known };

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write("\ninterrupted: removing what this run made, press Ctrl-C again to quit now\n");
    void finish(http, args, tracker, known).finally(() => process.exit(130));
  });

  const startedAt = new Date();
  const rows: CaseRow[] = [];
  for (const [at, id] of args.cases.entries()) {
    process.stderr.write(`[${at + 1}/${args.cases.length}] ${id} ...\n`);
    const row = await runOne(id, context);
    rows.push(row);
    process.stderr.write(
      `    ${row.completed ? "done" : "NOT DONE"} in ${row.wallMs} ms${row.error ? `: ${row.error}` : ""}\n`,
    );
  }

  const cleanup = await finish(http, args, tracker, known);
  const run: RunFile = {
    runId: args.runId,
    name: args.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    base: args.base,
    desk,
    rows,
    cleanup,
    summary: summarize(rows),
  };

  const resultPath = join(args.resultsDir, `${args.name}.json`);
  await writeJson(resultPath, run);
  const evidenceFolder = join(args.evidenceDir, args.runId);
  await writeJson(join(evidenceFolder, `${args.name}.json`), run);
  if (doctor?.json) {
    await writeJson(join(evidenceFolder, "doctor.json"), doctor.json);
  }

  process.stdout.write(`\n${formatTable(rows)}\n`);
  process.stdout.write(
    `\n${run.summary.completed}/${run.summary.cases} completed, ${run.summary.expectFailures} unmet expectations, ` +
      `${run.summary.checkFailures} API check failures, ${Math.round(run.summary.wallMs / 1000)} s\n`,
  );
  if (cleanup) {
    process.stdout.write(
      `cleanup: removed ${cleanup.threads.length} thread(s), ${cleanup.datasets.length} dataset(s), ` +
        `${cleanup.artifacts.length} artifact(s); verified gone: ${cleanup.verifiedGone}` +
        `${cleanup.failed.length > 0 ? `; FAILED: ${cleanup.failed.join("; ")}` : ""}\n`,
    );
  }
  process.stdout.write(`result: ${resultPath}\nevidence: ${evidenceFolder}\n`);

  if (args.compare) {
    const earlier = JSON.parse(await readFile(args.compare, "utf8")) as RunFile;
    process.stdout.write(`\nagainst ${args.compare}:\n${formatDifferences(compareRuns(earlier, run))}\n`);
  }

  const clean = rows.every((row) => row.completed && row.expectFailures.length === 0);
  return clean ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "The run failed.";
    if (error instanceof UsageError) {
      process.stderr.write(`${message}\n\n${USAGE}\n`);
    } else if (error instanceof Refusal) {
      process.stderr.write(`Refused: ${message}\n`);
    } else {
      process.stderr.write(`harness failed: ${message}\n`);
    }
    process.exitCode = 2;
  },
);
