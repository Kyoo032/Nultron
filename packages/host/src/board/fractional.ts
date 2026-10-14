/**
 * Fractional positions for cards (team-board-spec.md section 7, rule 3): a move rewrites one row.
 *
 * Keys are strings over base-62 digits in ASCII order, so SQLite's default BINARY collation and
 * JavaScript's `<` sort them identically. A key never ends in "0", which is what guarantees there is
 * always room between two keys. Same midpoint scheme as the `fractional-indexing` package, written
 * here because a new dependency would put `pnpm-lock.yaml` in every merge from `main`.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export function isPositionKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && KEY_PATTERN.test(value);
}

function digit(char: string): number {
  return DIGITS.indexOf(char);
}

function midpoint(a: string, b: string | null, appending: boolean): string {
  if (b !== null) {
    let shared = 0;
    while ((a[shared] ?? "0") === b[shared]) {
      shared += 1;
    }
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared), false);
    }
  }
  const low = a ? digit(a[0]) : 0;
  const high = b !== null ? digit(b[0]) : BASE;
  if (high - low > 1) {
    // Appending is how every new card lands, so the end of a column steps by one digit instead of
    // halving the gap: a key then grows one character per ~60 appends rather than per ~6.
    const step = appending ? low + 1 : Math.round((low + high) / 2);
    return DIGITS[step];
  }
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return DIGITS[low] + midpoint(a.slice(1), null, appending);
}

/** The most keys `evenKeys` hands out at once: well above the per-desk card cap (`BOARD_VOLUME.cards`). */
export const MAX_EVEN_KEYS = 100_000;

/**
 * `count` short keys in order, evenly spaced, for rewriting a column whose keys grew long (security review
 * of K0, M1). They share one width, so ASCII order is numeric order; the spacing is at least 62, so moving a
 * key ending in "0" up by one never meets its neighbour.
 */
export function evenKeys(count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_EVEN_KEYS) {
    throw new RangeError(`evenKeys: count out of range: ${count}`);
  }
  let width = 1;
  while (BASE ** width < (count + 1) * BASE) {
    width += 1;
  }
  const step = Math.floor(BASE ** width / (count + 1));
  const encode = (value: number) => {
    let out = "";
    let rest = value;
    for (let place = 0; place < width; place += 1) {
      out = DIGITS[rest % BASE] + out;
      rest = Math.floor(rest / BASE);
    }
    return out;
  };
  return Array.from({ length: count }, (_, index) => {
    const value = (index + 1) * step;
    const key = encode(value);
    return key.endsWith("0") ? encode(value + 1) : key;
  });
}

/** A key strictly between `before` and `after`; `null` means the start or the end of the column. */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && !isPositionKey(before)) {
    throw new Error(`invalid position key: ${before}`);
  }
  if (after !== null && !isPositionKey(after)) {
    throw new Error(`invalid position key: ${after}`);
  }
  if (before !== null && after !== null && before >= after) {
    throw new Error("position keys out of order");
  }
  return midpoint(before ?? "", after, before !== null && after === null);
}
