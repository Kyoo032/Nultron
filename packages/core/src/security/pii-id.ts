/**
 * Indonesian identifiers for the shared PII scanner.
 *
 * One rule shapes every detector in this file: **money is never masked.** A Finance prompt is mostly
 * long digit runs — a rupiah total is routinely 10 to 16 digits — so a detector may only fire when
 * the text carries something an amount cannot have: a NIK's embedded birth date, an NPWP's dotted
 * shape, the leading `0` of an `08xx` phone, a bank-style structure, or a label/bank cue beside
 * the number.
 */

export type IdPiiKind = "nik" | "npwp" | "account" | "phone";

export type IdPiiMatch = { kind: IdPiiKind; match: string; index: number };

/**
 * BPS province codes (the 38 provinces). The narrow list, rather than the whole 11–94 range the
 * format allows, is what keeps a 16-digit rupiah total out of the NIK detector: only 38 of the 100
 * leading pairs can open one. `99` is reserved for synthetic fixtures so no test ever needs a real
 * person's number.
 */
export const ID_PROVINCE_CODES: ReadonlySet<string> = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "21",
  "31", "32", "33", "34", "35", "36",
  "51", "52", "53",
  "61", "62", "63", "64", "65",
  "71", "72", "73", "74", "75", "76",
  "81", "82",
  "91", "92", "93", "94", "95", "96",
  "99",
]);

/** Longest day each month can hold; February is leap-tolerant because a NIK carries no century. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** A woman's NIK adds 40 to the birth day, which is the only reason day 41–71 is legal. */
const FEMALE_DAY_OFFSET = 40;

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Luhn checksum — shared with the card detector so unlabelled account detection never steals a PAN. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

const CARD_PREFIX_RE = /^(?:4|5[1-5]|2[2-7]|34|37|6011|64[4-9]|65|35|30[0-5]|36|3[89]|62)/;
const CARD_ROUND_TAIL_RE = /0{4}$/;

function looksLikeCard(raw: string, digits: string): boolean {
  if (!passesLuhn(digits)) {
    return false;
  }
  if (/[ -]/.test(raw)) {
    return true;
  }
  return CARD_PREFIX_RE.test(digits) && !CARD_ROUND_TAIL_RE.test(digits);
}

/**
 * `PPRRDD DDMMYY NNNN` with every field in range.
 *
 * `labelled` is set when the text already named the number ("NIK: …"). An unlabelled run has to earn
 * the finding on structure alone, so it is refused when the last four digits are a round thousand —
 * that is the shape of a rupiah total, not of a registration serial (which runs 0001–9999).
 */
export function isNikDigits(digits: string, options: { labelled?: boolean } = {}): boolean {
  if (!/^\d{16}$/.test(digits)) {
    return false;
  }
  if (!ID_PROVINCE_CODES.has(digits.slice(0, 2))) {
    return false;
  }
  if (Number(digits.slice(2, 4)) === 0 || Number(digits.slice(4, 6)) === 0) {
    return false;
  }
  const rawDay = Number(digits.slice(6, 8));
  const day = rawDay > FEMALE_DAY_OFFSET ? rawDay - FEMALE_DAY_OFFSET : rawDay;
  const month = Number(digits.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
    return false;
  }
  const serial = Number(digits.slice(12));
  if (serial === 0) {
    return false;
  }
  return options.labelled === true || serial % 1000 !== 0;
}

/** NPWP is 15 digits (classic) or 16 (the NIK-shaped one). There is no published checksum to lean on. */
export function isNpwpDigits(digits: string): boolean {
  return /^\d{15}$/.test(digits) || /^\d{16}$/.test(digits);
}

/** `NN.NNN.NNN.N-NNN.NNN` — a shape no amount is ever written in, so it needs no label. */
const NPWP_DOTTED_RE = /\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g;

/** A bare 16-digit run, never one cut out of a longer number or out of a separated amount. */
const NIK_BARE_RE = /(?<![\d.,-])\d{16}(?![\d.,-])/g;

/**
 * Words that make the next number an amount. A 16-digit run with no label passes the structure test
 * about 2.5% of the time by chance, so the text right before it gets a veto: `Total: 1234...` is a
 * ledger sum whatever its digits happen to spell. (A run ending in three zeros — how a rupiah total
 * is nearly always written — can never pass at all: its serial field would be a round thousand.)
 */
const MONEY_CUE_RE =
  /(?:rp|idr|usd|eur|sgd|myr|total|subtotal|jumlah|saldo|nilai|amount|balance|omzet|omset|kas|sum|[$€£¥])\s*[:=]?\s*$/i;

/** How far back the money veto looks. One short cue plus its punctuation, never a whole sentence. */
const MONEY_CUE_LOOKBACK = 24;

/**
 * `08xx` local mobile numbers. The leading `0` is the whole safety argument: no amount starts with
 * one, and the lookbehind stops `1.081.250.000` from donating an `081` to the match.
 */
const LOCAL_PHONE_RE = /(?<![\d.,-])08\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g;

const NIK_LABELLED_RE = /\b(?:nik|no\.?\s*ktp|nomor\s*ktp|ktp)\b\s*(?:no\.?|nomor)?\s*[:#=-]?\s*(\d[\d\s.-]{14,26})/gi;

const NPWP_LABELLED_RE = /\bnpwp\b\s*(?:no\.?|nomor)?\s*[:#=-]?\s*(\d[\d\s.-]{13,26})/gi;

const INLINE_SPACE_CLASS = " \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff";
const HORIZONTAL_SPACE_CLASS = `\\t${INLINE_SPACE_CLASS}`;
const LINE_BREAK_PART = "(?:\\r?\\n|[\\v\\f\\u0085\\u2028\\u2029])";
const SINGLE_WRAP_SPACE_PART = `(?:[${HORIZONTAL_SPACE_CLASS}]*${LINE_BREAK_PART}[${HORIZONTAL_SPACE_CLASS}]*|[${HORIZONTAL_SPACE_CLASS}]+)`;

const MULTI_WORD_BANK_NAMES = [
  ["CIMB", "Niaga"],
  ["OCBC", "NISP"],
] as const;

const MULTI_WORD_BANK_PATTERN = MULTI_WORD_BANK_NAMES.map(
  ([first, second]) => `${first}(?:${SINGLE_WRAP_SPACE_PART}${second})?`,
).join("|");

const BANK_NAME_PART =
  `(?:BCA|BRI|BNI|Mandiri|BSI|Permata|Danamon|BTN|Panin|Maybank|Mega|UOB|HSBC|Citibank|Jago|SeaBank|Jenius|Blu|${MULTI_WORD_BANK_PATTERN})`;

const ACCOUNT_LABEL_PART =
  `(?:no\\.?[${HORIZONTAL_SPACE_CLASS}]*rek(?:ening)?|nomor[${HORIZONTAL_SPACE_CLASS}]*rek(?:ening)?|norek|rekening|a\\/c|acct\\.?|account(?:[${HORIZONTAL_SPACE_CLASS}]*(?:no\\.?|number|#))?)`;

const ACCOUNT_LABELLED_RE = new RegExp(
  `\\b(?:no\\.?[${HORIZONTAL_SPACE_CLASS}]*rek(?:ening)?|nomor[${HORIZONTAL_SPACE_CLASS}]*rek(?:ening)?|norek|rekening|a\\/c|acct\\.?|account[${HORIZONTAL_SPACE_CLASS}]*(?:no\\.?|number|#))(?:[${HORIZONTAL_SPACE_CLASS}]+${BANK_NAME_PART})?[${HORIZONTAL_SPACE_CLASS}]*[:#=-]?(?:[${HORIZONTAL_SPACE_CLASS}]*${LINE_BREAK_PART}[${HORIZONTAL_SPACE_CLASS}]*|[${HORIZONTAL_SPACE_CLASS}]*)(\\d(?:[${INLINE_SPACE_CLASS}-]?\\d){7,23})(?!\\d)`,
  "gi",
);

const IBAN_LABELLED_RE =
  /\biban\b\s*[:#=-]?\s*([A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,4})?)\b/gi;

const IBAN_BARE_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;

const ACCOUNT_CUE_LOOKBACK = 80;
const BOUNDED_GAP_PART = `(?:[^${HORIZONTAL_SPACE_CLASS},:#=;|!?\\r\\n\\v\\f\\u0085\\u2028\\u2029]+[${HORIZONTAL_SPACE_CLASS},:#=-]+){0,4}`;
const EXPLICIT_ACCOUNT_GAP_CUE_RE = new RegExp(
  `\\b${ACCOUNT_LABEL_PART}[${HORIZONTAL_SPACE_CLASS},:#=-]+(${BOUNDED_GAP_PART})$`,
  "i",
);
const BANK_GAP_CUE_RE = new RegExp(
  `\\b(?:${BANK_NAME_PART}|iban)[${HORIZONTAL_SPACE_CLASS},:#=-]+(${BOUNDED_GAP_PART})$`,
  "i",
);
const TRANSFER_VERB_PART = "(?:transfer|trf|kirim|wire|remit|send|setor)";
const PAYMENT_VERB_PART = "(?:bayar|pay)";
const TRANSFER_ACTION_PART = `(?:${TRANSFER_VERB_PART}|${PAYMENT_VERB_PART})`;
const TRANSFER_EVIDENCE_RE = new RegExp(
  `\\b${TRANSFER_VERB_PART}\\b|\\b${PAYMENT_VERB_PART}[${HORIZONTAL_SPACE_CLASS}]+(?:ke|to)\\b`,
  "i",
);
const TRANSFER_CUE_RE = new RegExp(
  `(?:\\b${TRANSFER_ACTION_PART}(?:[${HORIZONTAL_SPACE_CLASS}]+(?:ke|to|via|dari|from))?[${HORIZONTAL_SPACE_CLASS},:#=-]+(${BOUNDED_GAP_PART})(?:ke|to)[${HORIZONTAL_SPACE_CLASS},:#=-]*$` +
    `|\\b${TRANSFER_ACTION_PART}[${HORIZONTAL_SPACE_CLASS}]+(?:ke|to|via|dari|from)[${HORIZONTAL_SPACE_CLASS},:#=-]+$` +
    `|\\bvia[${HORIZONTAL_SPACE_CLASS}]+(?:bank[${HORIZONTAL_SPACE_CLASS}]+)?(?:ke|to|no\\.?|nomor)?[${HORIZONTAL_SPACE_CLASS},:#=-]{0,20}$` +
    `|\\bke[${HORIZONTAL_SPACE_CLASS}]+rek\\.?[${HORIZONTAL_SPACE_CLASS},:#=-]*$)`,
  "i",
);
const LEDGER_ACCOUNT_VETO_RE =
  /\b(?:accounts?\s+(?:payable|receivable)|rekening\s+(?:bank|koran))\b\s*[:#=-]?\s*$/i;
const NON_TRANSFER_KE_TO_RE =
  /\b(?:up|equal|close|rose|grew|fell|dropped|increased|decreased|naik|turun|meningkat|menurun|mencapai|sampai)\s+(?:ke|to)\s*[:#=-]?\s*$/i;
const GAP_VETO_RE =
  /\b(?:payable|receivable|balance|saldo|total|subtotal|jumlah|nilai|amount|revenue|pendapatan|profit|laba|loss|rugi|expense|expenses|beban|biaya|budget|anggaran|omzet|omset|kas|cash|equity|ekuitas|asset|assets|aset|liability|liabilities|liabilitas|utang|piutang|hutang|modal|koran|tax|pajak|margin|ebit|ebitda|gdp|cap|volume|price|harga|rate|tarif|fee|invoice|faktur)\b/i;
const COLUMN_OR_NUMERIC_GAP_VETO_RE = new RegExp(`\\t|[${INLINE_SPACE_CLASS}]{2,}|\\d{6,}`);
const BANK_ACCOUNT_CONTEXT_RE = /\b(?:rek(?:ening)?|norek|a\/c|acct\.?|accounts?)\b/i;
const CURRENCY_OR_SCALE_AFTER_RE = new RegExp(
  `^[${INLINE_SPACE_CLASS}]?(?:rupiah|rp|idr|usd|dollars?|sgd|euros?|eur|myr|jpy|gbp|aud|cny|rmb|juta|miliar|milyar|ribu|triliun|thousand|million|billion|trillion)\\b`,
  "i",
);

function hasExplicitAmountTail(afterRaw: string): boolean {
  return (
    CURRENCY_OR_SCALE_AFTER_RE.test(afterRaw) ||
    ((afterRaw.startsWith(".") || afterRaw.startsWith(",")) && /\d/.test(afterRaw[1] ?? ""))
  );
}

const UNLABELLED_ACCOUNT_RE = new RegExp(
  `(?<![\\d.,-])(\\d(?:[${INLINE_SPACE_CLASS}-]?\\d){7,20})(?![\\d-])`,
  "g",
);
const ROUND_TOTAL_TAIL_RE = /0{4}$/;
const GROUPED_THOUSANDS_SPACE_RE = new RegExp(`^\\d{1,3}(?:[${INLINE_SPACE_CLASS}]\\d{3})+$`);
const WRAPPED_BANK_BREAK_RE = new RegExp(`[${HORIZONTAL_SPACE_CLASS}]*${LINE_BREAK_PART}[${HORIZONTAL_SPACE_CLASS}]*`);
const WRAPPED_BANK_NAME_RE = new RegExp(
  `\\b(?:${MULTI_WORD_BANK_NAMES.map(
    ([first, second]) => `${first}${WRAPPED_BANK_BREAK_RE.source}${second}`,
  ).join("|")})\\b`,
  "gi",
);
const WRAPPED_CUE_NEWLINE_RE = new RegExp(
  `([^\\n\\v\\f\\u0085\\u2028\\u2029])${LINE_BREAK_PART}[${HORIZONTAL_SPACE_CLASS}]*$`,
);
const LOCAL_PHONE_PREFIX_RE = new RegExp(`^0\\d{2,3}[${INLINE_SPACE_CLASS}-]`);
const BANK_HYPHEN_GROUPING_RE = /^[1-9]\d{1,3}(?:-\d{2,7}){2,3}$/;
const US_PHONE_HYPHEN_RE = /^\d{3}-\d{3}-\d{4}$/;
const SSN_HYPHEN_RE = /^\d{3}-\d{2}-\d{4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ACCOUNT_MIN_DIGITS = 8;
const ACCOUNT_MAX_DIGITS = 20;
const TRANSFER_ACCOUNT_MIN_DIGITS = 9;
const UNLABELLED_ACCOUNT_MIN_DIGITS = 10;
const UNLABELLED_ACCOUNT_MAX_DIGITS = 16;
const LOCAL_PHONE_MIN_DIGITS = 10;
const LOCAL_PHONE_MAX_DIGITS = 13;

function matchAccountCueBefore(clauseBefore: string): { hasCue: boolean; minDigits: number; canWrap: boolean } {
  if (LEDGER_ACCOUNT_VETO_RE.test(clauseBefore)) {
    return { hasCue: false, minDigits: UNLABELLED_ACCOUNT_MIN_DIGITS, canWrap: false };
  }
  const explicitMatch = EXPLICIT_ACCOUNT_GAP_CUE_RE.exec(clauseBefore);
  const explicitGap = explicitMatch?.[1] ?? "";
  if (explicitMatch && !GAP_VETO_RE.test(explicitGap) && !COLUMN_OR_NUMERIC_GAP_VETO_RE.test(explicitGap)) {
    return { hasCue: true, minDigits: ACCOUNT_MIN_DIGITS, canWrap: true };
  }
  const bankMatch = BANK_GAP_CUE_RE.exec(clauseBefore);
  const bankGap = bankMatch?.[1] ?? "";
  const bankHasAccountContext = BANK_ACCOUNT_CONTEXT_RE.test(bankGap);
  if (
    bankMatch &&
    (bankGap.length === 0 || bankHasAccountContext) &&
    !GAP_VETO_RE.test(bankGap) &&
    !COLUMN_OR_NUMERIC_GAP_VETO_RE.test(bankGap)
  ) {
    return {
      hasCue: true,
      minDigits: TRANSFER_ACCOUNT_MIN_DIGITS,
      canWrap: bankHasAccountContext || TRANSFER_EVIDENCE_RE.test(clauseBefore),
    };
  }
  if (!NON_TRANSFER_KE_TO_RE.test(clauseBefore)) {
    const transferMatch = TRANSFER_CUE_RE.exec(clauseBefore);
    if (transferMatch && !GAP_VETO_RE.test(transferMatch[1] ?? "")) {
      return { hasCue: true, minDigits: TRANSFER_ACCOUNT_MIN_DIGITS, canWrap: true };
    }
  }
  return { hasCue: false, minDigits: UNLABELLED_ACCOUNT_MIN_DIGITS, canWrap: false };
}

function isValidIbanShape(raw: string): boolean {
  const compact = raw.replace(/\s+/g, "");
  return compact.length >= 15 && compact.length <= 34 && digitsOnly(compact).length >= 10;
}

function overlaps(found: ReadonlyArray<IdPiiMatch>, index: number, length: number): boolean {
  return found.some((item) => index < item.index + item.match.length && index + length > item.index);
}

function add(found: IdPiiMatch[], candidate: IdPiiMatch): void {
  if (candidate.match.length > 0 && !overlaps(found, candidate.index, candidate.match.length)) {
    found.push(candidate);
  }
}

/** The capture group's own span, so masking replaces the number and leaves its label readable. */
function capturedSpan(match: RegExpMatchArray): { text: string; index: number } | null {
  const captured = match[1];
  if (captured === undefined || match.index === undefined) {
    return null;
  }
  const trimmed = captured.trimEnd();
  const offset = match[0].lastIndexOf(captured);
  return offset < 0 ? null : { text: trimmed, index: match.index + offset };
}

function collectLabelled(text: string, found: IdPiiMatch[]): void {
  for (const match of text.matchAll(NIK_LABELLED_RE)) {
    const span = capturedSpan(match);
    if (span && isNikDigits(digitsOnly(span.text), { labelled: true })) {
      add(found, { kind: "nik", match: span.text, index: span.index });
    }
  }
  for (const match of text.matchAll(NPWP_LABELLED_RE)) {
    const span = capturedSpan(match);
    if (span && isNpwpDigits(digitsOnly(span.text))) {
      add(found, { kind: "npwp", match: span.text, index: span.index });
    }
  }
  for (const match of text.matchAll(ACCOUNT_LABELLED_RE)) {
    const span = capturedSpan(match);
    const digits = span ? digitsOnly(span.text) : "";
    const afterSpan = span ? text.slice(span.index + span.text.length) : "";
    if (
      span &&
      digits.length >= ACCOUNT_MIN_DIGITS &&
      digits.length <= ACCOUNT_MAX_DIGITS &&
      !hasExplicitAmountTail(afterSpan)
    ) {
      add(found, { kind: "account", match: span.text, index: span.index });
    }
  }
  for (const match of text.matchAll(IBAN_LABELLED_RE)) {
    const span = capturedSpan(match);
    if (span && isValidIbanShape(span.text)) {
      add(found, { kind: "account", match: span.text, index: span.index });
    }
  }
}

function collectUnlabelled(text: string, found: IdPiiMatch[]): void {
  for (const match of text.matchAll(NPWP_DOTTED_RE)) {
    if (match.index !== undefined) {
      add(found, { kind: "npwp", match: match[0], index: match.index });
    }
  }
  for (const match of text.matchAll(NIK_BARE_RE)) {
    if (match.index === undefined || !isNikDigits(match[0])) {
      continue;
    }
    const before = text.slice(Math.max(0, match.index - MONEY_CUE_LOOKBACK), match.index);
    if (!MONEY_CUE_RE.test(before)) {
      add(found, { kind: "nik", match: match[0], index: match.index });
    }
  }
  for (const match of text.matchAll(LOCAL_PHONE_RE)) {
    const digits = match.index === undefined ? "" : digitsOnly(match[0]);
    if (match.index !== undefined && digits.length >= LOCAL_PHONE_MIN_DIGITS && digits.length <= LOCAL_PHONE_MAX_DIGITS) {
      add(found, { kind: "phone", match: match[0], index: match.index });
    }
  }
  for (const match of text.matchAll(IBAN_BARE_RE)) {
    if (match.index !== undefined && isValidIbanShape(match[0])) {
      add(found, { kind: "account", match: match[0], index: match.index });
    }
  }
  for (const match of text.matchAll(UNLABELLED_ACCOUNT_RE)) {
    if (match.index === undefined) {
      continue;
    }
    const raw = match[1] ?? match[0];
    const digits = digitsOnly(raw);
    if (digits.length < ACCOUNT_MIN_DIGITS || digits.length > UNLABELLED_ACCOUNT_MAX_DIGITS) {
      continue;
    }
    if (
      ROUND_TOTAL_TAIL_RE.test(digits) ||
      GROUPED_THOUSANDS_SPACE_RE.test(raw) ||
      SSN_HYPHEN_RE.test(raw) ||
      ISO_DATE_RE.test(raw)
    ) {
      continue;
    }
    if (isNikDigits(digits) || looksLikeCard(raw, digits) || /^08/.test(digits)) {
      continue;
    }
    const afterRaw = text.slice(match.index + raw.length);
    if (hasExplicitAmountTail(afterRaw)) {
      continue;
    }
    const immediateBefore = text.slice(Math.max(0, match.index - MONEY_CUE_LOOKBACK), match.index);
    if (MONEY_CUE_RE.test(immediateBefore)) {
      continue;
    }
    const cueWindow = text.slice(Math.max(0, match.index - ACCOUNT_CUE_LOOKBACK), match.index);
    const normalizedCueWindow = cueWindow.replace(WRAPPED_BANK_NAME_RE, (wrapped) =>
      wrapped.replace(WRAPPED_BANK_BREAK_RE, " "),
    );
    const wrappedCueWindow = normalizedCueWindow.replace(WRAPPED_CUE_NEWLINE_RE, "$1 ");
    const newlineWrapped = wrappedCueWindow !== normalizedCueWindow;
    const clauseBefore = wrappedCueWindow.replace(/^[\s\S]*[\n\v\f\u0085\u2028\u2029;|!?]/, "");
    const accountCue = matchAccountCueBefore(clauseBefore);
    const hasCue = accountCue.hasCue && (!newlineWrapped || accountCue.canWrap);
    const minDigits = accountCue.minDigits;
    const hasBankGrouping =
      digits.length >= UNLABELLED_ACCOUNT_MIN_DIGITS &&
      BANK_HYPHEN_GROUPING_RE.test(raw) &&
      !US_PHONE_HYPHEN_RE.test(raw);
    if (!hasBankGrouping && (!hasCue || digits.length < minDigits)) {
      continue;
    }
    if (hasCue && (LOCAL_PHONE_PREFIX_RE.test(raw) || US_PHONE_HYPHEN_RE.test(raw))) {
      continue;
    }
    add(found, { kind: "account", match: raw, index: match.index });
  }
}

/**
 * Every Indonesian identifier in `text`, sorted by position. Labelled matches are collected first so
 * a number that carries its own label keeps that reading when two detectors could claim it.
 */
export function scanIndonesianIds(text: string): IdPiiMatch[] {
  if (!text) {
    return [];
  }
  const found: IdPiiMatch[] = [];
  collectLabelled(text, found);
  collectUnlabelled(text, found);
  return [...found].sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
}
