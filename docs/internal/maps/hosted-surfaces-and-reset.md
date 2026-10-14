# Map — Hosted surfaces, per-tenant reset and health

Product: both · Instance: hosted (review :3443 for live proof; no :3000 drive)

Last verified: 2026-10-07 in the `feat/hosted-run-limits` working tree (uncommitted), for one added step in the erase's checks (§ 2, step 5: refused on a partner that holds more than one company, SR-163 review round; read from `tenant-reset.ts`, proven by `tenant-reset-companies.test.ts`, not driven on a hosted server); every other line is as verified below. Before that: 2026-10-01 at 0b61a29 + uncommitted tree, a third time that day, for the erase panel at a phone's width (§ 2, the paragraph on the screen): the final button is full width under the phrase box and its label is two lines at most, measured in a browser at 360, 400 and 1180 px against faked host answers. Before that, a second time that day, for **who is an owner** (§ 2): the portal now
sends `role` and the host writes and re-applies it, so the owner-only check stops a colleague (SR-65, second hole); the
screen shows the button to an owner only. Before that, for the Erase account rewrite (§ 2): owner decision
2026-10-01 on [SR-65](../security-register.md#sr-65) — erasing the company account deletes every person in
it and ends every session. Unit-tested and driven in a real browser against faked host answers; **not driven
against a real hosted instance** (the Kubernetes rehearsal owns that). Before that: 2026-09-21 at 1b73999 plus
this branch (Phase 8); re-stamp with the merge sha. Re-checked 2026-09-23 at d4561b8 + uncommitted tree: the
Storage card row's citation.

## Overview

Phase 8 of the web migration: the last phase. Three things live here. **Capability flags** are one
resolved answer to "what can this deployment do", put on `GET /api/v1/ping` by the host and read by
the renderer, so a control that is Electron-only is hidden where it cannot work and refused by its
own route if somebody calls it anyway. **The per-tenant reset** is the hosted account erase — the
answer to "Start over" for somebody who does not own the machine, and since 2026-10-01 the end of the
company's account: its content, every person in it and every session. **Health** is two routes: an
unauthenticated liveness probe for the proxy and the container, and a session-gated readiness
report for an operator.

Folded in from Phase 6 and listed here because they share the same screens: the storage-usage card,
`DELETE /api/v1/media/:mediaId`, and the quota check rewritten as a conditional SQL update.

What this page is **not**: the transport contract (that is
[hosted-server-mode.md](hosted-server-mode.md)), the object store itself
([tenant-object-storage.md](tenant-object-storage.md)), or the desktop's own "Start over"
([settings-and-gateway-gate.md](settings-and-gateway-gate.md)), which is unchanged.

## How it works

### 1. One switch, twelve flags

`hostCapabilities(env = process.env)` (`packages/core/src/capabilities.ts:89-108`) resolves every
flag from `isServerMode(env)` (`packages/core/src/server-mode.ts:12`) and from nothing else. Each
flag is true on exactly one of the two targets, which
`packages/core/src/capabilities.test.ts:35-45` asserts as a rule rather than as twelve assertions —
a thirteenth flag added without a decision fails there.

| Flag | True on | What it governs |
|---|---|---|
| `sessions` | server | a browser session exists at all |
| `singleOwner` | desk | one local owner, no sign-in |
| `storageQuota` | server | the ceiling and the usage card |
| `objectStorage` | server | bytes live behind the store, not on this disk |
| `plans` | server | the Phase 5 allowance and seats |
| `relaunch` | desk | the shell can restart itself |
| `updater` | desk | the auto-updater |
| `nativeFilePicker` | desk | the OS file dialog |
| `localPaths` | desk | a caller-named path may be read |
| `startOver` | desk | `scope: "all"`, the data-dir wipe |
| `tenantReset` | server | `scope: "tenant"`, the account erase |
| `componentInstall` | desk | a runtime component install |

They ride on ping: `handlePing` (`packages/host/src/handlers/misc.ts:101`) puts `capabilities` in the
body. Ping is the right home because it is ungated, it is the renderer's first fetch on boot, it is
identical over both transports, and it carries nothing per-tenant — none of which is true of
`GET /api/v1/settings`.

The renderer reads it once. `pingOnce()` (`apps/web/lib/host-ping.ts:20-25`) memoises the promise,
so the brand provider and the capabilities provider share one request — two would race to mint the
CSRF cookie on the first `/api` GET and one would lose its token.
`HostCapabilitiesProvider` (`apps/web/lib/host-capabilities.tsx:61`) puts the parsed answer in
context; `EVERYTHING_OFF` (`:29`) is what a consumer reads before ping answers and what it keeps if
ping fails. `parseCapabilities` (`packages/core/src/capabilities.ts:117`) reads every unknown as
`false`, so a surface stays hidden until the host has said it exists.

`relaunch`, `updater` and `nativeFilePicker` are ANDed with the bridge by their consumers —
`hasDesktopShell` and `hasNativeFilePicker` (`apps/web/lib/host-capabilities.tsx:44`, `:50`) — because
the host can only say a shell is *possible* here; only the renderer sees whether a preload attached.
That is the distinction `isElectron()` alone could never draw: it is false on webdev and on the
hosted server alike, and webdev has "Start over" while the hosted server must not.

**A hidden button is a courtesy; the refusal is the control.** Every flag has a route behind it:

| Surface | Flag that hides it | Route that refuses it | Code | Test |
|---|---|---|---|---|
| Start over | `startOver` | `POST /api/v1/settings/reset` `scope: "all"` | `RESET_DISABLED_CODE` 403 (`packages/host/src/handlers/settings.ts:385`, refused in `resetEverything` at `:426`) | `packages/host/src/tenant-reset.test.ts` |
| Erase account | `tenantReset` | same route, `scope: "tenant"` | `TENANT_RESET_DISABLED_CODE` 403 (`packages/host/src/tenant-reset.ts`, refused in `resetTenant` at `:298`) | `packages/host/src/tenant-reset.test.ts` |
| Native file picker | `nativeFilePicker` | — (renderer only; the import route is the control) | `apps/web/components/edit-studio.tsx` | `apps/web/lib/host-capabilities.test.tsx` |
| Import by path | `localPaths` | `POST /api/v1/edit/projects/:projectId/import` with `sourcePath` | `LOCAL_PATH_DISABLED_CODE` 403 (`packages/host/src/handlers/edit.ts:204`, refused in `handlePostEditImport` at `:227`) | `packages/host/src/edit/local-path-refusal.test.ts` |
| Component install | `componentInstall` | `POST /api/v1/components/install` | `install_disabled` 403 (Phase 7) | `packages/host/src/components/server.test.ts` |
| Relaunch / updater | `relaunch`, `updater` | — (IPC only; there is no hosted transport for them) | `apps/web/components/settings-reset-card.tsx` | `apps/web/lib/host-capabilities.test.tsx` |
| Storage card | `storageQuota` | `GET /api/v1/storage/usage` answers a desk with `limitBytes: null` | the `storageQuota` guard, `apps/web/components/settings-storage-card.tsx:146` | `apps/web/lib/host-capabilities.test.tsx` |

Nothing is deleted from the desktop build; every rule above is a branch on one flag, and with the
flag off the code takes the path it took before.

### 2. Erase account (the per-tenant reset)

**Owner decision 2026-10-01 ([SR-65](../security-register.md#sr-65)): erasing the company account deletes
every person in it and ends every session.** Until then this was a *reset* — it emptied the account, kept
everybody signed in, and re-provisioned the org and its memberships so the account carried on. It is now the
end of the company: content, people and sessions go together, and nothing is put back.

`POST /api/v1/settings/reset` with `{ scope: "tenant", confirm: "DELETE" }`. A **third scope** rather
than a hosted branch inside `"all"`, so an existing desk client's request never changes meaning and
neither target's button can reach the other's behaviour (`packages/host/src/handlers/settings.ts:505`;
`RESET_SCOPES` in `apps/web/lib/reset-app.ts`). The typed word is `TENANT_ERASE_CONFIRM_WORD`
(`packages/core/src/gateway/reset-types.ts`), **not** the desk's `RESET`: a stale client that still sends
`RESET` gets a 400 and deletes nothing. A fixed word and not the company's name, because the host holds no
reliable name — the portal sends ids and `ensurePortalOwner` writes the org id as the org's name. The mutating
request is CSRF-checked by the HTTP adapter like every other POST under `/api`
(`packages/host/src/http-adapter.ts:633`); the confirmation is compared **on the server**.

`resetTenant(tenant, confirm, deps?)` (`packages/host/src/tenant-reset.ts:292`) refuses in this order, and
every refusal happens before anything is deleted:

1. off server mode → `TENANT_RESET_DISABLED_CODE` 403 (`:298`)
2. `tenant.role !== "owner"` → `TENANT_RESET_FORBIDDEN_CODE` 403 (`:304`) — never `gateway_blocked`, and an
   `admin` is refused as well. The role is the membership row's, which is the portal's word (see **Who is an
   owner** below), read per request
3. wrong or missing confirmation → `invalid_request` 400 (`:306`)
4. `assertPurgeableTenant(tenant.tenantId)` (`packages/host/src/tenant-object-keys.ts:96`) → the
   local tenant's prefix is the whole store, so a mis-resolved id hits a wall before the `rm -rf`
5. `assertSinglePartnerCompany(tenant.tenantId)` (`packages/host/src/tenant-reset.ts`, SR-163 review round,
   2026-10-07) → **`409 tenant_erase_shared_partner`** when more than one `organizations` row sits under the
   partner. Everything below is partner-wide (`purgeTenantRows` deletes by tenant id, the object prefix and local
   roots are the partner's, every desk's key is cleared), so on a server that holds several companies under one
   partner an owner's erase would have deleted all of them; now it deletes nothing and says so ("This server holds
   several companies under one account ... Ask the operator of this server to erase this company."), shown by the
   panel as `settings.reset.eraseAccountShared`. Zero or one organisation proceeds exactly as before. **Scoping the
   purge to one company is still owed and is the owner's decision.** Test: `tenant-reset-companies.test.ts`.

Then, in order (`:317-370`): open an audit row as `started` → **read the sealed refresh tokens of the tenant's
live sessions** (`tenantSessionSeals`, `:321`) → `purgeTenantRows` in one transaction (content, **every
`auth_sessions` row, and the orphaned `user` rows**; `:325`) → start the best-effort portal sign-out (`:330`) →
`removePrefix` through the configured store → the local job trees → forget the memoised job bytes → clear the
gateway key, the gate verdict and the circuit breakers → await the portal sign-out → close the audit as
`completed`. A throw closes it `failed` with a category-only `detail` and rethrows. There is **no
re-provisioning step**: `ensurePortalOwner`, `readOrgMembers` and `restoreOrgMembers` are gone from this path.

**The caller is signed out too.** Their session row goes in the same transaction as the data, so there is no
moment when the data is gone and a session still answers; the next request from any of those browsers finds no
row and is `401 session_required` (`verifySession` on a null row, `packages/host/src/auth/session.ts:157`). The
answer carries `signedOut: true` (`handlers/settings.ts:482`) and **no cookie change**: the renderer follows with
the ordinary `POST /api/v1/auth/logout`, which is idempotent for a session that no longer exists, clears the
dead cookie and still answers with the portal's logout URL (`auth/routes.ts` `handleLogout`), so the portal's
30-day browser session cannot sign the next person straight back in ([SR-21](../security-register.md#sr-21)).

**What the purge takes is decided by the schema, not by a hand-written list.**
`packages/db/src/tenant-purge.ts` classifies every table into one of five buckets —
`CASCADED_TABLES`, `WORKSPACE_SCOPED_TABLES`, `TENANT_SCOPED_TABLES` (`:107`, now including `auth_sessions`,
`:120`), `KEPT_TENANT_TABLES` (`:129`) and `SHARED_TABLES` — and `packages/db/src/tenant-purge.test.ts` fails
when a real table is in none of them or in two. A table added later cannot silently survive an erase.
`purgeTenantRows` (`:262`) resolves the workspace ids and the tenant's people, deletes the workspace-scoped
tables per id, deletes `organizations WHERE tenant_id = ?` (`CASCADE_ROOT_TABLE`) and lets SQLite's cascade take
the rest, then the tenant-scoped tables (the sealed refresh tokens go with their rows), then
`deleteOrphanedUsers` (`:221`) — all inside one `sql.transaction`. `user` is shared across orgs and tenants, so a
person is deleted only when **no** membership of any org and **no** session in any tenant refers to them; one
person who also belongs to another company keeps their row and that company's membership.

Kept on purpose: `tenants`, `tenant_plan`, `tenant_seat`, `tenant_usage`, `billing_events` and
`tenant_reset_audit` (`KEPT_TENANT_TABLES`) — the contract, the plan, the invoices and the record of this act
are not the company's to erase. The tenant row stays `active`: **nothing stops a person the portal still
vouches for from signing in again**, which provisions a fresh, empty org under the same ids with that person as
`owner`. That is the portal gap below, and closing it (marking the tenant `inactive` so `resolvePortalTenant`
answers `tenant_inactive`) is an owner decision recorded in SR-65, not something this path does.

**The portal half, best effort** (`packages/host/src/auth/portal-sign-out.ts`,
`endPortalSessionsBestEffort`, `:163`). `apps/portal` has no call that removes a company or a member
(`src/routes/tokens.ts` carries `POST /auth/logout` and nothing administrative), and the host has no admin
credential for it. What it does have is `POST /auth/logout { all_devices: true }`, which ends every portal
session of the caller and the portal's own browser sessions. The host holds a refresh token for each browser
that is signed in to it, sealed on the session row; `tenantSessionSeals` reads them **before** the purge deletes
the only copy. Per *person* (not per browser) it opens a sealed token with the row's own id digest
(`openRefresh`), presents it once to get an access token, and signs the person out everywhere. It never throws,
spends at most `PORTAL_SIGN_OUT_WAIT_MS` (8 s) with six people in flight, runs beside the storage steps so a slow
portal adds nothing, and a shortfall is a count in the `tenant_reset_completed` log line and the audit row's
`detail` = `portal_signout_incomplete`. **It reaches only people with a live host session that held a sealed
token.** A member who was not signed in to the host is unreachable; the portal keeps their identity, their
membership and their portal sessions.

`rowsDeleted` counts only the rows the purge's own statements deleted (sessions and users included), not the
cascade, so it is a floor.

**Retry after a failure.** The storage steps are not atomic, so a bucket can refuse half way. After a failure
past the transaction **the browsers are already signed out**; the retry is to sign in again (which provisions a
fresh org under the same ids, because the portal still vouches for the person) and press the button again. The
steps are all deletes by id, so the second pass removes what the first missed and reports zero for the rest.

**Who is an owner (closed 2026-10-01, SR-65).** The portal sends `role` (`owner` | `admin` | `member`) in every token
body; `ensurePortalOwner` writes that membership role at sign-in and `syncPortalRole` re-applies it at every
refresh, in both directions, so a colleague who signs in is a `member` and the owner check above stops them. The
host has **no default role**: a missing or unknown role is a `member`. Before this fix the portal sent no role and
`ensurePortalOwner` wrote an `owner` row for everybody, so "owner" meant "signed in" and any colleague could erase
the whole company. How the role travels, and how fast a change arrives (the first request after the portal's
ten-minute re-check is due), is [portal-session-auth.md](portal-session-auth.md) § The role (2026-10-01). What the
erase does **not** do is ask the portal at the moment of the act, so a person demoted at the portal in the last ten
minutes can still erase until their session's next check.

**The audit row.** Migration `0020_tenant_reset_audit` (`packages/db/drizzle/0020_tenant_reset_audit.sql`,
journal `when` 1788820000013) exists because the erase destroys its own evidence. It hangs off
`tenants` — which an erase keeps — rather than `organizations`, which it deletes, so a cascade
from the org cannot take the audit trail with the thing it is auditing. `outcome` is a string, so a
killed process leaves a `started` row: a prompt to run the erase again, never a lock.

**The screen** (`apps/web/components/settings-erase-account.tsx`, rendered by `settings-reset-card.tsx` only
where `capabilities.tenantReset` is true **and the host reports the person's role as `owner`**: `useSession().identity.role`,
read from `GET /api/v1/auth/session`; an admin, a member, an unknown role and a signed-out browser do not see it — a
courtesy, the 403 above is the control) is a bright red button, **outside** the collapsed "Sign out and delete"
disclosure on purpose, that opens an `alertdialog`; a second red button inside it stays disabled until the exact
phrase `DELETE` is typed. The two clicks and the phrase are a reducer with no React in it
(`apps/web/lib/erase-account-flow.ts`), so a test can ask "can the final step happen without them?". Focus moves
into the phrase box on open and back to the red button on cancel, Escape cancels, and Enter in the box does
nothing. On success it leaves through the ordinary sign-out (`signOutAndLeave` in `account-session-row.tsx`).

**At a phone's width** the shell's rail, the page padding, the card and the panel leave the phrase box about 160 px at 360 px
and 200 px at 400 px, and the final button used to wrap its label onto three or four lines. The panel is a size container
(`panelClass`, `[container-type:inline-size]`), and the button row answers to the panel's own width (`buttonRowClass`):
under 22rem the final button is full width under the phrase box with Cancel below it, its warning mark is hidden and its
side padding is 8 px, so the English label breaks as `Permanently erase` / `company account`; from 22rem up they share a
row as before. The Indonesian label is `Hapus permanen akun perusahaan` (it was `Hapus akun perusahaan secara permanen`,
which needed three lines). `apps/web/lib/erase-account-narrow.test.tsx` holds the classes and a label budget (34
characters, no word over 17); the width itself is measured in a browser. The panel is Enterprise-only, so none of this reaches
Personal.

### 3. Health

**`GET /healthz` — liveness.** Answered in `packages/host/src/http-adapter.ts` (`respondLiveness`,
`:338`; the path test at `:480`), not in the router's table, because that table is `/api`-only and
`dispatch` never sees another path. That is also what keeps it out of the hosted session gate by
construction rather than by an entry in an exemption set.

The body is `LIVENESS_BODY` (`packages/host/src/handlers/health.ts:51`), a frozen literal with one
word in it. No version, no path, no tenant, no backend and no component list: this is the one route
on the box that answers a stranger, and every item on that list is reconnaissance handed over for
free. `Cache-Control: no-store`, because a proxy that cached "ok" would keep saying a dead process
is alive. HEAD gets the headers with the correct `Content-Length` and no body. Nothing is logged.

It runs **after** the transport filter in server mode (`http-adapter.ts:534`), so the request-line
filter, the method allowlist, the header cap and the per-IP bucket all apply to it. The one rule it
is exempt from is the TLS hop (`rejectPlaintext`, `:388`; `allowPlaintext` in `transportRejection`,
`:405`), because the caller it exists for is inside the box: `docker healthcheck` and Caddy's own
upstream probe hit the app's loopback port with no proxy in front of them, and a probe that refused
them could not tell an orchestrator the app is dead while the proxy is up. The carve-out is one path
wide — anything else on a plaintext hop is still `https_required`.

That carve-out is what lets the deploy tree stop forging the header. Since #68 the image's
`HEALTHCHECK` stamped `x-forwarded-proto: https` on its own request and probed `/api/v1/components`;
Phase 8 points it, Caddy's new `health_uri` and runbook check 1 at `/healthz` with no headers
(`webapp-deploy/Dockerfile`, `webapp-deploy/Caddyfile`, `docs/internal/tencent-cvm-setup.md`).

**`GET /api/v1/health` — readiness.** `handleGetHealth` (`packages/host/src/handlers/health.ts:187`),
session-gated, reporting `ready`, `mode`, `capabilities` and three checks:

| Check | What it does | Code |
|---|---|---|
| `database` | `SELECT 1`, nothing heavier | `:82` |
| `storage` | builds the configured store; does **not** reach the bucket, because a listing is a billed request | `:107` |
| `components` | `reportComponentStatus` per `COMPONENT_IDS`; `unsupported` is a fact about the platform, not a failure | `:132` |

Always HTTP 200, with the verdict in the body. A 503 is the other reasonable choice and it is the
wrong one here: this route is read by a person and by a support script, and every HTTP client in
between treats a 503 as a reason to retry, hide the body or serve a cached page — which loses the
diagnosis. The probe an orchestrator reads is `/healthz`, and that one is up or it is nothing.

`detail` is always a fixed phrase from this file and never a thrown message: a SQLite error names the
file's absolute path. The thrown message goes to the log instead. Neither route calls
`requireGatewayAllowed` — a tenant whose plan has blocked them must still be able to see whether the
box is healthy, or a support conversation starts with two unknowns instead of one.

### 4. Storage: the screen, the delete and the ceiling

`GET /api/v1/storage/usage` (`packages/host/src/handlers/storage.ts:32`) now also answers `largest`:
the biggest `LARGEST_OBJECT_LIMIT = 20` (`:30`) media rows, scoped by `organizationId` exactly as the
delete is, so every id on the list is an id the caller may then delete. One read feeds the whole
card, so the number and the things it is made of cannot disagree.

`SettingsStorageCard` (`apps/web/components/settings-storage-card.tsx`) renders only where
`storageQuota` is true. It is the screen Phase 6's deliberately-readable-while-blocked route was
for: the bar says how much is used, the list underneath is what to delete.

`DELETE /api/v1/media/:mediaId` (`packages/host/src/handlers/media.ts:82`) removes the object through
the store **first**, then the row, so the counter refund and the bytes move together. A row that is
not this tenant's, and a row that is already gone, get the same `{ ok: true, deleted: false }`: a 404
would confirm the id exists, and a delete that is safe to retry has to say `ok` for the object that
is already gone. The tenancy harness carries it as `indistinguishable` with that reasoning
(`packages/host/src/tenancy-harness.test.ts`), plus a survivor check that reads tenant A's row and
its bytes after tenant B has been through the whole table with A's id.

**The ceiling is now held by the row.** `reserveTenantStorageBytes`
(`packages/host/src/tenant-storage-store.ts:177`) is a single UPDATE whose WHERE clause carries the
test (`bytes_used + ? <= ?`), so SQLite evaluates it against the row under the row's own lock and
`changes()` is the verdict. It replaces Phase 6's per-tenant promise chain, which held for one
process and said so in its own comment; the CVM runbook's scaling step is a second app container
behind the same Caddy. `putTenantObject` (`packages/host/src/tenant-storage.ts:540`) seeds the
counter row from a real measure first, subtracts the measured job trees (and, since 2026-10-07, the
tenant's saved artifacts, read from their rows: `tenant-object-storage.md`) to get the budget, reserves,
and refunds with a negated delta if the put then fails.

## Where things live

| File | Role |
|---|---|
| `packages/core/src/capabilities.ts` | The twelve flags, resolved from `AGENTFORGE_SERVER`; `parseCapabilities` |
| `packages/host/src/handlers/misc.ts` | `handlePing` — where the flags reach the renderer |
| `apps/web/lib/host-ping.ts` | One memoised `GET /api/v1/ping` for every provider that reads it |
| `apps/web/lib/host-capabilities.tsx` | The context, the closed default, the two bridge-ANDed tests |
| `packages/host/src/tenant-reset.ts` | The host half of the account erase: the refusals, the order, the audit |
| `packages/host/src/auth/portal-sign-out.ts` | The best-effort portal sign-out of everybody the erase deleted |
| `packages/host/src/tenant-paths.ts` | `resolveTenantPurgeRoot` — the containment test in front of every recursive delete |
| `packages/host/src/tenant-object-keys.ts` | `assertPurgeableTenant`, and the partial totals a failed purge carries out |
| `packages/db/src/tenant-purge.ts` | Which tables an erase takes (sessions included), as a classification with a completeness test; `tenantSessionSeals`; the orphaned-user delete |
| `packages/db/drizzle/0020_tenant_reset_audit.sql` | The audit table; healer mirror in `ensure-schema.ts` |
| `packages/host/src/handlers/health.ts` | The liveness constants and the readiness route |
| `packages/host/src/health-db.ts` | Installs the database seam, imported by `router.ts` |
| `packages/host/src/http-adapter.ts` | Where `/healthz` is answered, and its one carve-out |
| `packages/host/src/handlers/storage.ts` | Usage plus `largest` |
| `packages/host/src/handlers/media.ts` | `handleDeleteMedia` |
| `packages/host/src/tenant-storage-store.ts` | `reserveTenantStorageBytes`, the conditional update |
| `apps/web/components/settings-storage-card.tsx` | The usage screen and the per-object delete |
| `apps/web/components/settings-reset-card.tsx` | Both resets, each behind its own flag |
| `apps/web/components/settings-erase-account.tsx` | The red button, the alert dialog and the typed phrase |
| `apps/web/lib/erase-account-flow.ts` | The two-click flow as a reducer: open, type, submit; nothing else can erase |
| `webapp-deploy/Dockerfile`, `webapp-deploy/Caddyfile` | Where the deploy tree probes `/healthz` from |

## Gotchas

- **A flag is never the control.** Every one of them has a route behind it with its own error code.
  The table in §1 is the list of both halves, and the lane record repeats it with the test that
  proves each refusal.
- **`isElectron()` is not "the desktop".** It is false on webdev too. Every rule that hung on it
  before Phase 8 was really saying "not the packaged app", which is why webdev had "Start over" and
  the hosted server would have had it too. Read the flags; AND the bridge only for the three
  surfaces that genuinely need a preload.
- **The erase keeps the money.** `tenant_plan`, `tenant_seat`, `tenant_usage` and `billing_events`
  survive. A tenant who erases their account is not erasing their invoice, and the allowance they
  have already spent does not come back.
- **The erase signs everybody out, and does not put anything back.** Since 2026-10-01 (SR-65) `auth_sessions`
  is a tenant-scoped table the purge deletes, and `user` rows nothing else refers to go with it. Do not
  "fix" a 401 after an erase by re-provisioning in `resetTenant`: that is the old design, and it kept every
  session working. The thing to remember is the other direction — the tenant row stays `active`, so a person
  the portal still vouches for can sign in again to an empty org of their own, as `owner`.
- **Read the sealed tokens before the purge, never after.** `tenantSessionSeals` has to run first: the purge
  deletes the rows, and with them the only copy of the refresh tokens the portal sign-out needs. A cookie id
  is not recoverable from the table (only its digest is stored), which is why the sign-out opens a token with
  `openRefresh(idHash, …)` and not through `check.refresh`.
- **A refresh that nobody is waiting for can still be a replay.** The portal sign-out presents each person's
  sealed token once. If that person's own browser happens to be refreshing the same token through the gate at
  that instant, the portal reads the second presentation as theft and revokes the chain — which is the outcome
  an erase wants anyway, but it lands as `refresh_reused`, a terminal reason `portal-sign-out.ts` counts as
  signed out.
- **"Owner" is the portal's word now, not "signed in".** `ensurePortalOwner` takes the portal's role (required;
  `null` writes a `member`), so the owner-only check on this route stops every colleague who is not an owner at the
  portal. A test that needs an owner or a member passes the role (`signIn(…, "member")` in `tenant-reset.test.ts`
  goes through the real `ensurePortalOwner` with it); `ensurePortalOwner(db, ids)` without a role no longer compiles.
- **The Erase button is owner-only on the screen too, and the host still decides.** The hosted card reads the role
  from `GET /api/v1/auth/session`. A host that sent none (an older build) shows no button at all; do not "fix" a
  missing button by defaulting the role to owner in the renderer.
- **The purge guard compares two canonical paths, not one.** `resolveTenantPurgeRoot`
  (`packages/host/src/tenant-paths.ts`) canonicalises the shared root as well as the candidate and
  requires the result to land inside `realpath(<root>)/tenants/<id>`. A guard that canonicalises
  only the candidate and asks "is it still under the root?" refuses nothing that matters: a symlink
  at `tenants/<alpha>` pointing at `tenants/<beta>`, at `tenants/` or at the media root is *inside*
  the root in every case. Both callers (`removePrefix` and `removeTenantRoot`) then delete the path
  they checked, never the one they looked up.
- **The reset does not stop in-flight jobs**, unlike the desk's `scope: "all"`, which calls
  `killTrackedChildren`. The tracker is process-wide with no tenant on it, so calling it here would
  kill every other tenant's ffmpeg. Open item in the lane record §9.
- **`/healthz` answers on a plaintext hop and nothing else does.** If a future change moves the
  liveness test above `transportRejection`, the rate limiter stops covering it.
- **Readiness does not reach the bucket.** A bucket that exists but refuses this key is what the
  first upload finds, not what this route reports. `recomputeTenantStorage` is the operator's tool
  for that.
- **The conditional update needs a row.** `reserveTenantStorageBytes` returns `false` when no
  counter row matches, deliberately: an INSERT at that point would start a tenant's accounting at
  zero on the word of the caller. `putTenantObject` seeds the row from a measure first.
- **Two writes of the same key can still over-count.** The conditional update enforces the ceiling;
  it does not make the counter exact under a same-key race. The drift over-charges the tenant rather
  than letting them past the ceiling, and `recomputeTenantStorage` reconciles it.

## Verify

`.cursor/skills/verify-agentforge/features/settings.md` — the Settings page carries both cards.
Testids: `settings-storage`, `settings-storage-used`, `settings-storage-full`,
`settings-storage-items`, `settings-storage-delete-<id>`, and for the erase `settings-reset-tenant-zone`,
`settings-reset-tenant` (the red first button), `settings-reset-tenant-confirm` (the alert dialog),
`settings-reset-tenant-warning`, `settings-reset-tenant-confirm-name` (the phrase box),
`settings-reset-tenant-submit` (the final button), `settings-reset-cancel`, `settings-reset-erased`, plus the
desk's unchanged `settings-reset-key` / `settings-reset-all`.

Suites: `packages/core/src/capabilities.test.ts`, `packages/db/src/tenant-purge.test.ts`,
`packages/db/src/migrate-0020.test.ts`, `packages/host/src/tenant-reset.test.ts`,
`packages/host/src/auth/portal-sign-out.test.ts`, `packages/host/src/portal-roles.test.ts`,
`packages/host/src/handlers/health.test.ts`, `packages/host/src/handlers/storage.test.ts`,
`packages/host/src/edit/local-path-refusal.test.ts`, `packages/host/src/http-adapter.test.ts`,
`apps/web/lib/host-capabilities.test.tsx`, `apps/web/lib/erase-account-flow.test.ts`,
`apps/web/lib/erase-account-panel.test.tsx`, `apps/web/lib/session.test.tsx`, `apps/web/lib/reset-app.test.ts`,
`apps/web/lib/settings-locales.test.ts`.

**What is proven and what is not (2026-10-01).** Unit and router tests drive the host against a real SQLite
database and the real `auth_sessions` store; the screen was driven in Chromium against the real renderer on
webdev with the ping, session, reset and logout answers faked at the browser (27 checks: red button, two clicks,
phrase gate, focus, Escape, Tab order, light, dark, Indonesian). **Who is an owner was driven (2026-10-01) on the local Kubernetes rehearsal** (Docker Desktop, the stand-in portal,
Mailpit, headless Chromium through the real invite and e-mailed-code sign-in): a member and an admin, each invited with
`invite.ts --role`, see no red button and get `403 tenant_reset_forbidden` from the erase route; the seeded owner sees the
button and gets `400 invalid_request` for a deliberately wrong word (past the owner check, nothing deleted — the probe
never sends the right word). A member who signed in on the build before the fix held an `owner` row and passed the owner
check; one request after the upgrade, once ten minutes had passed since the last check, the row was `member` and the
same probe was a 403. Roles changed at the portal (`invite.ts --role` on an active member) reached the row on the next
due check, both ways. Nobody was erased. **Not driven:** a real hosted instance with a
real portal (so the portal sign-out is proven against a fake client only), a real COS bucket, a company with more
than one real browser signed in.

The live tests this page cannot do — a real COS bucket, a reset on a tenant with real bytes, a
`docker healthcheck` against the container — are numbered in
[web-phase8-hosted-surfaces.md](../web-phase8-hosted-surfaces.md) §8.
