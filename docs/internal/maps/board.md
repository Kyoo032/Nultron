# Map: Team board (K0)

Last verified: 2026-10-13 at 823ea20c (uncommitted working tree on tester/chat-first, the K0 commit, after the K0 security review's fixes). Read from the code of that working tree. The host and renderer tests named below were run that day and passed. Driven in a browser on a local rehearsal of the hosted stack before the review fixes; the fixes themselves are proven by tests only (see "Not driven").

Tester code only (`TESTER.md`), lane `tester`. Spec: [`../team-board-spec.md`](../team-board-spec.md); Rizky accepted its defaults on 2026-10-13. This page covers phase K0: people only. Agents, personal stores, card files and mentions are K1 to K4. Recipe: [`features/board.md`](../../../.cursor/skills/verify-agentforge/features/board.md).

## Overview

A company desk on the hosted app gets one shared board: columns, cards, comments. Everyone on the desk sees a change as it is made, through a server-sent event stream. On Personal the board does not exist: every route answers the router's own 404, the rail shows no entry, and `/board` falls through to Chat.

Server mode is checked twice, on purpose. The handlers check `isServerMode()` (`boardRoute`, `packages/host/src/handlers/board.ts:51-62`), so the routes 404 even if something registered them on Personal. The renderer checks `isHostedBuild()` for the route (`apps/web/src/App.tsx:446`) and the rail entry (`apps/web/components/agent-rail.tsx:267`).

## Data (`packages/db/src/board-schema.ts`)

Five tables, created by `ensureBoardTables` (`board-schema.ts:43`) from `ensureSchema` (`packages/db/src/ensure-schema.ts:253`) with `CREATE TABLE IF NOT EXISTS`, the way `desk_files` is healed. There is no drizzle journal entry: one would collide with `main`'s next migration number when `main` is merged into the tester branch.

- `board_columns`: five built-in kinds (`todo`, `doing`, `review`, `blocked`, `done`) seeded on first read, plus custom ones. A built-in column's `name` is null and the renderer shows its own word for the kind. One live column per position, one column per built-in kind.
- `cards`: `position` is a fractional key (below), `description` is sealed, `version` is the compare-and-set counter, `assignee_kind`/`assignee_user_id` are a CHECKed pair (`person` only in K0).
- `card_comments`: `body` sealed.
- `card_events`: the event log, `id INTEGER PRIMARY KEY` (no AUTOINCREMENT, which would create `sqlite_sequence` and break the purge census), payload with ids only, never text.
- `board_audit`: column create, rename, archive, and card archive and restore. `card.restore` joined the action CHECK in the review fixes; a data dir created before that keeps the old CHECK, because the healer only creates missing tables (spec section 17a, L7). Only throwaway rehearsal desks have one.

Every table carries `tenant_id` and `workspace_id`, with `workspace_id REFERENCES workspaces(id) ON DELETE cascade`. A trigger pair per table (`tenantGuards`, `board-schema.ts:34`) refuses an insert or an update whose `tenant_id` is not the desk's company's tenant. That is what lets `migrate-0015.test.ts:219` list them as tenant carriers. The tables are in `CASCADED_TABLES` (`packages/db/src/tenant-purge.ts:61`, board rows from `:83`), so erasing a partner removes its board.

The other tables of spec section 6.1 (`agent_tasks`, `card_files`, `card_mentions`, `notifications`) wait for K2 to K4. Nothing in K0 reads or writes them, and none has a foreign key K0 needs.

## Writes (`packages/host/src/board/service.ts`)

`commit` (`service.ts:46-53`) runs the work in one SQLite transaction, collects the event ids the work wrote, and publishes them on the bus only after the transaction returns. A refused change writes no event and publishes nothing (proved in `board-companies.test.ts`, "writes no event").

- **Edit**: `updateCard` (`service.ts:217`) sends `UPDATE ... WHERE ... version = ? AND archived_at IS NULL` (`store.ts:240-270`). No row means the card changed or is gone: 409 `card_conflict` with the current card in the body, or 404 `card_not_found`. A no-op edit returns the card unchanged.
- **Move**: the body names a column and `beforeId` (the card it lands above, or null for the end). `placeCard` (`service.ts:108`) computes the key with `keyBetween` (`fractional.ts:79`), so a move usually rewrites one row. Base-62 keys, `0-9A-Za-z`, in code-point order; an append steps by one digit, so 500 appends stay under 15 characters (`fractional.test.ts`).
- **Rebalance** (security review M1): moves into one gap again and again grow a key by about a character every six moves. A key longer than `MAX_POSITION_KEY` (48, `types.ts:22`), or a gap that cannot be split, is never written: `placeCard` rewrites the column's keys with `evenKeys` (`fractional.ts:53`; short, one width, evenly spaced) in the same transaction, without bumping the other cards' versions, and `noteRebalance` (`service.ts:131`) writes one `column.changed` with `rebalanced: true` from the system actor. The only remaining refusal is 409 `position_exhausted`, past `MAX_EVEN_KEYS` keys in one column, which the card cap rules out.
- **Caps** (security review M2, `BOARD_VOLUME`, `types.ts:15`): 5,000 live cards per desk (409 `card_limit`, `requireRoomForCard`, `service.ts:149`), 500 comments per card (409 `comment_limit`), 50 live columns per desk, the five built-in ones included (409 `column_limit`). Each is checked inside the write's transaction. `configureBoardVolume` is the test seam.
- **Assign**: a person must be a member of the same company (`requireMember`, `service.ts:61`).
- **Columns**: owner or admin only (`requireAdmin`, `service.ts:55`, 403 `admin_only`). Built-in columns cannot be archived (409 `builtin_column`); a column with cards cannot be archived (409 `column_not_empty`).
- **Archive** (security review M4): the card's creator, its assignee, or an owner or admin (`mayArchive`, `service.ts:309`); anyone else gets 403 `not_allowed`. The card is looked up first, so another company still gets 404. With the version, audited.
- **Restore**: owner or admin only (`restoreCard`, `service.ts:338`; 403 `admin_only`, checked before the lookup so it reveals nothing). The archived card's version is the compare-and-set (409 `card_conflict`); it returns to the end of its column, or to To do when that column is archived, with a `card.restored` event and a `card.restore` audit row. The renderer has no restore button in K0; the route is for an admin tool and the leaver flow.

Every query in `store.ts` filters on `tenant_id` and `workspace_id` from `getTenant(request)`, never from the body.

Sealing: `description` and comment `body` go through `sealBoardText` (`seal.ts:5`, the same `sealPayload` envelope and vault key as threads). `openBoardText` returns an empty string for anything that will not open, never the stored value.

## The stream (`packages/host/src/board/stream.ts`)

`GET /api/v1/board/events`. The bus (`InProcessBoardBus`, `bus.ts:15`) carries only "event N exists on this desk". The stream then reads `card_events` after the last id it sent (`eventsAfter`, `store.ts:373`), so live delivery, catch-up after a burst and resume share one read path and cannot skip or repeat an id.

- **Resume**: `Last-Event-ID` (forwarded by the adapter in server mode only, `http-adapter.ts:717`, so the header set off server mode is unchanged and `http-adapter.test.ts` keeps its Personal-parity assertion). More than 1000 events behind, a header that is not an id (the handler turns it into NaN, `handlers/board.ts:133-134`), or an id past the desk's newest event sends `event: reset` (`stream.ts:184`) and carries on from the newest; the page reloads the board.
- **Heartbeat**: `: hb` every 15 s (`stream.ts:240`).
- **Access**: `stillAllowed` (`stream.ts:111`) re-reads the session (revoked or expired ends it) and the person's membership through `resolvePortalTenant`. It runs once per read batch of up to 200 events, again before an event when more than a second (`ACCESS_RECHECK_MS`, `stream.ts:65`) has passed since the last check, and at every heartbeat (security review L4). A failure sends `event: closed` with `reason: access` and ends the stream.
- **Caps**: 5 open streams per person and 500 per process; the oldest is closed with `reason: replaced` (`register`, `stream.ts:95`). Each stream ends after 15 minutes with `reason: lifetime`, checked at the top of every loop turn (`stream.ts:191`, security review L1) so a busy desk still closes on time, and the browser reconnects from its last id.
- **Archived cards**: events about an archived card are dropped, except `card.archived` and `column.changed` (`stream.ts:60`), which are how viewers learn of the change.
- **Headers**: the adapter's stream writer sets `text/event-stream`, `X-Accel-Buffering: no` and `Connection: keep-alive`, then applies the result's own headers (`http-adapter.ts:361`); the board sets `Cache-Control: no-store, no-transform` (`handlers/board.ts:138`). `HostStreamResult.headers` is the one-field change in `packages/host/src/types.ts:80`.
- **Backpressure** (security review L8): while the socket's buffer is full the adapter drops a heartbeat and holds an event until `drain` or until the client hangs up (`http-adapter.ts:369`), so a stalled reader never makes the host queue frames without bound.

### Buffering between the host and the browser

- The host has no compression middleware, and Vite runs in middleware mode inside the same Express process (`apps/web/server.ts:117`), so there is no dev proxy to buffer.
- `webapp-deploy/Caddyfile:108` and `:262` have `encode zstd gzip` with no `match`, and Caddy's default list includes `text/*`. **Driven through that Caddyfile on 2026-10-13 (local rehearsal, `caddy:2.11-alpine`): the stream answered with no `Content-Encoding`** while Chromium offered `gzip, deflate, br, zstd`, and a change reached the other browser in 0.3 to 0.8 s (evidence `stream-response-headers.json` and `results.json`, below). The stream's `Cache-Control: no-store, no-transform` (`handlers/board.ts`) is the likely reason Caddy leaves it alone; that was not isolated by a run without it, so keep `no-transform` on the stream. `flush_interval -1` is set on the proxy (`:237`, `:286`). The earlier reading (a docs lookup of `encode.go` at v2.11.0 that found no SSE exception) did not account for `no-transform`.

## Routes (`boardRoutes`, `packages/host/src/handlers/board.ts:110`)

| Method and path | Who | Answer |
|---|---|---|
| `GET /api/v1/board` | member | `{ board: { workspaceId, cursor, columns, cards, people, me } }` |
| `GET /api/v1/board/events` | member | the stream |
| `POST /api/v1/board/cards` | member | 201 `{ card }` |
| `GET /api/v1/board/cards/:cardId` | member | `{ card, comments }` |
| `PATCH /api/v1/board/cards/:cardId` | member | `{ card }`, or 409 `{ error, card }` |
| `POST /api/v1/board/cards/:cardId/archive` | creator, assignee, owner, admin | `{ ok: true }`, or 403 `not_allowed` |
| `POST /api/v1/board/cards/:cardId/restore` | owner, admin | `{ card }` |
| `POST /api/v1/board/cards/:cardId/comments` | member | 201 `{ comment }` |
| `POST /api/v1/board/columns` | owner, admin | 201 `{ column }` |
| `PATCH /api/v1/board/columns/:columnId` | owner, admin | `{ column }` |

`router.ts:345` compiles the table with one line. CSRF and the Origin allowlist are the adapter's, applied to every write before dispatch; `board-adapter.test.ts` proves a write without the token gets 403 `csrf_missing` and one from an untrusted Origin 403 `origin_forbidden`. The six by-id routes have rows in `tenancy-harness.test.ts`, but that harness runs with server mode off, so there they 404 at the server-mode check; the real two-company proof is `board-companies.test.ts` and, for restore, `board-review.test.ts`.

## Renderer

- `apps/web/components/board-page.tsx`: the page. The stream is a nudge: each event reloads the snapshot, coalesced over 150 ms (`RELOAD_COALESCE_MS`, `:30`), and an event about the open card reloads that card. The stream opens after the first snapshot with that snapshot's cursor (`:81`).
- `apps/web/components/board-card-dialog.tsx`: the card. Archive is offered only to the people the host lets archive (`mayArchive`, `apps/web/lib/board-view.ts`); the host still decides. A save sends only the changed fields with the version read (`changeOf`, `apps/web/lib/board-draft.ts`). A newer card (someone else's save or a 409) keeps the boxes the person edited and refreshes the rest (`rebaseDraft`), so a second save never writes back a field the person did not touch.
- `apps/web/lib/board-stream.ts`: `fetch`-based SSE through `apiFetch` with `Last-Event-ID`. Reconnects 1 s, 2 s, 4 s up to 30 s after a drop; at once after `lifetime`; never after `replaced` (two tabs would evict each other forever) or `access`.
- `apps/web/lib/board-client.ts`: the calls, with every answer checked before the page sees it.
- Copy: namespace `board` (`apps/web/locales/{en,id}/board.json`), parity and no-brand test `apps/web/lib/board-locale.test.ts`. The host's error text is English, so the page shows its own sentence per code (`boardErrorMessage`, `apps/web/lib/board-view.ts`).
- Rail: `BOARD_LINK` first in the account group when `showBoard` (`agent-rail.tsx`). Icon `board` in `mode-icons.tsx` and its scene in `mode-illustration.tsx`.

## Tests

- `packages/db/src/board-schema.test.ts`: tables, triggers, purge and cascade.
- `packages/host/src/board/fractional.test.ts`: key order and growth, and `evenKeys`.
- `packages/host/src/board/board-review.test.ts`: the security review's fixes on a real database with real sessions. M1: two cards alternated into one gap 2,000 times, and 2,000 cards inserted above one card, keep every key at 48 characters or fewer, in order, with a rebalance event and no throw. M2: each cap answers its 409. M4: a member who neither created nor holds the card gets 403, the creator, the assignee and an owner archive, another company gets 404; restore is owner-only, with the audit row, the event, a stale version's 409, and To do when the column is gone. L1, L2, L4: the stream closes on time mid-replay, resets on a bad or ahead id, and checks access twice for 250 events.
- `packages/host/src/board/board-backpressure.test.ts`: L8, against a fake response: a heartbeat dropped and an event held until `drain`, a hang-up ends the wait, a destroyed socket is never waited on.
- `packages/host/src/board/board-companies.test.ts`: two companies under one tenant id through the real router with real sessions; every refusal paired with the owner reading the same row; 409; sealing at rest; admin-only columns; the stream with two viewers, resume, reset, close on removal and on sign-out, caps, and listeners back to zero; Personal 404 for every route.
- `packages/host/src/board/board-adapter.test.ts`: real socket, CSRF and Origin, SSE headers, a frame flushed while the response is open, the slot freed on hang-up.
- `apps/web/lib/board-stream.test.ts`, `board-draft.test.ts`, `board-locale.test.ts`, `board-view.test.ts` (who sees Archive, the new refusal sentences), `agent-rail.test.tsx` (the rail unchanged without `showBoard`).

## Driven on the local rehearsal (2026-10-13)

Rizky's rule from 2026-10-13: each phase is proven on a local rehearsal of the hosted stack (server mode, real portal sign-in, two people of one company and one of a second). K0's drive, 19 of 19 checks:

- **Stack.** The compose stack of `webapp-deploy/pilot-local.mjs` (the real Caddyfile, the portal, Postgres, Mailpit, the app in server mode), built from a `git ls-files -co` snapshot of this tester folder. Run under its own compose project `nultron-pilot-tester` and image tags `pilot-tester`, because the published checkout keeps a stopped `nultron-pilot-local` project with its own volumes on this PC, and `pilot-local.mjs` hard-codes that project name: its `up` recreated four of those stopped containers and the portal refused the tester's database password (the published checkout's volume). They were stopped again and their volumes were not touched. The tester project's driver and override are in the evidence folder (`pilot-tester.mjs`, `tester-images.yml`).
- **People.** Company A: alice (owner, from the portal `seed`) and ann (member, from the portal `invite`, who redeemed the e-mailed invite code). Company B: bob (owner, a second `seed --org`). Every sign-in went through the portal with the six-digit code read from Mailpit; no shortcut. Reruns reuse the browser state of an earlier real sign-in while its session is live, because the portal allows 3 codes per address per 15 minutes (`apps/portal/src/otp/send.ts:8`).
- **Live, measured from the click to the other person's screen:** alice creates, ann sees it in 805 ms; alice renames, 513 ms; ann drags To do to Doing, alice sees it in 821 ms; ann creates, 295 ms. (An earlier run timed from the action's end: 201, 5, 203 and 200 ms.) The delay includes the page's 150 ms reload coalescing and a snapshot reload.
- **Company B sees nothing:** none of A's titles on bob's screen or in his `GET /api/v1/board`; bob's `GET`, `PATCH` (with his own CSRF token) and comment on A's card id all answer 404 `card_not_found`, the same body as a ghost id; alice's card is unchanged; bob's own card never shows on A's boards.
- **Stale edit:** alice and ann open the same card and press Save at the same moment; one gets `Saved.`, the other the conflict sentence with their own title still in the box.
- **Behind Caddy:** no `Content-Encoding` on the stream (above).
- **Indonesian and phone width:** bob signed in with `Accept-Language: id-ID` and his desk is in Indonesian ("Papan tugas", "Akan dikerjakan"); at 375 px the page has no horizontal scroll (the five columns scroll inside the board, `scrollWidth` 1692 in a 271 px box).
- **Evidence:** `.cursor/skills/verify-agentforge/evidence/board/2026-10-13-k0/` (gitignored): `results.json`, `actions.log`, `stream-response-headers.json`, `desktop-alice-board-en.png`, `desktop-conflict-en.png`, `desktop-bob-board-id.png`, `phone-375-ann-board-en.png`, `phone-375-bob-board-id.png`, and the driver `board-drive.mjs`.

## Not driven

Dark mode; a dropped stream resuming in the browser (the resume is proven by `board-companies.test.ts` and the browser's reconnect by `board-stream.test.ts`); the security-review fixes landed after this drive (archive and restore rules, caps, key rebalance, the stream changes), which the rehearsal image predates; any real server. The tester webdev on `:3200` is not in server mode, so the board 404s there by design.

## What K1 needs to know

- An open board tab reconnects every 15 minutes through the session gate, and each request slides the session. An open board keeps a session alive until the hard expiry. Decide whether that is wanted.
- `listPeople` reads display names from the user table. A person store (K1) must not be joined here.
- The stream's access check is two reads, once per read batch and at most once a second inside one. A desk with many viewers multiplies that; a shared membership cache would be the next step.
- `card_events` is never pruned in K0. The retention plan is spec section 17a.
