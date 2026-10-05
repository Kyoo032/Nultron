/**
 * Phase 8 — the hosted "Erase account": one company erases its own account, its people and its
 * content, and nobody else's.
 *
 * **Owner decision 2026-10-01 (SR-65): erasing the company account deletes every person in it and ends
 * every session.** This used to be a *reset*: it emptied the account, kept everybody signed in and put
 * the org and its memberships back so the account carried on. The owner's answer to "should Erase
 * account revoke the tenant's sessions and refresh tokens, or keep them?" was: once the main company
 * account is deleted, all the other users are deleted too, behind a bright red button that has to be
 * clicked twice with something typed in. The contract is where that is promised; this file is where
 * it is kept. So there is no re-provisioning step any more, and the answer carries `signedOut: true`.
 *
 * The desktop has had "Start over" since before any of this: it queues a wipe of the whole data
 * directory and applies it on the next boot (`@agentforge/db`'s `reset.ts`). On the hosted server
 * that directory is every tenant's work, so the route has been refused there since Phase 3 with
 * `reset_disabled` (security spec row T8). This is the hosted act, with its own scope.
 *
 * ## What it does, in order, and why that order
 *
 * 1. **The audit row, first.** `started`, written before anything is destroyed. A reset that dies
 *    half way must leave a trace, and after it runs there is nothing left to reconstruct one from
 *    — the threads, runs and media that would have told the story are exactly what went.
 * 2. **The sealed refresh tokens are read**, before the purge deletes the only copy of them: step 6
 *    uses them to sign each person out of the portal.
 * 3. **The database rows**, in one transaction (`@agentforge/db`'s `tenant-purge.ts`). Everything
 *    that is this tenant's content, **every `auth_sessions` row with the refresh token sealed on it, and
 *    the `user` rows nothing else refers to** — all in the same transaction, so there is no moment when
 *    the data is gone and a session still answers. Never the tenant row, the plan, the seats, the usage
 *    ledger or the billing events: a tenant must not be able to erase what they owe by pressing a button
 *    in their own settings. After this commit the next request from any of those browsers finds no
 *    session row and is a 401 `session_required`.
 * 4. **The object prefix**, through the Phase 6 store, so it is the bucket on a COS deployment and
 *    the tree on a file one, with the same guard in front of both.
 * 5. **The job trees on local disk**, which are the bytes the object store does not hold: ffmpeg's
 *    scratch, knowledge uploads, dataset files, meeting recordings, legal matter files, channel
 *    state — and the tenant's own settings envelope and gate verdict on a deployment that still
 *    keeps them as files. The in-process caches go with them, because a key cached in this process
 *    would outlive the row it came from.
 * 6. **The portal, best effort** (`./auth/portal-sign-out.ts`). The portal has no call that removes a
 *    company or a member, so the host signs each signed-in person out of the portal everywhere with
 *    the refresh token it held for them. It starts right after the purge and runs beside steps 4 and 5,
 *    so a slow portal adds nothing and a failed storage step does not skip it. It can never fail the
 *    erase: a shortfall is a count in the log and the audit row's `detail`.
 * 7. **The audit row again**, `completed`, with what actually went.
 *
 * ## Idempotent, and safe to retry after a partial failure
 *
 * Every step is a delete by id, so running it twice removes what the first pass missed and reports zero
 * for what it already took. That matters because step 4 is not atomic — a bucket can refuse half way
 * through a prefix — and the honest answer to a partial storage failure is "run it again", not a
 * rollback that cannot restore the objects anyway. A `started` row left behind by a killed process is a
 * prompt to do exactly that; it is never a lock. **After a failure past step 3 the browsers are already
 * signed out**, so the retry is to sign in again — which provisions a fresh, empty org under the same
 * ids, because the portal still vouches for the person — and press the button again.
 *
 * ## Who may call it
 *
 * Owner only, with the typed confirmation, in server mode only. The role comes from the resolved
 * `TenantContext` — the membership row, not anything the client sent — and the desk keeps its own
 * "Start over" untouched, which is why `scope: "all"` stays refused here and `scope: "tenant"` is
 * refused there. Neither mode can reach the other's button. The mutating request is CSRF-checked by
 * the HTTP adapter like every other POST under `/api` (`http-adapter.ts` `mutatingRejection`), and the
 * confirmation is compared **here**, on the server, against the word the owner actually typed.
 *
 * **Who is an owner (SR-65, closed 2026-10-01).** The role on the resolved tenant is the membership row's,
 * and the row is the portal's word: the portal sends `role` (`owner` | `admin` | `member`) in every token
 * body, `ensurePortalOwner` writes it at sign-in, and every refresh re-applies it (`syncPortalRole` through
 * `portal-check.ts`), in both directions. The host has no default of its own — a missing or unknown role is
 * a `member` — so a colleague who signs in is never an owner by having signed in. Until 2026-10-01 the
 * portal sent no role and every sign-in wrote an `owner` row, which made this check stop nobody. A role the
 * portal changed reaches this check within one portal re-check (10 minutes of activity); the erase itself
 * does not ask the portal again.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, isServerMode, TENANT_ERASE_CONFIRM_WORD, type TenantContext } from "@agentforge/core";
import { purgeTenantRows, sql, tenantSessionSeals } from "@agentforge/db";
import { getLocalVaultKey, localDataDir } from "@agentforge/db/vault-key";
import { configuredClientCredentials, hostPortalClient } from "./auth";
import type { PortalClient } from "./auth/portal-client";
import { endPortalSessionsBestEffort, type PortalSignOutReport } from "./auth/portal-sign-out";
import { log } from "./log";
import { clearGateState } from "./gateway-gate";
import { clearGatewayKeyEverywhere } from "./settings-store";
import { clearThisKeyCache } from "./account-usage";
import { resetEmbedCircuit } from "./knowledge-embed";
import { resetModelReliabilityState } from "./job-model-fallback";
import { assertPurgeableTenant, purgeProgressOf } from "./tenant-object-keys";
import { resolveTenantPurgeRoot, tenantScopedRoot } from "./tenant-paths";
import { forgetTenantJobBytes, tenantObjectStore } from "./tenant-storage";

/**
 * The phrase the owner types — `TENANT_ERASE_CONFIRM_WORD` ("DELETE"), and **not** the desk's `RESET`.
 *
 * Owner decision 2026-10-01: this act deletes every person in the company and signs them all out, so
 * it asks for its own word, and a client that still sends `RESET` is refused with a 400 instead of
 * being let through on the lighter one. A fixed word rather than the company's name because the host
 * holds no reliable name — the portal sends ids, and `ensurePortalOwner` writes the org id as its
 * name. The scope still distinguishes the two acts on the wire, and each mode refuses the other's
 * scope outright.
 */
export const TENANT_RESET_CONFIRM_WORD = TENANT_ERASE_CONFIRM_WORD;

/**
 * What the audit row's `detail` says when the best-effort portal sign-out fell short: a person the
 * portal refused, a portal nobody could reach, a token that would not open, or a call still running
 * when the budget ran out. A fixed phrase, like every other value in that column.
 */
export const PORTAL_SIGNOUT_INCOMPLETE_DETAIL = "portal_signout_incomplete";

export const TENANT_RESET_DISABLED_CODE = "tenant_reset_disabled";
export const TENANT_RESET_DISABLED_MESSAGE =
  "Erasing an account is only available on the hosted service. On this machine, use Start over.";

export const TENANT_RESET_FORBIDDEN_CODE = "tenant_reset_forbidden";
export const TENANT_RESET_FORBIDDEN_MESSAGE =
  "Only an owner of this account can erase it. Ask an owner to do it.";

export type TenantResetOutcome = {
  readonly ok: true;
  readonly auditId: string;
  readonly rowsDeleted: number;
  readonly objectsDeleted: number;
  readonly bytesFreed: number;
  /**
   * Always true: the caller was one of the people erased, and their session row went with the rest.
   * There is no home desk to land on any more, so the renderer signs out instead.
   */
  readonly signedOut: true;
  /** What the best-effort portal sign-out reached. Counts only, never a token. */
  readonly portalSignOut: PortalSignOutReport;
};

/** Seams for a test; the route passes none and gets the process's own portal client and wrap key. */
export type TenantResetDeps = {
  readonly portal?: PortalClient;
};

/**
 * The shared roots that hold this tenant's bytes outside the object store.
 *
 * Shared roots rather than tenant paths, because the guard in `removeTenantRoot` canonicalises the
 * root as well as the subtree and so has to be handed the root itself; `tenantPurgeRoots` below is
 * the same list with the tenant's prefix applied, for callers that only want to name the paths.
 *
 * Lane D's layout, read back: a hosted tenant's files live under `tenants/<id>/` inside each shared
 * root. The data directory itself covers the ffmpeg scratch, the knowledge uploads, the object
 * cache and — on a deployment that has not adopted the `tenant_state` rows — the settings envelope
 * and the gate verdict. The other four are the shared roots that are not the media root, which the
 * object store owns.
 *
 * Declared here rather than derived from `tenantJobRoots` because the two answer different
 * questions: that one is "what does this tenant get charged for" (and deliberately excludes the
 * host's own object cache), this one is "what has to go". A byte the host cached on the tenant's
 * behalf is not the tenant's to be charged for and IS theirs to have deleted.
 */
export function tenantPurgeSharedRoots(): string[] {
  const dataDir = localDataDir();
  return [
    dataDir,
    path.join(dataDir, "datasets"),
    path.join(dataDir, "meetings"),
    path.join(dataDir, "legal"),
    path.join(dataDir, "channels"),
  ];
}

/** The same five roots, as the tenant-scoped directories they resolve to. */
export function tenantPurgeRoots(tenantId: string): string[] {
  return tenantPurgeSharedRoots().map((root) => tenantScopedRoot(root, tenantId));
}

/**
 * Remove one shared root's tenant subtree, having proved that it really is this tenant's.
 *
 * The spelling is checked by `tenantScopedRoot` and the inode by `resolveTenantPurgeRoot`, which
 * canonicalises the shared root as well as the candidate and requires the result to land inside
 * `realpath(<root>)/tenants/<id>`. That last part is the whole check: a symlink planted at
 * `tenants/<id>/` passes any lexical test while pointing anywhere, and — the case a guard written
 * against the shared root alone lets through — the targets worth pointing it at are all *inside*
 * that root. `tenants/<beta>`, `tenants/` and `<dataDir>/media` are each inside the data
 * directory, so "does it still resolve under the data directory?" is a test they all pass.
 *
 * This function's whole job is a recursive delete, so it deletes the path it checked and refuses
 * rather than guesses.
 */
async function removeTenantRoot(sharedRoot: string, tenantId: string): Promise<void> {
  const target = resolveTenantPurgeRoot(sharedRoot, tenantId);
  if (target.kind === "refused") {
    throw new ApiError(
      "tenant_reset_refused",
      "A per-tenant path does not resolve inside this tenant's own subtree of the data directory.",
      500,
    );
  }
  if (target.kind === "nothing") {
    // Nothing on disk at that path. Nothing to delete, and nothing to be wrong about.
    return;
  }
  await rm(target.path, { recursive: true, force: true });
}


type AuditRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly organizationId: string;
};

function openAudit(tenant: TenantContext): AuditRow {
  const row: AuditRow = {
    id: randomUUID(),
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    organizationId: tenant.organizationId,
  };
  sql
    .prepare(
      `INSERT INTO tenant_reset_audit
         (id, tenant_id, user_id, organization_id, outcome, detail, rows_deleted, objects_deleted, bytes_freed, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'started', NULL, 0, 0, 0, ?, NULL)`,
    )
    .run(row.id, row.tenantId, row.userId, row.organizationId, Date.now());
  return row;
}

function closeAudit(
  row: AuditRow,
  outcome: "completed" | "failed",
  totals: { rowsDeleted: number; objectsDeleted: number; bytesFreed: number },
  detail: string | null,
): void {
  sql
    .prepare(
      `UPDATE tenant_reset_audit
          SET outcome = ?, detail = ?, rows_deleted = ?, objects_deleted = ?, bytes_freed = ?, finished_at = ?
        WHERE id = ?`,
    )
    .run(outcome, detail, totals.rowsDeleted, totals.objectsDeleted, totals.bytesFreed, Date.now(), row.id);
}

/**
 * A fixed phrase for the audit row, never the thrown message.
 *
 * A storage error carries a bucket name and a request id; a SQLite error carries an absolute path.
 * The operator reads the real thing in the log, where it is already written with its stack. This
 * column is read back into an API response, so it holds a category and nothing else.
 */
function auditDetail(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code;
  }
  return "unexpected_error";
}


/** True when the best-effort sign-out left somebody at the portal who should not be there. */
function portalSignOutFellShort(report: PortalSignOutReport): boolean {
  return report.failed + report.unreachable + report.unfinished > 0;
}

/**
 * Sign the people the erase just deleted out of the portal, with the refresh tokens read before the
 * purge. Never rejects: `endPortalSessionsBestEffort` answers every failure as a count, and the
 * construction below is the only code that could throw before it, so it is inside the same guard.
 */
function signOutAtPortal(
  tenant: TenantContext,
  seals: ReturnType<typeof tenantSessionSeals>,
  deps: TenantResetDeps,
): Promise<PortalSignOutReport> {
  const people = new Set(seals.map((seal) => seal.userId)).size;
  try {
    return endPortalSessionsBestEffort(seals, {
      portal: deps.portal ?? hostPortalClient(),
      wrapKey: () => getLocalVaultKey(),
      clientCredentials: () => configuredClientCredentials(),
      tenantId: tenant.tenantId,
    });
  } catch (error) {
    log.warn("tenant_erase_portal_signout_failed", { tenantId: tenant.tenantId, error });
    return Promise.resolve({ people, signedOut: 0, failed: people, unreachable: 0, unfinished: 0 });
  }
}

/**
 * Erase this company account: its content, its people and every session. See the module comment for
 * the order and the reasoning.
 *
 * `confirm` is what the owner actually typed, compared here rather than by the caller: a route that
 * trusted its own constant would let a mismatched confirmation box through on the renderer's say-so
 * instead of the owner's.
 */
export async function resetTenant(
  tenant: TenantContext,
  confirm: string | undefined,
  deps: TenantResetDeps = {},
): Promise<TenantResetOutcome> {
  if (!isServerMode()) {
    throw new ApiError(TENANT_RESET_DISABLED_CODE, TENANT_RESET_DISABLED_MESSAGE, 403);
  }
  // Owner, not merely an administrator: this is the most destructive thing a session can do and it
  // is not reversible. `canAdminister` would also admit `admin`, which is the right bar for
  // changing settings and the wrong one for deleting every person in the company.
  if (tenant.role !== "owner") {
    throw new ApiError(TENANT_RESET_FORBIDDEN_CODE, TENANT_RESET_FORBIDDEN_MESSAGE, 403);
  }
  if (confirm !== TENANT_RESET_CONFIRM_WORD) {
    throw new ApiError(
      "invalid_request",
      `confirm must be "${TENANT_RESET_CONFIRM_WORD}" to erase this account`,
      400,
    );
  }
  // The local tenant's prefix is the whole store (lane D), so a mis-resolved id must hit a wall
  // here — before the audit row, before the transaction — rather than an `rm -rf`.
  assertPurgeableTenant(tenant.tenantId);

  const audit = openAudit(tenant);
  const totals = { rowsDeleted: 0, objectsDeleted: 0, bytesFreed: 0 };
  try {
    // 2. The sealed refresh tokens, while the rows that hold them still exist.
    const seals = tenantSessionSeals(sql, tenant.tenantId);

    // 3. The rows, the sessions and the people, in one transaction. Nothing on disk has been touched
    //    yet, so a failure here leaves the tenant exactly as they were.
    const purged = purgeTenantRows(sql, tenant.tenantId);
    totals.rowsDeleted = purged.rowsDeleted;

    // 6. The portal, started now and awaited last: the tokens are in memory only from here, and the
    //    call must happen even if a storage step below throws.
    const portalSignOut = signOutAtPortal(tenant, seals, deps);

    // 4. The objects, through the store the deployment is configured for.
    const removed = await tenantObjectStore().removePrefix(tenant.tenantId);
    totals.objectsDeleted = removed.objectCount;
    totals.bytesFreed = removed.usedBytes;

    // 5. The bytes the store does not hold.
    for (const root of tenantPurgeSharedRoots()) {
      await removeTenantRoot(root, tenant.tenantId);
    }
    forgetTenantJobBytes(tenant.tenantId);

    // ...and anything this process is still holding about them. `clearGatewayKeyEverywhere` and
    // `clearGateState` are the same two calls "forget my key" makes, so a tenant who erases is left in
    // exactly the state a tenant who signed out of the gateway is.
    clearGatewayKeyEverywhere(tenant);
    clearGateState(tenant);
    clearThisKeyCache();
    resetEmbedCircuit();
    resetModelReliabilityState();

    const signedOutAtPortal = await portalSignOut;
    closeAudit(
      audit,
      "completed",
      totals,
      portalSignOutFellShort(signedOutAtPortal) ? PORTAL_SIGNOUT_INCOMPLETE_DETAIL : null,
    );
    log.warn("tenant_reset_completed", {
      tenantId: tenant.tenantId,
      auditId: audit.id,
      rowsDeleted: totals.rowsDeleted,
      objectsDeleted: totals.objectsDeleted,
      bytesFreed: totals.bytesFreed,
      sessionsDeleted: purged.sessionsDeleted,
      usersDeleted: purged.usersDeleted,
      portalPeople: signedOutAtPortal.people,
      portalSignedOut: signedOutAtPortal.signedOut,
      portalFailed: signedOutAtPortal.failed,
      portalUnreachable: signedOutAtPortal.unreachable,
      portalUnfinished: signedOutAtPortal.unfinished,
    });
    return {
      ok: true,
      auditId: audit.id,
      rowsDeleted: totals.rowsDeleted,
      objectsDeleted: totals.objectsDeleted,
      bytesFreed: totals.bytesFreed,
      signedOut: true,
      portalSignOut: signedOutAtPortal,
    };
  } catch (error) {
    // A backend that refused half way through the prefix carries out what it had already deleted,
    // so the audit row reports a partial delete rather than the zero it would otherwise inherit
    // from the assignment that never ran.
    const partial = purgeProgressOf(error);
    if (partial) {
      totals.objectsDeleted = partial.objectCount;
      totals.bytesFreed = partial.usedBytes;
    }
    closeAudit(audit, "failed", totals, auditDetail(error));
    log.error("tenant_reset_failed", { tenantId: tenant.tenantId, auditId: audit.id, error });
    throw error;
  }
}
