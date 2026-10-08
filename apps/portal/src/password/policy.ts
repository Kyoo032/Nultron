/**
 * What a username and a password may be, decided once.
 *
 * The password rules are deliberately few and are the ones the owner set (2026-10-07): at least 12
 * characters, at most 200, and not the person's own username or e-mail address. Two more are added
 * because each costs nothing and prevents a mistake rather than a style: no control characters (a
 * pasted password with a trailing newline is an error, not a password), and a new password must
 * differ from the one being replaced (otherwise "you must choose a new password" can be answered by
 * typing the old one back).
 *
 * Not built: a list of common or breached passwords. Recorded as a residual in SR-165.
 *
 * Characters are counted as code points after NFKC, so an emoji is one character and the same text
 * typed two ways is the same length. NFKC is also what `hash.ts` hashes.
 */
import { normalisePassword } from "./hash";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** A refusal the person can act on. None of them says anything about any account. */
export type PasswordRefusal =
  | "too_short"
  | "too_long"
  | "control_characters"
  | "mismatch"
  | "same_as_username"
  | "same_as_email"
  | "same_as_current";

export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * U+0000 to U+001F and U+007F. A loop and not a regular expression: biome refuses a control
 * character in a regex literal, escaped or not, and the escape is not worth a lint exception.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * The refusals that need no account: length and control characters. Checked first and before any
 * credential is looked at, so a policy mistake costs nobody an attempt against the lockout.
 */
export function checkPasswordShape(password: string): PasswordRefusal | null {
  const normalised = normalisePassword(password);
  const length = codePointLength(normalised);
  if (length < PASSWORD_MIN_LENGTH) {
    return "too_short";
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return "too_long";
  }
  return hasControlCharacter(normalised) ? "control_characters" : null;
}

export interface PasswordAccount {
  readonly username: string;
  readonly email: string;
  /** The password being replaced, when there is one. */
  readonly current?: string;
}

/** The refusals that need the account. Run only after the account has proved its current password. */
export function checkPasswordAgainstAccount(password: string, account: PasswordAccount): PasswordRefusal | null {
  const normalised = normalisePassword(password);
  const lowered = normalised.toLowerCase();
  if (lowered === account.username.toLowerCase()) {
    return "same_as_username";
  }
  if (lowered === account.email.toLowerCase()) {
    return "same_as_email";
  }
  if (account.current !== undefined && normalised === normalisePassword(account.current)) {
    return "same_as_current";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Usernames
// ---------------------------------------------------------------------------

/**
 * 3 to 32 characters of `a-z 0-9 . _ -`, starting with a letter or digit. The same pattern as
 * `user_credentials_username_chk`. It cannot contain `@`, which is what lets one field take a
 * username or an e-mail address without ever being ambiguous about which it was given.
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function normaliseUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}
