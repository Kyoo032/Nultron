/**
 * Entry point of the voice eval (dev only, never bundled). Thin wiring: arguments in `args.ts`, the cases in
 * `cases.ts`, the loop in `runner.ts`, the table and comparison in `report.ts`.
 *
 *   cd packages/host && npx tsx eval/voice/run.ts --base-url http://127.0.0.1:3300
 *
 * The desk it drives is an isolated one that is already running: this file never starts, stops or restarts a
 * server, and it refuses ports 3000 and 3200 on any host.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, UsageError, parseVoiceArgs } from "./args";
import { loadFixtures } from "./audio";
import { CASES, CASE_IDS } from "./cases";
import { createVoiceClient } from "./client";
import { realClock } from "./clock";
import { type VoiceRunFile, compareRuns, exitCodeFor, formatDifferences, formatTable, summarizeRows } from "./report";
import { runCases } from "./runner";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = join(HERE, "results");
/** A `Cookie` header value for a desk that wants a signed-in session. Read, sent, never printed or stored. */
const COOKIE_ENV = "AGENTFORGE_VOICE_EVAL_COOKIE";

/** The run cannot start; the message says why and nothing has been spent. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

async function main(): Promise<number> {
  const args = parseVoiceArgs(process.argv.slice(2), { caseIds: CASE_IDS, now: new Date() });
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.list) {
    process.stdout.write(
      `${CASES.map((item) => `${item.id.padEnd(24)} ${item.repeatable ? "repeat" : "once  "}  ${item.title}`).join("\n")}\n`,
    );
    return 0;
  }

  const cookie = process.env[COOKIE_ENV];
  const client = createVoiceClient({
    base: args.baseUrl,
    clock: realClock,
    locale: args.locale,
    ...(cookie ? { cookie } : {}),
  });

  let settings: Awaited<ReturnType<typeof client.settings>>;
  try {
    settings = await client.settings();
  } catch (error) {
    throw new Refusal(`the desk at ${args.baseUrl} did not answer GET /api/v1/settings: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!settings.voice?.enabled) {
    throw new Refusal(
      `voice is not enabled on the desk at ${args.baseUrl}. Start it with AGENTFORGE_VOICE=on (in server mode the signed-in user must also be listed in AGENTFORGE_VOICE_OWNERS).`,
    );
  }
  if (settings.locale && settings.locale !== args.locale) {
    process.stderr.write(
      `note: the desk's language is ${settings.locale} and --locale is ${args.locale}; the fixtures are Indonesian either way.\n`,
    );
  }

  const fixtures = loadFixtures();
  const startedAt = new Date();
  const { rows, cleanup } = await runCases({
    client,
    clock: realClock,
    fixtures,
    settings,
    caseIds: args.cases,
    repeat: args.repeat,
    policy: { showText: args.showText },
    cleanup: !args.noCleanup,
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const run: VoiceRunFile = {
    format: 1,
    runId: args.runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    base: args.baseUrl,
    locale: args.locale,
    repeat: args.repeat,
    showText: args.showText,
    desk: { model: settings.voice.model, runtime: settings.runtime, locale: settings.locale },
    rows,
    cleanup,
    summary: summarizeRows(rows),
  };

  const outPath = args.out ?? join(DEFAULT_RESULTS_DIR, `${args.runId}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  const { summary } = run;
  process.stdout.write(`\n${formatTable(rows)}\n`);
  process.stdout.write(
    `\n${summary.pass}/${summary.cases} passed, ${summary.fail} failed, ${summary.skipped} skipped, ${summary.blocked} blocked, ${summary.error} errored, ${Math.round(summary.wallMs / 1000)} s\n`,
  );
  if (summary.skipped + summary.blocked > 0) {
    process.stdout.write("skipped and blocked cases are not passes: nothing was proven for them.\n");
  }
  if (cleanup) {
    process.stdout.write(`cleanup: ${cleanup.deleted} of ${cleanup.threads} thread(s) deleted${cleanup.failed > 0 ? `, ${cleanup.failed} FAILED` : ""}\n`);
  }
  process.stdout.write(`result: ${outPath}\n`);

  if (args.compare) {
    const earlier = JSON.parse(await readFile(args.compare, "utf8")) as VoiceRunFile;
    process.stdout.write(`\nagainst ${args.compare}:\n${formatDifferences(compareRuns(earlier, run))}\n`);
  }
  return exitCodeFor(rows);
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
      process.stderr.write(`voice eval failed: ${message}\n`);
    }
    process.exitCode = 2;
  },
);
