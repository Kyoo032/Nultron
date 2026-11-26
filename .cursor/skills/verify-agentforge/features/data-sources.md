# Data Sources (F1)

Settings-hub tab at `/data-sources` (`settings-tab-data-sources`, `data-sources-page`): connect a read-only S3 bucket or Postgres database, test it, sync objects into the Knowledge Base, disable, and remove credentials. How it works: [`maps/data-sources.md`](../../../../docs/internal/maps/data-sources.md). Not a product mode — `mode-data-sources` must have count 0.

Product: both · Instance: hosted (the desk API is tenant-scoped; `:3000` drives the surface only)

## Sub-features

- **data-sources-list** — `GET /api/v1/data-sources` (gate `read`): name, kind, status, `secretLast4`, last sync. The API never returns a secret or a sealed field — `secrets-never-returned` is proven in `handlers/data-sources.test.ts` (W1.6), not by the page.
- **data-sources-add** — one form switches config fields on the kind select; MySQL and Azure Blob are disabled options (`driver_missing` 501 until Rizky's `mysql2` decision, W3 respectively). `POST` is `administer` only — member and auditor are refused (W1.7).
- **data-sources-test** — Test connection does a live ListObjectsV2 `max-keys=0` for S3 and a real `pg` connect for Postgres, both through `assertAllowedDestination` + `resolvePinnedDestination`: an off-allowlist host fails `invalid_destination` before DNS, a private address fails unless the allowlist row has `allowPrivate`, and a rebinded answer is refused (W1.9).
- **data-sources-sync** — S3 objects → `extractFile` → `indexKnowledgeSource` (≤ 25 MB each); they show under `knowledge-synced-sources` on the Knowledge page (origin `data_source`).
- **data-sources-disable** and **data-sources-creds-remove** — disable keeps the row; removing credentials wipes `secret_sealed` and disables.
- **data-sources-allowlist** — `destination_allowlist` rows are written only by `pnpm --filter @agentforge/host allowlist add|remove|list` (operator CLI, audited as `operator`), each carrying an HMAC; a MAC-tampered row is ignored (W1.10).
- **data-sql-query-tool** — `data_source_query` answers read-only SELECTs against allowlisted tables through the pinned connection (`sql-guard.test.ts`); a non-allowlisted table is refused and audited (W1.2/W1.3), and a write is refused even for a write-capable login (W1.4).

## How to get to it (user POV)

Rail → Settings hub (`settings-link`) → **Data Sources** tab (`settings-tab-data-sources`), or `http://127.0.0.1:3000/data-sources` directly.

## Driving it with the Nultron harness

**Surface check, no connectors (the floor).** `goto /data-sources`, settle. `data-sources-page` is visible; the kind select offers S3 and Postgres enabled and MySQL/Azure Blob disabled; the empty hint shows. `mode-data-sources` has count 0.

**API proof without a browser.** `packages/host/src/handlers/data-sources.test.ts` covers W1.6 (no secret echoed), W1.7 (member/auditor refused), W1.10 (MAC-tampered allowlist row ignored), W1.12 (audit on add/disable/credential delete) and the `driver_missing` refusals. `tcp-pin.test.ts` covers W1.9; `sql-guard.test.ts` covers W1.4; `s3.test.ts` covers SigV4 against the AWS test vectors.

**Live proof.** Needs an operator allowlist entry (`allowlist add <host> <port>`), a real MinIO/S3 or Postgres, and the hosted compose rehearsal — there is no stub backend. Do not run this on the operator's `:3000`.
