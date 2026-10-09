/**
 * Figures: reading the amounts in a text and checking that the ones a model wrote are ones the evidence
 * states.
 *
 * It uses the Finance guard's reader (`extractNumbers`, so `Rp 1.500.000.000` and `USD 5,000,000` and
 * `4.804` read the way Finance reads them), the same magnitude words (`expandMagnitudes`: `1,5 miliar`,
 * `2.5 million`), and the currency and unit reading of `stated-facts`. Clause references such as `§7.2`,
 * `Pasal 15` and `Section 12.3` are blanked first, and so are dates and clock times, because none of them
 * is a figure. Dates are traced by `datesTraced`. Pure; no model call.
 */
import { expandMagnitudes } from "../../finance/magnitude";
import { type NumberToken, extractNumbers, isFreeNumber, matchesAllowed } from "../../finance/number-guard";
import { CONTEXT_CHARS, type StatedFactUnit, currencyOf, unitOf } from "../../finance/stated-facts";
import { maskXrefs } from "../../legal/verify-text";
import type { AppLocale } from "../../locale";
import { maskDateTimes } from "./dates";

export { extractNumbers, isFreeNumber, matchesAllowed, type NumberToken };

/** What a figure measures, read from the words around it. A bare figure is `number`. */
export type AmountUnit = StatedFactUnit;

/**
 * `exact`: the two figures are the same number (floating-point noise aside). `rounded`: the Finance
 * guard's tolerance, half a percent, for prose that rounds. Legal judges use `exact`.
 */
export type NumberTolerance = "exact" | "rounded";

export type TraceOptions = { readonly tolerance?: NumberTolerance };

export type Amount = {
  /** The figure as read, after magnitude words were expanded ("Rp 1500000000" for "Rp 1,5 miliar"). */
  readonly text: string;
  readonly value: number;
  /** The other reading of an ambiguous "4.804": 4,804 (grouped) or 4.804 (decimal). Either may trace. */
  readonly alternate?: number;
  readonly unit: AmountUnit;
  /** ISO-style code ("IDR", "USD") when the text marks one, else "". */
  readonly currency: string;
  /** A small count ("3 parties") or a calendar year: never needs a trace. */
  readonly free: boolean;
};

export type NumbersTrace = {
  /** Every figure in the claim that needs a trace has one in the evidence. */
  readonly traced: boolean;
  /** The claim's figures the evidence does not state, in claim order. */
  readonly untraced: readonly Amount[];
  /** How many of the claim's figures were looked at (free ones and references are not). */
  readonly checked: number;
};

// -- reading --------------------------------------------------------------------------------------

/** Clause numbering that is not a figure in either language: "Pasal 15", "ayat 2", "Article 17", "Annex 40". */
const CLAUSE_REFERENCE =
  /\b(?:Pasal|Ayat|Bab|Butir|Bagian|Lampiran|Article|Art\.|Annex|Schedule|Appendix|Exhibit|Paragraph|Para\.)\s+\(?\d+(?:\.\d+)*\)?(?:\s*\([a-z0-9]+\))*/gi;

/** Blank every clause reference at equal length: `§7.2`, `Section 12.3`, `Clause 4.1(b)`, `Pasal 15`, `ayat 2`, `Article 17`. */
export function maskClauseReferences(text: string): string {
  return maskXrefs(text).replace(CLAUSE_REFERENCE, (reference) => " ".repeat(reference.length));
}

/**
 * `expandMagnitudes` leaves "dan 5 juta" and "of 18.4B" alone: a word of four letters or fewer right before the
 * figure is read as a currency it does not know, and the whole token is given back untouched. Currency words
 * keep their space; any other short word gets a line break instead, which the figure can start after.
 */
const SHORT_WORD_BEFORE_FIGURE = /\b(?!(?:rp|idr|usd|eur|gbp|sgd|jpy)\b)([A-Za-z]{1,4})[ \t]+(?=-?\d)/gi;

function separateShortWords(text: string): string {
  return text.replace(SHORT_WORD_BEFORE_FIGURE, "$1\n");
}

/**
 * Every figure the text states, in order. Dates, clock times and clause references are not figures. Money
 * carries its currency; a magnitude word is expanded by the run locale (`M` is a million in English and a
 * billion in Indonesian).
 */
export function amountsIn(text: string, locale: AppLocale): Amount[] {
  const prepared = separateShortWords(maskDateTimes(maskClauseReferences(text)));
  const expanded = expandMagnitudes(prepared, locale);
  return extractNumbers(expanded).map((token) => {
    const before = expanded.slice(Math.max(0, token.index - CONTEXT_CHARS), token.index);
    const afterAt = token.index + token.text.length;
    const after = expanded.slice(afterAt, afterAt + CONTEXT_CHARS);
    return {
      text: token.text,
      value: token.value,
      ...(token.alternate === undefined ? {} : { alternate: token.alternate }),
      unit: unitOf(before, after, token),
      currency: currencyOf(before, token.text),
      free: isFreeNumber(token),
    };
  });
}

// -- tracing --------------------------------------------------------------------------------------

const EXACT_RELATIVE_TOLERANCE = 1e-9;

function readingsOf(amount: Amount): number[] {
  return amount.alternate === undefined ? [amount.value] : [amount.value, amount.alternate];
}

function sameNumber(left: number, right: number, tolerance: NumberTolerance): boolean {
  if (tolerance === "rounded") {
    return matchesAllowed(left, [right]);
  }
  return Math.abs(left - right) <= EXACT_RELATIVE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Do two figures state the same thing? Some reading of each must be the same number. A percentage is only a
 * percentage, a multiple (`2x`) only a multiple, and two currency codes must agree; beyond that an unmarked
 * figure stands for any other (a table cell gives the number and its header gives the unit).
 */
export function amountsMatch(left: Amount, right: Amount, tolerance: NumberTolerance = "exact"): boolean {
  for (const strict of ["percent", "ratio"] as const) {
    if ((left.unit === strict || right.unit === strict) && left.unit !== right.unit) {
      return false;
    }
  }
  if (left.currency !== "" && right.currency !== "" && left.currency !== right.currency) {
    return false;
  }
  return readingsOf(left).some((mine) => readingsOf(right).some((theirs) => sameNumber(mine, theirs, tolerance)));
}

/**
 * Does the evidence state every figure in the claim? Free numbers (small counts, years), dates, clock times
 * and clause references are not looked at. Exact by default; pass `{ tolerance: "rounded" }` for prose that
 * rounds, the way Finance narration does.
 */
export function numbersTraced(
  claim: string,
  evidence: string,
  locale: AppLocale,
  options: TraceOptions = {},
): NumbersTrace {
  const tolerance = options.tolerance ?? "exact";
  const needed = amountsIn(claim, locale).filter((amount) => !amount.free);
  if (needed.length === 0) {
    return { traced: true, untraced: [], checked: 0 };
  }
  const stated = amountsIn(evidence, locale);
  const untraced = needed.filter((amount) => !stated.some((other) => amountsMatch(amount, other, tolerance)));
  return { traced: untraced.length === 0, untraced, checked: needed.length };
}
