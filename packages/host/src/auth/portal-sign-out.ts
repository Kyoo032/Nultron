/**
 * Best-effort sign-out at the portal for everybody an erased company had signed in
 * (SR-65, owner decision 2026-10-01).
 *
 * **What the portal gives us, and what it does not.** `apps/portal` has no call that removes a
 * company or a member, and the host has no admin credential for it. It does have
 * `POST /auth/logout { all_devices: true }`, Bearer-authenticated, which ends every portal session of
 * the caller and the portal's own 30-day browser session (SR-21). The host already holds a portal
 * refresh token for each browser that is signed in to it, sealed on the session row
 * (`./session-secrets.ts`). So, per person: open a sealed token, present it once to get an access
 * token (the same refresh the gate performs), and use that to sign the person out everywhere.
 *
 * **What it can and cannot reach.** Only people with a live host session that still holds a sealed
 * token. A member who is not signed in to the host has no token here, so the portal keeps their
 * identity, their membership and their portal sessions; the report counts them as `unreachable`.
 * That is a gap in the portal's API, recorded in SR-65, and nothing in this file can close it.
 *
 * **Best effort, and it can never fail the erase.** By the time this runs the host's rows are gone and
 * the answer is already decided; this only trims what the portal holds. So it never throws, it spends a
 * fixed budget (`PORTAL_SIGN_OUT_WAIT_MS`) and then reports what was still running, and a failure is a
 * counted outcome and a log line carrying a reason code, never a token.
 *
 * **One sign-out per person, not per browser.** `all_devices` ends the person's other portal sessions
 * as well, so a second browser's token is only used when the first one would not open. Rotating a
 * token the portal is about to revoke would be wasted work and one more place to fail.
 *
 * **Tokens stay in this function.** They are opened, used and dropped; the report holds counts only, and
 * the logger would drop a token-named field anyway (`../log.ts`).
 */
import { log } from "../log";
import { PortalError, type PortalClient } from "./portal-client";
import { isTerminalPortalReason } from "./portal-check";
import type { PortalClientCredentials } from "./portal-config";
import { openRefresh, type StoredRefresh } from "./session-secrets";

/** The most this waits for the portal in total, however many people there are. */
export const PORTAL_SIGN_OUT_WAIT_MS = 8000;
/** People signed out at once. The portal's own limits are per client and per address. */
export const PORTAL_SIGN_OUT_CONCURRENCY = 6;

/** One live browser session of the erased tenant, as `tenantSessionSeals` read it before the purge. */
export type SessionSeal = {
  readonly idHash: string;
  readonly userId: string;
  readonly refreshSealed: string;
};

export type PortalSignOutDeps = {
  readonly portal: PortalClient;
  /** The wrap key the sealed tokens were sealed under. Throwing is read as a deployment fault. */
  readonly wrapKey: () => Buffer;
  /** The deployment's confidential client, presented on the refresh as the gate presents it. */
  readonly clientCredentials?: () => PortalClientCredentials | null;
  /** For the log line only. */
  readonly tenantId: string;
  readonly waitMs?: number;
  readonly concurrency?: number;
};

export type PortalSignOutReport = {
  /** Distinct people with at least one live session that held a sealed token. */
  readonly people: number;
  /** The portal ended their sessions, or had already ended the one the host held. */
  readonly signedOut: number;
  /** The portal refused or could not be reached. */
  readonly failed: number;
  /** No token the host could open; the portal still holds that person's sessions. */
  readonly unreachable: number;
  /** Still running when the budget ran out. Their calls finish in the background. */
  readonly unfinished: number;
};

type Outcome = "signedOut" | "failed" | "unreachable";

function groupByPerson(seals: readonly SessionSeal[]): SessionSeal[][] {
  const groups = new Map<string, SessionSeal[]>();
  for (const seal of seals) {
    groups.set(seal.userId, [...(groups.get(seal.userId) ?? []), seal]);
  }
  return [...groups.values()];
}

/** The first of a person's sealed tokens that opens as its own row under this key, or null. */
function firstOpenable(browsers: readonly SessionSeal[], wrapKey: Buffer): StoredRefresh | null {
  for (const browser of browsers) {
    const opened = openRefresh(browser.idHash, browser.refreshSealed, wrapKey);
    if (opened) {
      return opened;
    }
  }
  return null;
}

function reasonOf(error: unknown): string {
  return error instanceof PortalError ? error.reason : "unexpected";
}

async function signOutOne(browsers: readonly SessionSeal[], deps: PortalSignOutDeps): Promise<Outcome> {
  let stored: StoredRefresh | null;
  try {
    stored = firstOpenable(browsers, deps.wrapKey());
  } catch {
    // The wrap key itself cannot be read: the deployment, not this person's session.
    log.warn("tenant_erase_portal_signout_failed", { tenantId: deps.tenantId, code: "wrap_key_unreadable" });
    return "failed";
  }
  if (!stored) {
    return "unreachable";
  }
  try {
    let credentials: PortalClientCredentials | null = null;
    try {
      credentials = deps.clientCredentials?.() ?? null;
    } catch {
      credentials = null;
    }
    const rotated = await deps.portal.refresh({
      refreshToken: stored.refreshToken,
      deviceId: stored.deviceId,
      ...(credentials ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret } : {}),
    });
    await deps.portal.logout({ accessToken: rotated.accessToken, allDevices: true });
    return "signedOut";
  } catch (error) {
    if (error instanceof PortalError && isTerminalPortalReason(error.reason)) {
      // The portal already ended this session: there is nothing left to sign out.
      return "signedOut";
    }
    log.warn("tenant_erase_portal_signout_failed", { tenantId: deps.tenantId, code: reasonOf(error) });
    return "failed";
  }
}

/** Run `task` over `items` with at most `limit` in flight; results land by index as they finish. */
async function inPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<Outcome>,
  results: Array<Outcome | undefined>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function reportOf(people: number, results: ReadonlyArray<Outcome | undefined>): PortalSignOutReport {
  const count = (outcome: Outcome) => results.filter((result) => result === outcome).length;
  return {
    people,
    signedOut: count("signedOut"),
    failed: count("failed"),
    unreachable: count("unreachable"),
    unfinished: results.filter((result) => result === undefined).length,
  };
}

export async function endPortalSessionsBestEffort(
  seals: readonly SessionSeal[],
  deps: PortalSignOutDeps,
): Promise<PortalSignOutReport> {
  const people = groupByPerson(seals);
  if (people.length === 0) {
    return reportOf(0, []);
  }
  const results: Array<Outcome | undefined> = Array.from({ length: people.length }, () => undefined);
  const finished = inPool(
    people,
    Math.max(1, deps.concurrency ?? PORTAL_SIGN_OUT_CONCURRENCY),
    (browsers) => signOutOne(browsers, deps),
    results,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.waitMs ?? PORTAL_SIGN_OUT_WAIT_MS);
    timer.unref?.();
  });
  try {
    // `finished` never rejects: every task above answers with an outcome. A call still in flight when
    // the budget runs out keeps going and writes its own slot, which nothing reads any more.
    await Promise.race([finished, budget]);
  } finally {
    clearTimeout(timer);
  }
  return reportOf(people.length, results);
}
