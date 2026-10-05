/**
 * When an address that has spent its day's guesses can try again.
 *
 * The limit is a rolling total (`otps.ts`: twenty guesses across the codes created in the last 24
 * hours), so the lock does not lift at a fixed hour. It lifts as the oldest codes age out of the
 * window, and the answer is the moment enough of them have for the total to drop under the limit.
 * The sign-in tells the person that moment instead of a flat "24 hours".
 */

export interface GuessedCode {
  /** When the code was minted: the guesses against it count from here. */
  readonly createdAt: Date;
  readonly attempts: number;
}

/**
 * Whole seconds until the rolling total drops under `limit`, or `null` when it already is. Never
 * less than one: a lock that is about to lift still reads as a wait.
 */
export function secondsUntilUnlocked(
  codes: readonly GuessedCode[],
  now: Date,
  limit: number,
  windowMs: number,
): number | null {
  let total = codes.reduce((sum, code) => sum + code.attempts, 0);
  if (total < limit) {
    return null;
  }

  const oldestFirst = [...codes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const code of oldestFirst) {
    total -= code.attempts;
    if (total < limit) {
      const opensAt = code.createdAt.getTime() + windowMs;
      return Math.max(1, Math.ceil((opensAt - now.getTime()) / 1000));
    }
  }
  // Unreachable while `limit` is positive: every code removed, the total is zero.
  return Math.max(1, Math.ceil(windowMs / 1000));
}
