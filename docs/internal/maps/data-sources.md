# Map — Data sources (F1: read-only storage and DB connectors)

Product: both · Instance: hosted (server mode); the desk API is tenant-scoped

Last verified: 2026-11-26, working tree on `devin/1795703673-data-sources`, not committed, for the whole page (read from `packages/host/src/data-sources/`, `handlers/data-sources.ts`, `security/tcp-pin.ts`, migrations `0027`/`0028`, proven by `data-sources.test.ts`, `tcp-pin.test.ts`, `sql-guard.test.ts`, `s3.test.ts`, `migrate-0027.test.ts`, `migrate-0028.test.ts`, `safe-fetch.test.ts`; not driven in a browser).

## Overview

F1 lets an owner connect an external store — S3-compatible object storage (W1), PostgreSQL (W1),
MySQL (held behind the `mysql2` driver decision, S5) and Azure Blob (W3) — strictly read-only.
Two hard walls hold it:

1. **Destination allowlist.** `assertAllowedDestination` (`packages/core/src/security/safe-fetch.ts`)
   refuses any `host:port` with no row in `destination_allowlist` (migration `0028`), before DNS.
   Rows are written by the operator CLI `packages/host/scripts/destination-allowlist.ts` — never the
   desk API — and carry an HMAC over `tenant|host|port|allowPrivate` under `HKDF(wrapKey,
   "destination-allowlist-v1")`; a tampered row is ignored and logged (`security:` prefix).
2. **Resolve-and-pin.** `resolvePinnedDestination` (`packages/core/src/security/tcp-pin.ts`)
   resolves through `resolvePublicAddresses` (the same public-IP check `fetchPublicHttps` uses) and
   returns a `pinnedLookup` that answers only the pinned host with only the verified addresses —
   a DNS answer that flips private *after* the allowlist check is refused, and a lookup for any
   other name fails `ENOTFOUND`. `allowPrivate` on a row is the only way a private destination
   (a MinIO in the LAN, say) is allowed at all.

Credentials and config seal under `HKDF(wrapKey, "data-source-v1")` (`store.ts`); the API never
returns a secret — `secretLast4` is the most a response carries. Every add, test, sync, disable
and credential delete reports `data_source.add` / `.change` / `.access` with actor and outcome,
never content.

## The connectors

- **S3** (`data-sources/s3.ts`): hand-rolled SigV4 (`node:crypto` HMAC chain over the canonical
  request, no new dependency) through `fetchPublicHttps`, so every request is allowlist-checked,
  TLS-pinned and private-IP-refused. `list` walks `?list-type=2` with continuation tokens;
  `fetch` is `GET` with a byte cap (`AGENTFORGE_DATA_SYNC_MAX_BYTES`, default 25 MiB).
  Test-connection is `ListObjectsV2` with `max-keys=0`.
- **Postgres** (`data-sources/postgres.ts`): `pg` (already a portal dependency) connecting to
  `pinned.address` with `servername` set to the configured hostname for TLS. The guard is
  `assertReadOnlySelect` (`sql-guard.ts`): one statement, `SELECT`/`WITH` first, no comments,
  no `$`-bodies, and a FORBIDDEN set covering DDL/DML/`INTO`/`FOR`/session and side-effect
  functions (`set_config`, `nextval`, `pg_advisory_*`, …). Statement keywords are refused as
  bare words, but the forbidden functions only when actually called (the word followed by `(`),
  so a column that shares a function's name — `SELECT http FROM request_logs` — still reads
  (2026-11-26, QA regression `sql-guard.test.ts`). Even past it, the runner wraps the
  query in `BEGIN READ ONLY` + `SET LOCAL statement_timeout` + a row cap, so a write-capable
  login still cannot write.
- **MySQL / Azure Blob**: `POST` returns `501 driver_missing` — MySQL waits on Rizky's `mysql2`
  call (S5), Azure Blob is W3.

## The desk API

`packages/host/src/handlers/data-sources.ts` registers:

| Route | Gate | Purpose |
|---|---|---|
| `GET /api/v1/data-sources` | `read` | List (member sees metadata only) |
| `POST /api/v1/data-sources` | `administer` | Create + seal |
| `POST /api/v1/data-sources/:id/test` | `administer` | Live test through the allowlist |
| `POST /api/v1/data-sources/:id/sync` | `administer` | Pull objects into the KB |
| `POST /api/v1/data-sources/:id/disable` | `administer` | Soft-disable |
| `DELETE /api/v1/data-sources/:id/credentials` | `administer` | Wipe `secret_sealed`, disables |

The mutation routes sit in `ADMINISTER_ROUTES` (`role-policy.ts`), so member and auditor are
refused before the handler. A strict schema per kind splits config and secret fields, so a
`name` or a credential never lands in the config blob.

## Sync into the KB

`data-sources/sync.ts` reads the sealed config, lists objects, extracts text with the same
`extractFile` path the upload route uses (25 MB per file, magic-byte checked), and indexes
through `indexKnowledgeSource` with `origin: { kind: "data_source", id: "<source id>/<object key>" }` —
which is what the Knowledge page's *Synced sources* section (`knowledge-synced-sources`) filters on.
The composite origin is why the orphan sweep's `data_source` arm matches on the id-plus-`/` prefix
(`knowledge.ts` `orphansOfKind`; SR-220: bare-id matching swept every synced card on the next
Knowledge read). Each run is
a row in `data_source_sync_runs` with file counts and an error code; `last_sync_*` on the source
carries the last outcome. There is no scheduler — W1 is manual sync only (the daily job is part
of the same requirement but lands with the scheduler work, not this page).

## The agent tool

`dataSourceQueryTool` (`query-tool.ts`) is a NEW registered tool (`register-tools.ts`), not a
`run_sql` extension: it opens a read-only path through the same pinned connection and guard, and
answers only tables on the source's sealed `table_allowlist` — an empty allowlist fails closed.
It never returns credentials, and the refusal paths (`off-allowlist`, `sql_read_only`,
`invalid_destination`) are themselves audited.

## UI

Settings hub tab `data-sources` (`apps/web/components/settings-shell.tsx`,
`settings-tab-data-sources`) → `/data-sources` (`apps/web/src/App.tsx`) →
`data-sources-page.tsx`: the source list (status, last4, last sync), per-source
Test/Sync/Disable/Remove-credentials, and one add form that switches config fields on kind —
MySQL and Azure Blob are disabled options with the reason. Locale keys under
`settings.dataSources.*` in `en`/`id`/`settings.json`; the KB badge uses
`knowledge.sources.syncedTitle`.

## Out of scope (this page does not cover)

- `mysql2` driver — pending Rizky (S5).
- Azure Blob connector — W3.
- The scheduled daily sync — lands with the scheduler work.
- `OPEN_DATA_SQL` on the desk's own SQLite — unrelated; that is the internal `sql-guard` for
  `run_sql`/`mcp` tools, not this one.
