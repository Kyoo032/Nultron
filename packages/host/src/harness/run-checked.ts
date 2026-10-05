/**
 * The generic stop gate: a mode is done when its checks pass, never when the model says so.
 *
 * `produce` makes the output, every check looks at it, and a failure goes back to `produce` as an
 * ERROR / WHY / FIX note for at most `repairRounds` more tries. The note is English and fixed; the
 * caller's own prompt carries the output language. Finance and Legal keep their own repair loops.
 */
import type { CheckVerdict, OutputCheck } from "@agentforge/core/harness";

export type FailedVerdict = Extract<CheckVerdict, { readonly ok: false }>;

export type RunCheckedOptions<T> = {
  /** `repairNote` is null on the first call. `round` is 0 for it, then 1, 2, ... for each repair. */
  readonly produce: (repairNote: string | null, round: number) => Promise<T>;
  readonly checks: readonly OutputCheck<T>[];
  readonly repairRounds: number;
  readonly signal?: AbortSignal;
  /** Called before each repair `produce`, with that repair's round number and the failures behind it. */
  readonly onRound?: (round: number, failures: FailedVerdict[]) => void | Promise<void>;
};

export type RunCheckedResult<T> = {
  /** The last output made, passing or not. */
  readonly output: T;
  /** One verdict per check, from the last check pass, in check order. */
  readonly verdicts: CheckVerdict[];
  /** Repair rounds spent. 0 when the first output passed. */
  readonly rounds: number;
  readonly passed: boolean;
};

const NOTE_HEADER =
  "The output did not pass these checks. Fix every item and return the whole corrected output, not a diff.";

export function formatRepairNote(verdicts: readonly FailedVerdict[]): string {
  if (verdicts.length === 0) {
    return "";
  }
  const blocks = verdicts.map((verdict) => `ERROR: ${verdict.error}\nWHY: ${verdict.why}\nFIX: ${verdict.fix}`);
  return [NOTE_HEADER, ...blocks].join("\n\n");
}

function isFailed(verdict: CheckVerdict): verdict is FailedVerdict {
  return !verdict.ok;
}

/** A check that throws failed to confirm the output, so it counts as a failure. Its message may quote the output, so it is not passed on. */
async function runOne<T>(check: OutputCheck<T>, output: T, signal?: AbortSignal): Promise<CheckVerdict> {
  try {
    return await check.run(output);
  } catch {
    signal?.throwIfAborted();
    return {
      ok: false,
      check: check.id,
      error: `Check "${check.id}" could not run.`,
      why: "The check failed on its own, so this output could not be confirmed.",
      fix: "Return the whole output again, complete and in the required format.",
    };
  }
}

async function runAll<T>(checks: readonly OutputCheck<T>[], output: T, signal?: AbortSignal): Promise<CheckVerdict[]> {
  const verdicts: CheckVerdict[] = [];
  for (const check of checks) {
    verdicts.push(await runOne(check, output, signal));
  }
  return verdicts;
}

export async function runChecked<T>(opts: RunCheckedOptions<T>): Promise<RunCheckedResult<T>> {
  let note: string | null = null;
  let round = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    const output = await opts.produce(note, round);
    const verdicts = await runAll(opts.checks, output, opts.signal);
    const failures = verdicts.filter(isFailed);
    if (failures.length === 0 || round >= opts.repairRounds) {
      return { output, verdicts, rounds: round, passed: failures.length === 0 };
    }
    round += 1;
    await opts.onRound?.(round, failures);
    note = formatRepairNote(failures);
  }
}
