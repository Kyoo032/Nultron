/**
 * Where a browser session lives between requests (web-security-spec row T1: "session token stored
 * server-side, cookie carries an opaque id").
 *
 * One interface, two implementations: SQLite through `@agentforge/db` (`auth_sessions`) for the
 * hosted server, and an in-memory map for tests and for any caller that wants a store without a
 * database.
 *
 * NEITHER IMPLEMENTATION KEEPS THE COOKIE'S ID. Both key a row by `hashSessionId(id)` (migration
 * 0021) and hand the presented id back on the way out, so a copy of the table replays nothing and a
 * digest presented as a cookie finds nothing.
 *
 * THE PORTAL REFRESH TOKEN, SEALED, LIVES ON THE ROW (`refresh_sealed`, owner decision 2026-09-23),
 * so a restart signs nobody out. The store never sees it in the clear: it is handed an opaque
 * string sealed by `./session-secrets.ts` and hands the same string back. It is never part of a
 * `SessionRecord`, so nothing that passes a record around — the gate, a handler, a summary — can
 * carry it by accident. It goes with the session: revoking a row wipes it in the same write, the
 * sweep wipes it once a session idles out, and the row's deletion takes it at the absolute expiry.
 *
 * TWO REQUESTS CAN RACE ON ONE SESSION, and each writes what it read. So `save` never clears a
 * revocation (a slide read before a sign-out must not resurrect it), and the portal check has its
 * own writer, `recordRotation`, which moves the stamp only forward and never stores a token on a
 * row that has been revoked in the meantime. `save` touches neither.
 */
import type { Database } from "@agentforge/db";
import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { hashSessionId, type SessionRecord } from "./session";
import { endpointMac, endpointMacVerify, openEndpointKey, sealEndpointKey } from "./session-secrets";

export interface SessionStore {
  /**
   * Insert a freshly minted session, with its sealed refresh token when there is one. `endpointKey`
   * is the bearer key the portal issued for `session.gatewayEndpoint` (DFIND-155): the SQLite
   * store seals it bound to the row's id digest and endpoint (`endpoint_key_sealed`, migration
   * 0025); the memory store keeps it in process memory like the token vault.
   */
  create(session: SessionRecord, refreshSealed?: string | null, endpointKey?: string | null): Promise<void>;
  /**
   * The stored row under the cookie's id, or null when unknown. Never throws on a stranger's
   * cookie. A `gatewayEndpoint` whose MAC does not verify is dropped from the record — refused,
   * not trusted (DFIND-160) — so the session falls back to the pinned gateway until the portal's
   * own answer rewrites it.
   */
  find(id: string): Promise<SessionRecord | null>;
  /**
   * Persist a slide or a revocation. Never un-revokes and keeps the first revocation time; a row
   * that is revoked after this write holds no sealed token. Leaves `portalCheckedAt` alone.
   */
  save(session: SessionRecord): Promise<void>;
  /**
   * A rotation landed at `at`: the stamp moves forward (never back) and the sealed token becomes
   * `refreshSealed` — in one write, so the two can never disagree. `null` clears it. When
   * `gatewayEndpoint` is provided (string or `null`), the row's operator-assigned gateway endpoint
   * is updated in the same write; when omitted (`undefined`), the existing value is preserved. A
   * row revoked while the rotation was in flight keeps no token. No-op when the session is unknown.
   *
   * `endpointKey` is the key the portal issued for `gatewayEndpoint` in the same rotation, sealed
   * when written. When `gatewayEndpoint` is provided and `endpointKey` is not (or is null), the
   * row keeps no key: a key sealed for a different endpoint must never be reused.
   */
  recordRotation(
    id: string,
    at: number,
    refreshSealed: string | null,
    gatewayEndpoint?: string | null,
    endpointKey?: string | null,
  ): Promise<void>;
  /** The sealed refresh token of a live (unrevoked) session, or null. */
  readRefreshSealed(id: string): Promise<string | null>;
  /**
   * The per-endpoint bearer key of a live session, opened only when the row's endpoint MAC
   * verifies (DFIND-155/160): null for none, an untrusted endpoint, or a blob that does not open.
   */
  readEndpointKey(id: string, expectedEndpoint?: string | null): Promise<string | null>;
  /**
   * Drop sessions whose absolute expiry has passed, and wipe the sealed token of every session that
   * has idled out, whose row stays so it can still report itself. Returns how many rows went.
   */
  purgeExpired(before: number): Promise<number>;
}

/** The row a store keeps for `session`: everything but the cookie's id, which becomes its digest. */
function atRest(session: SessionRecord): SessionRecord {
  return { ...session, id: hashSessionId(session.id) };
}

/** The earlier revocation wins, and a revocation is never cleared. */
function stickyRevocation(stored: number | null, next: number | null): number | null {
  return stored ?? next;
}

export function createMemorySessionStore(seed: readonly SessionRecord[] = []): SessionStore {
  const rows = new Map<string, SessionRecord>(seed.map((session) => [hashSessionId(session.id), atRest(session)]));
  /** Beside the rows rather than in them, as the SQLite store keeps it out of the record it returns. */
  const sealed = new Map<string, string>();
  /** In-memory stand-in for `endpoint_key_sealed`: process memory only, like the token vault. */
  const endpointKeys = new Map<string, string>();
  return {
    async create(session, refreshSealed = null, endpointKey = null) {
      const key = hashSessionId(session.id);
      rows.set(key, atRest(session));
      if (refreshSealed === null) {
        sealed.delete(key);
      } else {
        sealed.set(key, refreshSealed);
      }
      if (endpointKey === null || !session.gatewayEndpoint) {
        endpointKeys.delete(key);
      } else {
        endpointKeys.set(key, endpointKey);
      }
    },
    async find(id) {
      const found = rows.get(hashSessionId(id));
      return found ? { ...found, id } : null;
    },
    async save(session) {
      const key = hashSessionId(session.id);
      const stored = rows.get(key);
      if (!stored) {
        // A store with no row to update is how tests seed one; the SQLite store would write nothing.
        rows.set(key, atRest(session));
        return;
      }
      const revokedAt = stickyRevocation(stored.revokedAt, session.revokedAt);
      rows.set(key, {
        ...stored,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt,
      });
      if (revokedAt !== null) {
        sealed.delete(key);
        endpointKeys.delete(key);
      }
    },
    async recordRotation(id, at, refreshSealed, gatewayEndpoint, endpointKey) {
      const key = hashSessionId(id);
      const stored = rows.get(key);
      if (!stored) {
        return;
      }
      // Never rewinds: a stamp already ahead of this write stands, and `portalCheckDue` refuses to
      // trust a future stamp either way (DFIND-160) — the row is due on the next read.
      rows.set(key, {
        ...stored,
        portalCheckedAt: Math.max(stored.portalCheckedAt ?? at, at),
        ...(gatewayEndpoint !== undefined && stored.revokedAt === null ? { gatewayEndpoint } : {}),
      });
      if (stored.revokedAt === null && refreshSealed !== null) {
        sealed.set(key, refreshSealed);
      } else {
        sealed.delete(key);
      }
      if (gatewayEndpoint !== undefined) {
        if (stored.revokedAt === null && endpointKey) {
          endpointKeys.set(key, endpointKey);
        } else {
          endpointKeys.delete(key);
        }
      }
    },
    async readRefreshSealed(id) {
      const key = hashSessionId(id);
      const stored = rows.get(key);
      return stored && stored.revokedAt === null ? (sealed.get(key) ?? null) : null;
    },
    async readEndpointKey(id, expectedEndpoint) {
      const key = hashSessionId(id);
      const stored = rows.get(key);
      return stored && stored.revokedAt === null && stored.gatewayEndpoint
        ? expectedEndpoint === undefined || stored.gatewayEndpoint === expectedEndpoint
          ? (endpointKeys.get(key) ?? null)
          : null
        : null;
    },
    async purgeExpired(before) {
      let removed = 0;
      for (const [key, session] of [...rows]) {
        if (session.absoluteExpiresAt <= before) {
          rows.delete(key);
          sealed.delete(key);
          endpointKeys.delete(key);
          removed += 1;
        } else if (session.expiresAt <= before) {
          sealed.delete(key);
          endpointKeys.delete(key);
        }
      }
      return removed;
    },
  };
}

/**
 * The portal tokens behind a session, keyed by session id: this process's working copy.
 *
 * Process memory, as the access token must be (the device-code doc: never written to disk). The
 * refresh token is ALSO kept sealed on the session row (`refresh_sealed`, `./session-secrets.ts`),
 * which is what survives a restart: after one, a session's first portal check finds this vault
 * empty, opens the sealed token and refreshes (`./portal-check.ts`). Until that refresh lands there
 * is no access token, hence `null`.
 */
export type PortalTokenSet = {
  readonly refreshToken: string;
  /** Null after a restart, until the next rotation hands a fresh one back. */
  readonly accessToken: string | null;
  readonly deviceId: string | null;
};

export interface TokenVault {
  put(sessionId: string, tokens: PortalTokenSet): Promise<void>;
  get(sessionId: string): Promise<PortalTokenSet | null>;
  delete(sessionId: string): Promise<void>;
}

export function createMemoryTokenVault(): TokenVault {
  const rows = new Map<string, PortalTokenSet>();
  return {
    async put(sessionId, tokens) {
      rows.set(sessionId, { ...tokens });
    },
    async get(sessionId) {
      const found = rows.get(sessionId);
      return found ? { ...found } : null;
    },
    async delete(sessionId) {
      rows.delete(sessionId);
    },
  };
}

/**
 * The drizzle table is imported lazily: `@agentforge/db`'s entry point opens the SQLite file as an
 * import side effect, and neither the desktop nor a unit test that never signs in should pay for it.
 */
async function table() {
  const { authSessions } = await import("@agentforge/db");
  return authSessions;
}

/**
 * The wrap key behind the endpoint MAC and the sealed endpoint key. Read lazily and per call —
 * never cached — for the same reason `createSessionSecrets` re-reads it: a rotation must not be
 * stranded on the old value.
 */
async function wrapKey(): Promise<Buffer> {
  const { getLocalVaultKey } = await import("@agentforge/db/vault-key");
  return getLocalVaultKey();
}

export function createDrizzleSessionStore(database: Database): SessionStore {
  return {
    async create(session, refreshSealed = null, endpointKey = null) {
      const authSessions = await table();
      const idHash = hashSessionId(session.id);
      const endpoint = session.gatewayEndpoint ?? null;
      const key = endpoint ? await wrapKey() : null;
      await database.insert(authSessions).values({
        ...atRest(session),
        gatewayEndpoint: endpoint,
        // Written with the endpoint it covers, in the same row: the two can never disagree about
        // which write they belong to (DFIND-160).
        gatewayEndpointMac: endpoint ? endpointMac(idHash, endpoint, key!) : null,
        endpointKeySealed: endpoint && endpointKey ? sealEndpointKey(idHash, endpoint, endpointKey, key!) : null,
        refreshSealed,
      });
    },
    async find(id) {
      const authSessions = await table();
      // Named columns, not `select()`: the sealed token must never ride out on a record.
      const [row] = await database
        .select({
          tenantId: authSessions.tenantId,
          userId: authSessions.userId,
          orgId: authSessions.orgId,
          createdAt: authSessions.createdAt,
          lastSeenAt: authSessions.lastSeenAt,
          expiresAt: authSessions.expiresAt,
          absoluteExpiresAt: authSessions.absoluteExpiresAt,
          revokedAt: authSessions.revokedAt,
          portalCheckedAt: authSessions.portalCheckedAt,
          gatewayEndpoint: authSessions.gatewayEndpoint,
          gatewayEndpointMac: authSessions.gatewayEndpointMac,
        })
        .from(authSessions)
        .where(eq(authSessions.id, hashSessionId(id)))
        .limit(1);
      if (!row) {
        return null;
      }
      const { gatewayEndpoint, gatewayEndpointMac, ...rest } = row;
      // DFIND-160: the endpoint is trusted only with its MAC. A rewritten value — missing or wrong
      // tag — is dropped here, never carried to `checkGatewayLive` or a real call; the session
      // itself stays valid and the next portal check rewrites the pair.
      const trustedEndpoint =
        gatewayEndpoint && endpointMacVerify(hashSessionId(id), gatewayEndpoint, gatewayEndpointMac, await wrapKey())
          ? gatewayEndpoint
          : null;
      return {
        ...rest,
        id,
        revokedAt: row.revokedAt ?? null,
        portalCheckedAt: row.portalCheckedAt ?? null,
        ...(trustedEndpoint ? { gatewayEndpoint: trustedEndpoint } : {}),
      };
    },
    async save(session) {
      const authSessions = await table();
      await database
        .update(authSessions)
        .set({
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
          // Never un-revokes, and the first revocation time stands: see the module comment.
          revokedAt: sql`coalesce(${authSessions.revokedAt}, ${session.revokedAt})`,
          // A row that is revoked once this write lands keeps no token. SQLite evaluates every SET
          // against the row as it was, so this reads the pre-write `revoked_at`.
          refreshSealed: sql`CASE WHEN coalesce(${authSessions.revokedAt}, ${session.revokedAt}) IS NULL THEN ${authSessions.refreshSealed} ELSE NULL END`,
          // The endpoint key goes the same way: a revoked row keeps nothing it could leak.
          endpointKeySealed: sql`CASE WHEN coalesce(${authSessions.revokedAt}, ${session.revokedAt}) IS NULL THEN ${authSessions.endpointKeySealed} ELSE NULL END`,
        })
        .where(eq(authSessions.id, hashSessionId(session.id)));
    },
    async recordRotation(id, at, refreshSealed, gatewayEndpoint, endpointKey) {
      const authSessions = await table();
      const idHash = hashSessionId(id);
      const key = gatewayEndpoint ? await wrapKey() : null;
      await database
        .update(authSessions)
        .set({
          // Never rewinds, and a future stamp is refused at read time by `portalCheckDue`, not
          // trusted: a rewritten `portal_checked_at` cannot keep a forged row out of the portal's
          // reach (DFIND-160).
          portalCheckedAt: sql`max(coalesce(${authSessions.portalCheckedAt}, ${at}), ${at})`,
          refreshSealed: sql`CASE WHEN ${authSessions.revokedAt} IS NULL THEN ${refreshSealed} ELSE NULL END`,
          ...(gatewayEndpoint !== undefined
            ? {
                gatewayEndpoint: sql`CASE WHEN ${authSessions.revokedAt} IS NULL THEN ${gatewayEndpoint} ELSE ${authSessions.gatewayEndpoint} END`,
                // The MAC is computed over the value being written, not the row's: a revoked row
                // keeps its old endpoint and old MAC together.
                gatewayEndpointMac: sql`CASE WHEN ${authSessions.revokedAt} IS NULL THEN ${gatewayEndpoint ? endpointMac(idHash, gatewayEndpoint, key!) : null} ELSE ${authSessions.gatewayEndpointMac} END`,
                // Keyed to the new endpoint: a rotated-in endpoint with no issued key stores none.
                endpointKeySealed: sql`CASE WHEN ${authSessions.revokedAt} IS NULL THEN ${gatewayEndpoint && endpointKey ? sealEndpointKey(idHash, gatewayEndpoint, endpointKey, key!) : null} ELSE ${authSessions.endpointKeySealed} END`,
              }
            : {}),
        })
        .where(eq(authSessions.id, idHash));
    },
    async readRefreshSealed(id) {
      const authSessions = await table();
      const [row] = await database
        .select({ refreshSealed: authSessions.refreshSealed })
        .from(authSessions)
        .where(and(eq(authSessions.id, hashSessionId(id)), isNull(authSessions.revokedAt)))
        .limit(1);
      return row?.refreshSealed ?? null;
    },
    async readEndpointKey(id, expectedEndpoint) {
      const authSessions = await table();
      const idHash = hashSessionId(id);
      const [row] = await database
        .select({
          gatewayEndpoint: authSessions.gatewayEndpoint,
          gatewayEndpointMac: authSessions.gatewayEndpointMac,
          endpointKeySealed: authSessions.endpointKeySealed,
        })
        .from(authSessions)
        .where(and(eq(authSessions.id, idHash), isNull(authSessions.revokedAt)))
        .limit(1);
      if (!row?.gatewayEndpoint || !row.endpointKeySealed) {
        return null;
      }
      // The same refusal `find` applies: an endpoint without a verifying MAC is untrusted, and a
      // blob that does not open as this row and endpoint's key is not a key.
      const key = await wrapKey();
      if (!endpointMacVerify(idHash, row.gatewayEndpoint, row.gatewayEndpointMac, key)) {
        return null;
      }
      // The endpoint the caller uses must be the endpoint this row holds: a rotation that landed
      // between its two reads never pairs a stale endpoint with a newer key.
      if (expectedEndpoint !== undefined && row.gatewayEndpoint !== expectedEndpoint) {
        return null;
      }
      return openEndpointKey(idHash, row.endpointKeySealed, row.gatewayEndpoint, key);
    },
    async purgeExpired(before) {
      const authSessions = await table();
      const result = await database.delete(authSessions).where(lte(authSessions.absoluteExpiresAt, before));
      // Idled out: the row stays to report `refresh_expired`, the token it can no longer use does not.
      await database
        .update(authSessions)
        .set({ refreshSealed: null, endpointKeySealed: null })
        .where(and(lte(authSessions.expiresAt, before), isNotNull(authSessions.refreshSealed)));
      return Number((result as { changes?: number }).changes ?? 0);
    },
  };
}

/**
 * The store the hosted server actually runs on. Lazy so that importing the router does not open the
 * database — the desktop and webdev never reach this call at all.
 */
export function createHostSessionStore(): SessionStore {
  let inner: Promise<SessionStore> | null = null;
  const resolve = async (): Promise<SessionStore> => {
    inner ??= import("@agentforge/db").then(({ db }) => createDrizzleSessionStore(db));
    return inner;
  };
  return {
    async create(session, refreshSealed, endpointKey) {
      return (await resolve()).create(session, refreshSealed, endpointKey);
    },
    async find(id) {
      return (await resolve()).find(id);
    },
    async save(session) {
      return (await resolve()).save(session);
    },
    async recordRotation(id, at, refreshSealed, gatewayEndpoint, endpointKey) {
      return (await resolve()).recordRotation(id, at, refreshSealed, gatewayEndpoint, endpointKey);
    },
    async readRefreshSealed(id) {
      return (await resolve()).readRefreshSealed(id);
    },
    async readEndpointKey(id) {
      return (await resolve()).readEndpointKey(id);
    },
    async purgeExpired(before) {
      return (await resolve()).purgeExpired(before);
    },
  };
}
