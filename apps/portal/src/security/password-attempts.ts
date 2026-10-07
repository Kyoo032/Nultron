/**
 * What the password sign-in remembers in this process about who has been trying whom, and the order it
 * charges the attempts in (`PORTAL_SIGNIN_MODE=password`).
 *
 * ## Why it exists
 *
 * The account lock (`store/postgres/credentials.ts`) refuses everybody, the person included. Left like
 * that, it is a free way to keep a named person out: five wrong attempts every fifteen minutes from one
 * address, and they never get in. The mitigation is to tell the attacker from the person by what the
 * attacker has already done: a source address that has itself attempted this account in the window and
 * not got through is refused outright while the account is locked, and a source that has not may still
 * take one of a few attempts the database counts (`grace_attempts`, three) -- so the person, signing in
 * from their own address, gets through, and the guesses are still bounded where the count is.
 *
 * ## What is bounded by what
 *
 *   - **The number of passwords tried** is bounded by the database, not by this file: five before the
 *     lock plus three under it per account per window (`PASSWORD_MAX_FAILED_ATTEMPTS +
 *     PASSWORD_GRACE_ATTEMPTS`), whoever asks, from however many addresses, through however many
 *     processes. Nothing here can raise it. What this record decides is only WHICH callers may ask for
 *     the slots under the lock.
 *   - **This record is per process and is lost on a restart.** After one, every source is clean again,
 *     so a source that had been locked out can ask for a slot: it spends one of the three that the
 *     database still counts. A second portal process would hold a record of its own. Both make the
 *     refusal of a source that has failed weaker, and neither makes the guess count larger.
 *
 * ## Attempts, not failures
 *
 * A source is marked when it ENTERS, before its password is compared, in the same synchronous step that
 * decides whether it was clean. Marking on failure instead would let a burst of parallel requests from
 * one address all find themselves clean (none has failed yet) and take every slot between them. A
 * success forgets the mark, so a person who mistypes once and then gets it right is not held against.
 *
 * ## Order
 *
 * `ordered` runs the charge for one account strictly in the order sources entered, so the first request
 * a source makes is the first one the database sees, and a burst from one address is five comparisons
 * and not five plus the slot its first request would otherwise have found after the lock.
 *
 * Everything is bounded in size, because the callers are unauthenticated: marks exist only for accounts
 * that exist (a mark needs an account found), and only a small number per account.
 */
import { PASSWORD_LOCK_MS } from "../store/postgres/credentials";
import type { Clock } from "../store/types";

/** As long as the lock itself (one number, the lock's): a mark ends when the window it belongs to is over. */
export const PASSWORD_ATTEMPT_WINDOW_MS = PASSWORD_LOCK_MS;

const DEFAULT_MAX_ACCOUNTS = 10_000;
/** Five plus three comparisons are all a window allows, so more sources than that tell us nothing. */
const DEFAULT_MAX_SOURCES_PER_ACCOUNT = 32;

export interface PasswordAttemptsOptions {
  readonly clock: Clock;
  readonly windowMs?: number;
  readonly maxAccounts?: number;
  readonly maxSourcesPerAccount?: number;
}

export interface PasswordAttempts {
  /**
   * Synchronous, and the whole of its decision is made in this call. `clean` is true when this source
   * has not attempted this account in the window (and has not been forgotten since); the attempt is
   * recorded either way. A mark ends fifteen minutes after the first attempt and is not extended by
   * further ones.
   */
  enter(account: string, source: string): { readonly clean: boolean };
  /** A password was proved: this source's mark for this account goes. */
  forget(account: string, source: string): void;
  /** Runs `work` after every earlier piece of work for the same account has finished, however it ended. */
  ordered<T>(account: string, work: () => Promise<T>): Promise<T>;
  /** Marks held, for tests. */
  readonly size: number;
}

export function createPasswordAttempts(options: PasswordAttemptsOptions): PasswordAttempts {
  const windowMs = options.windowMs ?? PASSWORD_ATTEMPT_WINDOW_MS;
  const maxAccounts = Math.max(1, Math.floor(options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS));
  const maxSources = Math.max(1, Math.floor(options.maxSourcesPerAccount ?? DEFAULT_MAX_SOURCES_PER_ACCOUNT));
  /** account -> source -> when its mark ends. Both maps keep the order things were first added in. */
  const accounts = new Map<string, Map<string, number>>();
  const tails = new Map<string, Promise<unknown>>();

  const pruneExpired = (marks: Map<string, number>, now: number): void => {
    for (const [source, endsAt] of marks) {
      if (endsAt <= now) {
        marks.delete(source);
      }
    }
  };

  /** Expired accounts first, then the oldest live ones, down to a little under the cap. */
  const makeRoom = (now: number): void => {
    for (const [account, marks] of accounts) {
      pruneExpired(marks, now);
      if (marks.size === 0) {
        accounts.delete(account);
      }
    }
    const target = maxAccounts - Math.max(1, Math.ceil(maxAccounts * 0.01));
    for (const account of accounts.keys()) {
      if (accounts.size <= target) {
        return;
      }
      accounts.delete(account);
    }
  };

  return {
    enter(account, source) {
      const now = options.clock.now().getTime();
      let marks = accounts.get(account);
      if (marks === undefined) {
        if (accounts.size >= maxAccounts) {
          makeRoom(now);
        }
        marks = new Map();
        accounts.set(account, marks);
      }
      const endsAt = marks.get(source);
      if (endsAt !== undefined && endsAt > now) {
        return { clean: false };
      }
      // Re-added at the end of the order, so the oldest mark is always the first one in the map.
      marks.delete(source);
      if (marks.size >= maxSources) {
        pruneExpired(marks, now);
      }
      while (marks.size >= maxSources) {
        const oldest = marks.keys().next();
        if (oldest.done) {
          break;
        }
        marks.delete(oldest.value);
      }
      marks.set(source, now + windowMs);
      return { clean: true };
    },

    forget(account, source) {
      const marks = accounts.get(account);
      if (marks === undefined) {
        return;
      }
      marks.delete(source);
      if (marks.size === 0) {
        accounts.delete(account);
      }
    },

    ordered<T>(account: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(account) ?? Promise.resolve();
      const run = previous.then(work);
      // The chain carries on whatever `work` did; the caller still gets `work`'s own outcome.
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(account, tail);
      void tail.then(() => {
        if (tails.get(account) === tail) {
          tails.delete(account);
        }
      });
      return run;
    },

    get size() {
      let held = 0;
      for (const marks of accounts.values()) {
        held += marks.size;
      }
      return held;
    },
  };
}
