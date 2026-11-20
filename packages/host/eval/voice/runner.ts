/**
 * Runs the selected cases against a connected client and turns what they recorded into rows.
 *
 * A case that cannot run is SKIPPED_UNAVAILABLE or BLOCKED_NO_RUNTIME with its reason, never a pass. A frame
 * that does not arrive is a failed check (FAIL). Anything the runner itself could not do (a refused connection,
 * a bad answer) is ERROR, and a 429 or a timed-out request is ERROR_TRANSIENT. Every session a run opened is
 * ended when the run is over, whatever happened in it, so one case can never leave the next one a taken slot.
 */
import type { Fixtures } from "./audio";
import {
  type CaseContext,
  type Check,
  CASES,
  type NoteValue,
  type RunOutcome,
  SkipCase,
  TIMING,
  type VoiceCase,
  createRecorder,
} from "./cases";
import type { Clock } from "./clock";
import {
  type DeskSettings,
  H1Refused,
  SocketClosed,
  type VoiceClient,
  type VoiceSession,
  WaitTimeout,
} from "./client";
import { CASE_STATUS, type CaseRow, type CaseStatus, type CheckSummary, type VoiceRunFile } from "./report";
import { type NumberSummary, summarize } from "./stats";
import type { TextPolicy } from "./text";

export type RunnerInput = {
  client: VoiceClient;
  clock: Clock;
  fixtures: Fixtures;
  settings: DeskSettings;
  caseIds: readonly string[];
  repeat: number;
  policy: TextPolicy;
  /** Delete the threads the run created when it is over. */
  cleanup: boolean;
  cases?: readonly VoiceCase[];
  log?: (line: string) => void;
  /** Backstop for one run of one case, in client-clock ms. */
  runMs?: number;
  /** How late a microphone frame may leave before a latency number is not trusted (default `TIMING.paceLagMs`). */
  paceLagMs?: number;
};

type Terminal = { readonly status: CaseStatus; readonly reason: string; readonly blocksAll: boolean };

/** H1 refusals that mean no model is behind voice on this desk. */
const NO_RUNTIME_CODES = new Set(["gateway_blocked", "voice_model_unavailable", "voice_disabled"]);

function terminalFor(error: unknown): Terminal | { readonly failedCheck: string } {
  if (error instanceof SkipCase) {
    return { status: error.status, reason: error.reason, blocksAll: false };
  }
  if (error instanceof H1Refused) {
    const reason = `H1 refused the session: ${error.status} ${error.code}${error.message && error.message !== error.code ? ` (${error.message})` : ""}`;
    if (NO_RUNTIME_CODES.has(error.code)) {
      return { status: CASE_STATUS.blocked, reason, blocksAll: true };
    }
    if (error.code === "voice_session_limit") {
      return {
        status: CASE_STATUS.transient,
        reason: `${reason}; another voice session is open for this person or the process is at its cap`,
        blocksAll: false,
      };
    }
    return { status: CASE_STATUS.error, reason, blocksAll: false };
  }
  if (error instanceof WaitTimeout || error instanceof SocketClosed) {
    return { failedCheck: error.message };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { status: CASE_STATUS.transient, reason: `a request timed out: ${error.message}`, blocksAll: false };
  }
  return { status: CASE_STATUS.error, reason: error instanceof Error ? error.message : String(error), blocksAll: false };
}

function summarizeChecks(runs: readonly RunOutcome[], extra: readonly Check[]): CheckSummary[] {
  const byName = new Map<string, { passed: number; failed: number; detail: string | null }>();
  const add = (check: Check): void => {
    const entry = byName.get(check.name) ?? { passed: 0, failed: 0, detail: null };
    if (check.ok) {
      entry.passed += 1;
      entry.detail ??= check.detail ?? null;
    } else {
      // The first failing run's detail wins over a passing run's.
      entry.detail = entry.failed === 0 ? (check.detail ?? null) : entry.detail;
      entry.failed += 1;
    }
    byName.set(check.name, entry);
  };
  for (const run of runs) {
    for (const check of run.checks) {
      add(check);
    }
  }
  for (const check of extra) {
    add(check);
  }
  return [...byName].map(([name, entry]) => ({ name, ...entry }));
}

function summarizeNumbers(runs: readonly RunOutcome[]): Record<string, NumberSummary> {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.numbers)))];
  return Object.fromEntries(keys.map((key) => [key, summarize(runs.map((run) => run.numbers[key] ?? null))]));
}

function collectNotes(runs: readonly RunOutcome[]): Record<string, NoteValue[]> {
  const keys = [...new Set(runs.flatMap((run) => Object.keys(run.notes)))];
  return Object.fromEntries(keys.map((key) => [key, runs.map((run) => run.notes[key] ?? null)]));
}

export async function runCases(input: RunnerInput): Promise<{ rows: CaseRow[]; cleanup: VoiceRunFile["cleanup"] }> {
  const log = input.log ?? (() => undefined);
  const table = input.cases ?? CASES;
  const selected = table.filter((item) => input.caseIds.includes(item.id));
  const threads: string[] = [];
  const rows: CaseRow[] = [];
  let blockedBy: string | null = null;

  const base = {
    client: input.client,
    clock: input.clock,
    fixtures: input.fixtures,
    settings: input.settings,
    policy: input.policy,
    paceLagMs: input.paceLagMs ?? TIMING.paceLagMs,
    async newThread() {
      const id = await input.client.createThread();
      threads.push(id);
      return id;
    },
    messages: (threadId: string) => input.client.readMessages(threadId),
  };

  async function runOnce(def: VoiceCase): Promise<{ outcome: RunOutcome; terminal: Terminal | null }> {
    const recorder = createRecorder();
    const opened: VoiceSession[] = [];
    const context: CaseContext = {
      ...base,
      async open(options) {
        const threadId = options?.threadId ?? (await base.newThread());
        const info = await input.client.startSession(threadId, options?.mode);
        try {
          const session = await input.client.connect(info);
          opened.push(session);
          return session;
        } catch (error) {
          await input.client.endSession(info.sessionId).catch(() => undefined);
          throw error;
        }
      },
    };

    let terminal: Terminal | null = null;
    let timer: { cancel(): void } | null = null;
    try {
      const guard = new Promise<never>((_, reject) => {
        timer = input.clock.after(input.runMs ?? TIMING.runMs, () =>
          reject(new Error(`the run did not finish within ${Math.round((input.runMs ?? TIMING.runMs) / 1000)} s`)),
        );
      });
      const work = def.run(context, recorder);
      work.catch(() => undefined);
      await Promise.race([work, guard]);
    } catch (error) {
      const verdict = terminalFor(error);
      if ("failedCheck" in verdict) {
        recorder.check(verdict.failedCheck, false);
      } else {
        terminal = verdict;
      }
    } finally {
      (timer as { cancel(): void } | null)?.cancel();
      await Promise.all(opened.map((session) => session.end().catch(() => undefined)));
    }
    return { outcome: recorder.outcome(), terminal };
  }

  for (const [at, def] of selected.entries()) {
    const startedAt = input.clock.now();
    const row = (fields: Pick<CaseRow, "status" | "reason"> & Partial<CaseRow>): CaseRow => ({
      id: def.id,
      title: def.title,
      runs: 0,
      passedRuns: 0,
      checks: [],
      numbers: {},
      notes: {},
      wallMs: Math.round(input.clock.now() - startedAt),
      ...fields,
    });

    if (blockedBy) {
      rows.push(row({ status: CASE_STATUS.blocked, reason: `not run: ${blockedBy}` }));
      log(`[${at + 1}/${selected.length}] ${def.id}: ${CASE_STATUS.blocked} (not run)`);
      continue;
    }
    if (def.needsThinker && input.settings.runtime === "stub") {
      rows.push(row({ status: CASE_STATUS.skipped, reason: "the desk runs the stub runtime (no gateway key), so the thinker cannot answer" }));
      log(`[${at + 1}/${selected.length}] ${def.id}: ${CASE_STATUS.skipped}`);
      continue;
    }

    const total = def.repeatable ? input.repeat : 1;
    const outcomes: RunOutcome[] = [];
    let terminal: Terminal | null = null;
    for (let run = 0; run < total; run += 1) {
      log(`[${at + 1}/${selected.length}] ${def.id}${total > 1 ? ` run ${run + 1}/${total}` : ""} ...`);
      const result = await runOnce(def);
      outcomes.push(result.outcome);
      if (result.terminal) {
        terminal = result.terminal;
        break;
      }
    }

    if (terminal) {
      if (terminal.blocksAll) {
        blockedBy = terminal.reason;
      }
      rows.push(
        row({
          status: terminal.status,
          reason: terminal.reason,
          runs: outcomes.length,
          checks: summarizeChecks(outcomes, []),
          numbers: summarizeNumbers(outcomes),
          notes: collectNotes(outcomes),
        }),
      );
      log(`    ${terminal.status}: ${terminal.reason}`);
      continue;
    }

    const judged = def.judge ? def.judge(outcomes) : [];
    const passedRuns = outcomes.filter((outcome) => outcome.checks.every((check) => check.ok)).length;
    const ok = passedRuns === outcomes.length && judged.every((check) => check.ok);
    rows.push(
      row({
        status: ok ? CASE_STATUS.pass : CASE_STATUS.fail,
        reason: null,
        runs: outcomes.length,
        passedRuns,
        checks: summarizeChecks(outcomes, judged),
        numbers: summarizeNumbers(outcomes),
        notes: collectNotes(outcomes),
      }),
    );
    log(`    ${ok ? CASE_STATUS.pass : CASE_STATUS.fail} in ${Math.round(input.clock.now() - startedAt)} ms`);
  }

  let cleanup: VoiceRunFile["cleanup"] = null;
  if (input.cleanup) {
    let deleted = 0;
    let failed = 0;
    for (const id of threads) {
      const gone = await input.client.deleteThread(id).catch(() => false);
      if (gone) {
        deleted += 1;
      } else {
        failed += 1;
      }
    }
    cleanup = { threads: threads.length, deleted, failed };
  }
  return { rows, cleanup };
}
