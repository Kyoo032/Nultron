/**
 * Shared harness judges: pure checks that every document mode (Legal, Finance, Meeting) uses to decide
 * whether a model's answer is backed by the documents it was given. Import as `@agentforge/core/judges`.
 *
 * INTERFACE FROZEN (2026-10-05, lane L0). Lanes L1 (Legal), L3a (Meeting) and L4a (Finance) build against
 * exactly the names below; `index.test.ts` fails if one is added, renamed or removed, so a change here is
 * always a deliberate, reviewed one.
 *
 * Rules every judge follows:
 *  - pure: no model call, no clock, no file or network access, no mutation of its arguments;
 *  - strict by default: a figure must be the same figure, a date the same day (loosen with the option on
 *    the function, never by reaching into a private helper);
 *  - offsets are into the ORIGINAL text, so a hit can be cited in the source as the user sees it;
 *  - nothing here returns or keeps model output beyond what the caller passes back in: `summarizeVerdicts`
 *    keeps ids and pass/fail only.
 *
 * What lives where:
 *  - `normalise`   one reading of text for matching (PDF line breaks, ligatures, NBSP, curly quotes, page markers);
 *  - `quote`       is this quote in the sources, and where (exact, normalised, case-folded, elided);
 *  - `numbers`     amounts in a text, and do the claim's figures appear in the evidence;
 *  - `dates`       dates, clock times and durations, and do the claim's appear in the evidence;
 *  - `conflicts`   two different values for the same key;
 *  - `coverage`    required fields or files with no answer;
 *  - `scope`       advice, and law the sources never cite;
 *  - `verdict`     per-item judgements turned into an `OutputCheck` for `runChecked`, and into item statuses.
 */

// -- normalise ------------------------------------------------------------------------------------
export { normaliseForMatch, type NormaliseOptions, type Normalised } from "./normalise";

// -- quote ----------------------------------------------------------------------------------------
export {
  DEFAULT_WINDOW_CHARS,
  ELIDED_GAP_MAX_CHARS,
  ELIDED_PART_MIN_CHARS,
  QUOTE_MIN_CHARS,
  createQuoteIndex,
  matchQuote,
  windowAround,
  type QuoteIndex,
  type QuoteMatch,
  type QuoteMode,
  type QuoteSource,
} from "./quote";

// -- numbers --------------------------------------------------------------------------------------
export {
  amountsIn,
  extractNumbers,
  isFreeNumber,
  maskClauseReferences,
  matchesAllowed,
  numbersTraced,
  type Amount,
  type AmountUnit,
  type NumberToken,
  type NumberTolerance,
  type NumbersTrace,
  type TraceOptions,
} from "./numbers";

// -- dates ----------------------------------------------------------------------------------------
export {
  datesTraced,
  durationMonths,
  findDateTimeMentions,
  isoDateOf,
  isoDatesOf,
  maskDateTimes,
  sameDate,
  type DateTimeMention,
  type DatesTrace,
  type DatesTraceOptions,
} from "./dates";

// -- conflicts ------------------------------------------------------------------------------------
export {
  findConflicts,
  type Conflict,
  type ConflictFact,
  type ConflictKind,
  type ConflictOptions,
  type ConflictValue,
} from "./conflicts";

// -- coverage -------------------------------------------------------------------------------------
export { coverageGaps, hasCoverageGaps, type CoverageGaps, type CoverageItem } from "./coverage";

// -- scope ----------------------------------------------------------------------------------------
export { scopeHits, type ScopeHit, type ScopeSource } from "./scope";

// -- verdict --------------------------------------------------------------------------------------
export {
  failingIds,
  judgeCheck,
  outcomeOf,
  outcomesById,
  summarizeVerdicts,
  type ItemJudgement,
  type ItemOutcome,
  type JudgeCheckOptions,
  type JudgeWords,
  type VerdictSummary,
} from "./verdict";
