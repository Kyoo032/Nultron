/**
 * Checks that remember which model call each failing item came from, so the one repair goes only to the
 * calls that need it, with a note that names only that call's failures. Both the extraction and the ask
 * route read a matter in one or more calls and use this.
 *
 * A check is a judge (`output -> item judgements`) plus the fixed English words of its repair note. The
 * checks plug into `runChecked`; `judgements()` after the run is every judgement of the last pass, which is
 * what gives each item its final status. Nothing here keeps model text beyond what a judgement's `problem`
 * carries into the repair note.
 */
import type { CheckVerdict, OutputCheck } from "@agentforge/core/harness";
import { type ItemJudgement, type JudgeWords, judgeCheck } from "@agentforge/core/judges";
import { formatRepairNote } from "../harness/run-checked";

/** A judgement that knows which call its item came from. */
export type Judged = ItemJudgement & { readonly call: number };

export type CheckDef<T> = {
  readonly id: string;
  readonly words: JudgeWords;
  judge(output: T): Judged[];
};

export type CallChecks<T> = {
  readonly checks: readonly OutputCheck<T>[];
  /** Every judgement of the latest pass of every check, in check order. */
  judgements(): readonly Judged[];
  /** The failures of the latest pass, by the call that produced the item. */
  failuresByCall(): ReadonlyMap<number, readonly Judged[]>;
  /** The ERROR / WHY / FIX note for one call's failures only, or null when it has none. */
  repairNoteFor(call: number): Promise<string | null>;
};

/**
 * `labelFor` turns an item id into words the model can find in its own answer (`payment in S1`, `red flag "Uncapped"`).
 * The ids code makes (`flag:S1:3fa2c1d0`) mean nothing to it, and a repair note it cannot match to an item is half wasted.
 */
export function createCallChecks<T>(
  defs: readonly CheckDef<T>[],
  labelFor: (id: string) => string = (id) => id,
): CallChecks<T> {
  const latest = new Map<string, readonly Judged[]>();
  const checks = defs.map((def) =>
    judgeCheck<T>(def.id, (output) => def.judge(output), def.words, {
      onJudged: (judgements) => latest.set(def.id, judgements as readonly Judged[]),
    }),
  );
  const all = (): Judged[] => defs.flatMap((def) => latest.get(def.id) ?? []);
  return {
    checks,
    judgements: all,
    failuresByCall() {
      const byCall = new Map<number, Judged[]>();
      for (const judgement of all()) {
        if (!judgement.ok) {
          byCall.set(judgement.call, [...(byCall.get(judgement.call) ?? []), judgement]);
        }
      }
      return byCall;
    },
    async repairNoteFor(call) {
      const verdicts: Extract<CheckVerdict, { ok: false }>[] = [];
      for (const def of defs) {
        const failing = (latest.get(def.id) ?? []).filter((judgement) => judgement.call === call && !judgement.ok);
        if (failing.length > 0) {
          // The same words and the same layout as a failed check on the whole answer, for this call's items only.
          const named = failing.map((judgement) => ({ ...judgement, id: labelFor(judgement.id) }));
          const verdict = await judgeCheck<null>(def.id, () => named, def.words).run(null);
          if (!verdict.ok) {
            verdicts.push(verdict);
          }
        }
      }
      return verdicts.length === 0 ? null : formatRepairNote(verdicts);
    },
  };
}
