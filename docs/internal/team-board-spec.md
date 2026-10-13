# Team board spec (2026-10-12, full rewrite 2026-10-13)

Status: **accepted; K0 being built (2026-10-13).** On 2026-10-13 Rizky accepted every default in section 5, so K-D0 is lifted and the build runs K0 to K4 in the tester code. P1 and P2 stay unbuilt (K-D9, K-D10). It reaches `main` through a promotion pull request that Rizky approves ([`TESTER.md`](../../TESTER.md)).

How to read it: sections 1 to 3 say what the board is. Section 4 is where it runs and what that changes. Section 5 is every decision Rizky still owes, with the default this spec assumes. Sections 6 to 16 are the build spec. Section 17 is the phases with their proofs. Section 18 is what has to be checked on Tencent Cloud before building on it.

Sources for the 2026-10-13 rewrite: an architecture and security review of this draft and the deploy path (read-only, every `file:line` re-checked on `main` at `73db3c30`), and Tencent Cloud's own documentation, read the same day. What the documentation did not say is listed in section 18, not guessed.

## 1. What it is

A company shares one board of cards. A card has a title, a description, files, comments and @mentions. It is assigned to one of two kinds of worker: **a person**, or **that person's own agent**. Every person in the company has exactly one personal agent, tuned to how they work. When a card goes to an agent, the host runs that agent on the card. The result goes back onto the card, and the agent's owner reviews it before the card is done. Everyone who can see the card sees each change as it happens.

Behind it are two stores. **The company store** holds the board and what the team shares, and the admin maintains it. **The personal agent store** holds each person's workstyle, workflow, skills and memory, and only that person can read it. **The task service** sits between the two and is the only code that writes the board.

## 2. Rizky's words and decisions

On 2026-10-12, Rizky:

> "im also planning to add kanban board into the agent platform, the main goal is so that enterprise can assign job to either that human agents or that human itself, that will be fully synced, included description and files and can also tag someone"

> "there have to be something that connect them all in the backend and with this it should have now 2 databases, the company database that the admin maintain and the human agents database where it's specialised into their own workstyle and their own workflow and skills"

Asked whether "human agents" means each person's own agent or the desk's hired virtual agents, he answered: **"each person's own agent"**.

On 2026-10-13:

> "we'll be using this inside tencent cloud cvm, using auto scaling in the future, and kubernetes with caddy. is this already the right and secure way?"

Section 4 answers the first half and section 12 the second.

Earlier rules this spec has to keep:

| Rule | Source | What it means here |
|---|---|---|
| Private by person on Enterprise. Owners and admins may delete or keep a person's knowledge and may never read it. | `AGENTS.md`, "Private by person on Enterprise" (2026-10-06) | The personal agent store is private to its person. No route returns it to an admin. Section 12.3 says exactly what that protects against. |
| A document attached in Chat is private to the person who attached it. | same | A card's files are a separate scope (section 11). A private chat file reaches a card only when its owner copies it there. |
| Sharing goes through a bot. | same | What a person's agent produces on a card is shared. What the agent knows is not. |
| The host enforces, the renderer displays. | `AGENTS.md`, gateway gate | Every visibility and run rule in this spec lives in the host. |
| No new modes, harnesses, rail entries or packs on `main` (2026-10-01). | `AGENTS.md`, "Current focus" | The board is a new surface. It is built here and goes to `main` only by a promotion PR. **Rizky has not lifted the freeze for the build (K-D0).** |
| Enterprise-only work is gated to server mode, with a Personal-parity test. | `AGENTS.md`, BYOK exception | Personal shows no board in v1 (K-D7). |
| Per-person knowledge is design only, "dont make it too complicated" (2026-10-06). | `chat-first-plan.md`, "Hiring a bot" | The personal agent store is the first piece of per-person knowledge to be built. Building it lifts that hold for this one store, and needs Rizky's word (part of K-D0). |
| Shared code carries no brand. | `AGENTS.md`, sync lanes | Board copy reads `productName`; no `Nultron` or `HYP AI` typed in code or copy. Every string in `en` and `id`. |
| Auto Scaling, the database move and object storage are "not started" and need Rizky's word. | `AGENTS.md`, HYP AI hosting plan, Stage 3 | This spec designs for them and decides none of them (K-D9, K-D10). |

## 3. Words

| Word | Meaning |
|---|---|
| Board | One company desk's set of columns and cards. v1 has one board per company desk (K-D2). |
| Card | A unit of work: title, description, status, assignee, files, comments, mentions. |
| Assignee | Exactly one of: a person (`user:<id>`), or a person's agent (`agent:<userId>`). A card may have no assignee. |
| Personal agent | The one agent each person owns. It is a full chat agent like the tester's virtual agents (`chat-first-plan.md`, instruction 3), plus the person's profile. |
| Agent owner | The person whose agent it is. Only they configure it, read its store and approve its card work. |
| Participant | The card's creator, its assignee (or the assignee agent's owner), and anyone mentioned on it. |
| Card event | One row in the event log: created, edited, moved, assigned, commented, file added, agent started, progressed, asked, finished, failed. |
| Card run | One run of a personal agent on one card, started by the dispatcher after the owner accepts. |
| Replica | One running copy of the host process. Today there is exactly one. |

## 3a. What exists today (read 2026-10-12 on `tester/chat-first`, re-checked 2026-10-13 on `main` at `73db3c30`)

| Piece | Where | What it means for the board |
|---|---|---|
| Person and company on a hosted request | `resolvePortalTenant`, `packages/db/src/portal-owner.ts:279-329`; role from `organization_members.role` | The task service gets `tenantId`, `organizationId`, `workspaceId`, `userId` and `role` from the existing context. No new identity code. |
| Desk access | `portal-owner.ts:309-316` loads every desk of the company and accepts any of them. `workspace_members` is never read. Register row **SR-169**. | **Any member of a company can open any desk of that company.** The board inherits this. K-D11. |
| Threads per person | `threads.user_id`, `packages/db/src/schema.ts:436` | A personal agent's conversations are already per person. |
| Desk files, versioned | `desk_files` `schema.ts:953`, `desk_file_versions` `schema.ts:979` | Card files reuse them (section 11). |
| Private chat uploads | `privateFolderFor(userId)`, `packages/host/src/desk-files/private-uploads.ts:29` | The copy-to-card action copies out of it. |
| Knowledge | `knowledge_sources` and its siblings, `schema.ts:503-599`, keyed by `workspace_id` only | **There is no per-person knowledge today.** The personal store's Knowledge part is new work. |
| Run policy for an agent | `runPolicyFor`, `packages/host/src/virtual-agents.ts:185` | The dispatcher builds a card run through it. |
| Paid media cap per turn | `PAID_MEDIA_PER_TURN`, `packages/core/src/agents/virtual-agents.ts:107` | Applies to a card run unchanged. |
| Job event stream | `streamJob`, `packages/host/src/job-stream.ts:39` | One request, one stream. No broadcast to several clients, no event log, no notification table today. |
| Egress guard | `packages/core/src/runtime/egress-guard.ts` | Refuses `web_fetch` only, and only after a private read by a tool in the same run. It does not check `web_search` or worker questions, and does not see what enters through the system prompt. Register row **SR-166**. |
| Database engine | `packages/db/src/vault-key.ts:21-26` throws on a `postgres://` URL | The product database is SQLite and only SQLite today. |
| Envelope encryption | `packages/core/src/crypto/envelope.ts` (AES-256-GCM); wrap key from `AGENTFORGE_SECRETS_KEY`, at least 32 random bytes enforced in server mode (`vault-key.ts`) | Per-person data keys (section 6.3) reuse this code. |
| Kubernetes manifests | `webapp-deploy/k8s/base/app.yaml:8,17-20`: one replica, `Recreate`, "do not raise `replicas`… until the data layer moves" | Everything here has to work at one replica first. |
| Server mode | `isServerMode`, `packages/core/src/server-mode.ts:12-15` | Every board route checks it. |

## 4. Where it runs

### 4.1 The answer to "CVM, then Auto Scaling, then Kubernetes with Caddy"

That sentence names **two different roads**, not three steps on one road.

| | Road A: CVM Auto Scaling | Road B: Kubernetes (TKE) |
|---|---|---|
| What scales | Whole servers, cloned from a server image, behind a load balancer (CLB). | Pods (copies of the app) on a pool of servers; the pool itself can grow. |
| What it needs from the app | No state in the process or on its disk. | The same. |
| What the repo has for it | Nothing: no server-image pipeline. | `webapp-deploy/k8s/` (base, local rehearsal, a production overlay that has never been applied). |
| Cost to run | Servers + CLB + managed database. | The same, plus TKE's cluster management fee (amount not published on the page read; section 18). |
| Restarts and updates | Replace servers. | Rolling restarts, health probes, one place for secrets and network rules. |

**Recommendation: road B (TKE), and not before the data layer moves.** Both roads need the same precondition (section 4.3), and once that is paid for, TKE is the one the repo already started. Until then, "scale" means **Stage 2: resize the one CVM**, which covers 100 to 500 users and well past it. Decision K-D9.

TKE's own notes: Jakarta is supported (`ap-jakarta`, zones 1 and 2); new clusters are "standard" clusters (the old serverless type can no longer be created); the cluster autoscaler works per node pool and refuses to remove a node that holds local storage. Sources in section 18.

### 4.2 Where Caddy belongs

| Stage | Caddy's job | Note |
|---|---|---|
| Now: one CVM (compose) | Edge: TLS certificates, sign-in log redaction, the webhook 404, headers (`webapp-deploy/Caddyfile`). | Keep as is. |
| TKE at one replica | A sidecar beside the app behind a TCP pass-through CLB, doing its own certificates (`k8s/overlays/production/edge-service.yaml`). | Workable, never proven. ACME needs ports 80/443 to reach the pod. |
| TKE at more than one replica | **Not TLS.** Each pod would fetch its own certificate. TLS moves to the CLB (an HTTPS listener with a certificate from Tencent's SSL Certificate Service) or to the TKE ingress. Caddy stays only if it still earns its place as a header-and-log-redaction sidecar. | The app already sets its own security headers in server mode (`packages/host/src/security-headers.ts`). The webhook 404 and the sign-in log redaction must move into the app or the ingress first. |
| HYP AI behind Cloudflare | Unchanged on the CVM. | Cloudflare reads passwords, cookies and pasted keys in clear under Full mode, and the origin still answers directly (`C:\Users\rizky\hypey\deploy\README.md`, 2026-10-08). Register row SR-172. Nultron does not use Cloudflare. |

### 4.3 What blocks a second replica

| Coupling | Evidence | Must become | Needed for the board? |
|---|---|---|---|
| SQLite, one writer | `vault-key.ts:21-26`; `app.yaml:17-20` | A managed database (TencentDB for PostgreSQL), K-D10 | Only at more than one replica |
| Tenant files on local disk | `packages/host/src/tenant-storage.ts`; COS backend never run against a real bucket | COS (object storage; Jakarta confirmed) | Only at more than one replica |
| Portal-refresh single-flight | `packages/host/src/auth/portal-check.ts:225-226` (SR-66) | A row lock on `auth_sessions` | Only at more than one replica |
| Request rate limits | `packages/host/src/rate-limit.ts` (in memory) | Shared counters, or N times the ceiling with N pinned and written down | Only at more than one replica |
| Run cap | `packages/host/src/run-limits.ts:106-107,164` | A shared counter | Yes, card runs count against it |
| Job state and streams | `job-stream.ts:39-58`, one request, one queue | Jobs in a table with a worker claim; streams resume from a log | The board's own stream already resumes from a log (section 8) |
| Wrap key | `AGENTFORGE_SECRETS_KEY` in an env var, a k8s Secret generated from a local `secrets.env` | Tencent Secrets Manager or KMS (Jakarta not confirmed, section 18) | Same key on every replica is fine |

### 4.4 The design rule this gives the board

**Build the board so that one CVM today and many replicas later need no rewrite.** Concretely:

1. The event log is a table, written in the same transaction as each change (section 7). It is the source of truth and the resume point, on SQLite and on Postgres alike.
2. The event bus is an interface (section 8.4). The first implementation is in-process. The second, added only when the database moves, is Postgres `LISTEN/NOTIFY`. The browser side does not change.
3. No sticky sessions. A browser that reconnects to another replica resumes from `Last-Event-ID`.
4. The personal store is ordinary tables behind one module, with per-person encryption (section 6.3). It moves with the database.
5. Card runs claim work from the `agent_tasks` table, not from memory, so a restart or a second replica does not lose or double a run.
6. The SSE stream sends a heartbeat every 15 seconds, so no load balancer or Cloudflare idle timeout cuts it, whatever those timeouts turn out to be.

## 5. Decisions

**Accepted by Rizky on 2026-10-13: "accept all defaults, start K0 in the tester".** Every row below is decided as its default. K-D12 covers card runs only; it is not a ruling on SR-166 for the chat agents.

Ranked: the first five block the build or its safety.

| # | Question | Default this spec assumes | Why it matters |
|---|---|---|---|
| **K-D0** | Lift the 2026-10-01 freeze to build the board in the tester code, including the first per-person store? | Not lifted; design only. | Nothing is built without it. |
| **K-D11** | Are desks company-wide by design, or can a desk be limited to some people? (SR-169) | Company-wide: every member of the company sees the board. | The board's visibility rests on it. If desks can be limited, the membership check is fixed on `main` first. |
| **K-D12** | Do card runs get network tools (`web_search`, `web_fetch`, the research worker)? (SR-166) | **Yes, always, behind the outbound guard of section 9.3.** (Rizky, 2026-10-13: "web search is needed, its not negotiateable". This replaced the earlier default, "off".) | A card is written by any teammate, so a card can try to make the agent put its owner's private text into a search query. The guard stops copied text, figures, identifiers, PII, secrets and encoded blobs, and shows every query. It cannot stop a model restating a private fact in its own words; that residual needs Rizky's acceptance when the guard lands. |
| **K-D13** | What does "admins cannot read it" promise, in the app and in the terms? | It holds against the company's admin and owner, against a stolen database or backup, and against a bug in another query. It does **not** hold against the server's operator, because an agent has to run while its owner is offline, so the server must be able to open the owner's key. | The terms must not promise more than the design delivers (section 12.3). |
| **K-D1** | Personal agent store: tables behind one module (A), or a sealed SQLite file per person (B)? | **A, with a per-person data key.** (Changed from B on 2026-10-13.) | B gives the same protection (one wrap key opens every file), needs a schema migration per file, is copied live by the backup job (which makes a consistent copy of the main database only), and is a dead end at more than one replica. |
| K-D9 | Which scaling road: CVM Auto Scaling or Kubernetes (TKE)? | **TKE, after the data layer moves.** Until then, resize the CVM. | Section 4.1. The Stage 3 sentence in `AGENTS.md` would change from Auto Scaling to TKE. |
| K-D10 | Product database for the hosted app: stay on SQLite or move to TencentDB for PostgreSQL? (open decision 1 in `web-pivot-2026-09-18.md`) | **Stay on SQLite for K0 to K4**; move only when a second replica is needed. | The move is not small: Personal stays on SQLite, so the hosted app on Postgres means two SQL dialects across all of `packages/db`, every migration, and every lane. The board is built so it does not force the choice (section 4.4). |
| K-D2 | One board per company desk, or several (per team, per project)? | One. | |
| K-D3 | Must the owner accept before their agent runs on a card someone else assigned? | Yes. | |
| K-D4 | Whose key pays an agent's card run? | The owner's personal key, else the company key. | |
| K-D5 | Must a person approve agent work before `done`? | Yes, the agent's owner. | |
| K-D6 | When a person leaves: their open cards go to whom, and their agent's comments stay? | Cards go back to unassigned; comments and files stay (company data). The personal store follows the admin's keep/delete choice. | |
| K-D7 | Does Personal get a board (agents only, one human)? | Not in v1. | |
| K-D8 | Is the board on the free trial? | Yes, within limits. A card run that needs a computer needs a paid plan, as with routines. | |
| K-D14 | May an admin see the *titles* of a leaver's cards in the personal store, to decide keep or delete? | No. The admin sees only the count of items and their total size. | |

## 6. Data model

All tables live in the product database. Every row carries `tenant_id` and `workspace_id`; every query filters on both. Ids are UUIDv7 (sortable by time). Times are UTC milliseconds.

### 6.1 Company store (the admin maintains it)

| Table | Columns | Constraints and indexes |
|---|---|---|
| `board_columns` | `id`, `tenant_id`, `workspace_id`, `name`, `position` (int), `kind` (`todo` / `doing` / `review` / `blocked` / `done` / `custom`), `archived_at` | unique (`workspace_id`, `position`) among non-archived; exactly one column of each built-in kind per board |
| `cards` | `id`, `tenant_id`, `workspace_id`, `column_id`, `position` (fractional-index string), `title` (≤ 200 chars), `description` (markdown, sealed, ≤ 20 000 chars), `assignee_kind` (`person` / `agent` / null), `assignee_user_id`, `created_by`, `due_at`, `version` (int, starts at 1), `created_at`, `updated_at`, `archived_at` | index (`workspace_id`, `column_id`, `position`); check: `assignee_kind` null iff `assignee_user_id` null |
| `card_comments` | `id`, `tenant_id`, `workspace_id`, `card_id`, `author_kind` (`person` / `agent`), `author_user_id`, `body` (markdown, sealed, ≤ 20 000 chars), `agent_task_id` (when an agent wrote it), `created_at`, `edited_at`, `deleted_at` | index (`card_id`, `created_at`) |
| `card_mentions` | `id`, `tenant_id`, `workspace_id`, `card_id`, `comment_id` (null for the description), `target_kind` (`person` / `agent`), `target_user_id` | unique (`comment_id`, `target_kind`, `target_user_id`) |
| `card_files` | `id`, `tenant_id`, `workspace_id`, `card_id`, `desk_file_id`, `desk_file_version_id`, `attached_by_kind`, `attached_by_user_id`, `source` (`upload` / `copied_from_private` / `agent_output`), `created_at`, `removed_at` | |
| `card_events` | `id` (monotonic integer per database), `tenant_id`, `workspace_id`, `card_id`, `actor_kind` (`person` / `agent` / `system`), `actor_user_id`, `type`, `payload` (JSON, ids and small fields only, no bodies), `created_at` | append-only; index (`workspace_id`, `id`) |
| `notifications` | `id`, `tenant_id`, `workspace_id`, `recipient_user_id`, `event_id`, `reason` (`assigned` / `mentioned` / `needs_accept` / `asked` / `review` / `done`), `read_at` | index (`recipient_user_id`, `read_at`) |
| `agent_tasks` | `id`, `tenant_id`, `workspace_id`, `card_id`, `owner_user_id`, `state` (section 9.1), `requested_by`, `attempt`, `run_id`, `claimed_by` (replica id), `claimed_until`, `cost_micros`, `error_code`, `created_at`, `updated_at` | at most one non-final task per card; index (`state`, `claimed_until`) |
| `board_audit` | `id`, `tenant_id`, `workspace_id`, `actor_user_id`, `action` (`column.create` / `column.rename` / `column.archive` / `card.archive` / `member.remove_from_board` / `leaver.decide`), `target`, `created_at` | append-only; admins read it |

`description` and `body` are sealed with the existing envelope (`envelope.ts`) like message bodies, so a stolen database shows no card text.

### 6.2 Personal agent store (one per person, decision K-D1 = A)

| Table | Columns | Who writes |
|---|---|---|
| `person_agent_profile` | `tenant_id`, `owner_user_id` (primary key with tenant), `sealed` (the profile: tone, language, format, working hours), `auto_accept_own` (bool), `updated_at` | The person, in their agent's settings or by telling the agent in chat. |
| `person_agent_workflows` | `id`, `tenant_id`, `owner_user_id`, `name`, `sealed` (ordered steps; each names a registry tool or worker), `position` | The person. |
| `person_agent_skills` | `tenant_id`, `owner_user_id`, `tool_id`, `sealed_instructions` | The person, within the host's limits. |
| `person_agent_memory` | `id`, `tenant_id`, `owner_user_id`, `sealed`, `source` (`chat` / `card`), `created_at` | The agent, through the existing memory path; the person can delete. |
| `person_knowledge_*` | the per-person mirror of `knowledge_sources` and its chunks, with `owner_user_id` | The person. |
| `person_store_access` | `id`, `tenant_id`, `owner_user_id`, `accessor` (`owner_request` / `card_run:<taskId>` / `leaver_delete`), `created_at` | The host, on every open. The owner can read their own log. |

Every column named `sealed*` is encrypted with **that person's data key** (section 6.3), not the desk key.

The host builds every agent run from this store the way it builds a hired bot from its spec (`chat-first-plan.md`, "Hiring a bot"): a person cannot add a tool that is not in the registry, raise a budget above the plan's ceiling, turn off write approval, or turn off redaction.

### 6.3 The per-person data key

- Each person gets a random 32-byte data key (DEK) the first time their store is written.
- The DEK is stored wrapped in `person_keys` (`tenant_id`, `owner_user_id`, `wrapped_dek`, `wrap_kind`, `created_at`).
- `wrap_kind = "hkdf-v1"`: wrapped under `HKDF(wrapKey, "person-dek-v1:" + tenantId + ":" + userId)`, with the existing AES-256-GCM envelope. This works today on SQLite with no new service.
- `wrap_kind = "kms-v1"`: wrapped by a Tencent KMS key, if KMS is confirmed in Jakarta (section 18). Moving a person from `hkdf-v1` to `kms-v1` is a re-wrap of one row, not a re-encryption of their data.
- **Leaver delete** destroys the `person_keys` row first, then the rows. Once the key row is gone, any copy of the rows left in a backup is unreadable. This is the one strong property the design gives.
- Only one module, `packages/host/src/person-store/`, may read `person_*` tables or unwrap a DEK. A test fails if any other file names those tables (the same kind of guard as `first-desk-modes.test.ts`).
- When the database moves to Postgres (K-D10): the `person_*` tables get row-level security keyed on `current_setting('app.user_id')`, read through a database role without `BYPASSRLS`. That turns the module rule into a database rule. Whether TencentDB supports it is in section 18.

## 7. The task service

One host module, `packages/host/src/board/`, is the only writer of the company tables.

```
renderer ──HTTP──▶ board routes ──▶ task service ──┬─▶ company store (one transaction:
                                                   │      change + card_events row)
                                                   ├─▶ event bus ──▶ SSE to each viewer
                                                   ├─▶ notifications
                                                   └─▶ agent_tasks ──▶ dispatcher ──▶ card run
                                                                                     │
                     personal store (person-store module) ◀── read by the owner's run ┘
                     card comment + files ◀── result posted back by the task service ──┘
```

Rules:

1. **Every change writes its event in the same transaction.** A change without an event row cannot exist, so a client that missed a message can always catch up from the log.
2. **Edits carry the card's `version`** and are written as `UPDATE … WHERE id = ? AND version = ?`. Zero rows updated answers `409 card_conflict` with the current card. No last-write-wins on the description.
3. **Moves use fractional positions**, so a move rewrites one row, not the column.
4. **Agents do not create or assign cards in v1.** An agent may comment, attach files, and move its own card to `review` or `blocked`. This stops one agent from handing work to another in a loop and spending tokens nobody approved.
5. **Only the task service publishes to the bus**, and only after the transaction commits.

### 7.1 Event types

| `type` | `payload` (ids and small fields only) |
|---|---|
| `card.created` | `columnId`, `position` |
| `card.edited` | `version`, `fields` (names only) |
| `card.moved` | `fromColumnId`, `toColumnId`, `position` |
| `card.assigned` | `assigneeKind`, `assigneeUserId` |
| `card.archived` | — |
| `comment.added` / `comment.edited` / `comment.deleted` | `commentId` |
| `file.attached` / `file.removed` | `cardFileId` |
| `agent.waiting_accept` / `agent.accepted` / `agent.declined` | `agentTaskId` |
| `agent.progress` | `agentTaskId`, `step` (a short label, never model text) |
| `agent.asked` | `agentTaskId`, `commentId` |
| `agent.finished` / `agent.failed` / `agent.cancelled` | `agentTaskId`, `errorCode` |
| `agent.approved` / `agent.sent_back` | `agentTaskId` |
| `column.changed` | `columnId` |

The client fetches the content an event points at through the normal routes, which check access again.

## 8. Live sync

### 8.1 The stream

- `GET /api/v1/board/events`, `text/event-stream`, one stream per open board tab.
- Each message: `id: <card_events.id>`, `event: <type>`, `data: {"cardId": …, …payload}`.
- **Heartbeat**: a comment line (`: hb`) every 15 seconds.
- **Resume**: the browser sends `Last-Event-ID`; the host replays every event after it, up to 1 000. Past that it sends `event: reset` and the browser reloads the board.
- Headers: `Cache-Control: no-store`, `X-Accel-Buffering: no`. Caddy and any proxy must not buffer the response.

### 8.2 Who receives what

- Opening the stream needs a signed-in session in server mode and a desk the person may open (K-D11). No CSRF token: it is a GET with no side effect.
- **Every event is re-checked before it is sent**, against the database, not a cached membership: the person is still a member of the company, the desk is theirs, the card is not archived. Replay uses the same filter.
- A person removed from the company or the board has their open streams closed within one event.
- Caps: at most 5 open streams per person and 500 per replica. Over the cap the oldest stream is closed.

### 8.3 Personal app

The packaged Personal app has no HTTP port. If Personal ever gets a board (K-D7), the same events go over the IPC bridge (`window.agentforge`).

### 8.4 The bus interface

```ts
interface BoardBus {
  publish(tenantId: string, workspaceId: string, eventId: number): void;
  subscribe(tenantId: string, workspaceId: string, onEvent: (eventId: number) => void): () => void;
}
```

- `InProcessBoardBus` now: one process, a map of listeners.
- `PostgresBoardBus` when the database moves: `NOTIFY board_events, '<tenantId>:<workspaceId>:<eventId>'` after commit, and `LISTEN` on each replica. Each replica then reads the event row and re-checks access per stream (8.2).
- The bus carries ids only, never content, on both implementations.
- **The resume cursor must stay gap-free on Postgres.** On SQLite one writer commits ids in order. On Postgres a sequence hands out ids at insert, not at commit, so id 102 can become visible before 101, and a stream that has moved past 102 would never see 101. So on Postgres every board write takes `pg_advisory_xact_lock` on its workspace before it inserts the event row. That makes board writes on one desk commit in id order. It is cheap at a board's write rate, and it costs nothing on SQLite, where the lock is not taken.

## 9. Agent runs on a card

### 9.1 States of an `agent_tasks` row

```
waiting_accept ──accept──▶ queued ──claim──▶ running ──▶ review ──approve──▶ done
      │                      │                 │  │          │
   decline                cancel               │  └─asks──▶ needs_input ──owner replies──▶ queued
      ▼                      ▼                 │                                         
  declined               cancelled          fails ──▶ failed (retry by the owner ──▶ queued)
                                                          review ──send back──▶ queued (attempt + 1)
```

- The owner's own assignment to their own agent skips `waiting_accept` when `auto_accept_own` is on.
- At most 3 attempts per task without a new acceptance.
- `cancelled` is reachable from `waiting_accept`, `queued`, `running` and `needs_input`, by the owner or by the person who assigned it.

### 9.2 The dispatcher

1. A replica claims a `queued` task with a single conditional update (`state = 'running'`, `claimed_by`, `claimed_until = now + 10 min`), so two replicas never run the same task.
2. A running task extends `claimed_until` every minute. A task whose claim expired is returned to `queued` with `error_code = "interrupted"`, so a restart does not lose it.
3. The run goes through the host's existing run path and `runPolicyFor`, with: the card's title and description, the card's file list, the last 20 comments, the owner's matching workflow, and the owner's personal store (opened through `person-store`, logged in `person_store_access`).
4. The run counts against the run cap, the plan's run budget and `PAID_MEDIA_PER_TURN`.
5. Progress is reported as `agent.progress` events with short host-written labels.
6. The result is posted as an agent comment. Files it made are attached with `source = "agent_output"`. The card moves to `review`.

### 9.3 Tool policy for a card run

- **Taint from step zero.** A card run has read private material before it starts (the owner's store), so the egress guard starts tainted.
- **Web search stays on** (K-D12), behind the outbound guard below. `agent_tasks.network_allowed` is dropped.

### 9.3a Safe web search (the outbound guard)

Built on `main` as a shared fix (it also protects Chat and every agent), then merged into the tester before K2. Lanes: all four.

1. **One check where text leaves the host.** The check runs inside the functions that send: each search backend and `fetchPublicHttps`, not only in `invokeToolGuarded`, so the research worker and any later worker are covered too. It reads the run's private material from the run context.
2. **Taint at the start.** A run is tainted from its first step when private text enters its prompt: Knowledge excerpts, soul, memories, the earlier-chats hint, attachments, or (card runs) the owner's store.
3. **Always, on every backend:** PII masking of the query (Tavily and Brave send it raw today), and refusal of credential-shaped text in any outbound argument (the existing `redactSecrets` patterns).
4. **When tainted, refuse a query or URL that carries private material:** a span of about five or more words, or any number, amount or identifier, that appears in the run's private material and not in the person's own messages.
5. **Shape limits:** a length cap on queries, and refusal of base64- or hex-looking blobs.
6. **On refusal** the model is told to search in general terms and try again, at most twice. Words are never silently stripped.
7. **Every query is visible**: in the run's tool disclosure, and on a card run in the card's activity for the owner's review.
8. **Calibration:** a set of ordinary research queries must all pass, so the guard does not break research.
9. **Residual, said plainly:** a model can restate a private fact in its own words. No filter stops that while one model reads private material and writes queries. Rizky accepts or rejects it when the guard lands.
- **No `run_code`** in card runs until the sandbox is proven inside the hosted image (`AGENTFORGE_CODE_RUNS`).
- **No computer** (VPS or own machine) in v1 card runs.
- **The prompt says the output is shared** with everyone who can see the card, and the owner's review step is the last check.

### 9.4 Whose key, and what it costs

K-D4: the owner's personal key if they have one (BYOK), else the company key. The cost is written to `agent_tasks.cost_micros` and shows on the card for the owner and admins.

## 10. Mentions and notifications

- `@person` in a description or comment notifies them (`reason = "mentioned"`) and makes them a participant.
- `@person's agent` asks that agent to reply on the card. It creates an `agent_tasks` row in `waiting_accept` for that agent's owner, exactly like an assignment.
- Mention search lists people in the company and each person's agent, by display name. It never reads a personal store.
- Notifications are rows; the bell reads `GET /api/v1/notifications`. The board stream also carries the person's own new notifications. No e-mail in v1.

## 11. Files on a card

- A card file is visible to everyone who can see the card. It is stored as a desk file version in the company scope (`desk_files`, `desk_file_versions`), so it is versioned and survives a re-upload.
- A file attached in Chat stays private to its owner. To put it on a card, the owner copies it there deliberately (`source = "copied_from_private"`). The copy belongs to the company; the original stays private.
- A file the agent makes during a card run is attached to the card and is company data from then on.
- Limits: the existing upload limits (25 MB, magic bytes must match the extension). Extraction uses the existing local extractor; no hosted OCR.
- When storage moves to COS: card files go to a private bucket and are served through the host, never through a public URL.

## 12. Security

### 12.1 What has to close before the board holds a real company's work

The severity here is for the board holding a real company's work. The security register rates the same rows lower, because it rates today's code, which has no board. Both are right for what they rate.

| # | Severity for the board | Gap | Where it stands | Closes when |
|---|---|---|---|---|
| 1 | Critical | Any member opens any desk of their company | SR-169, open | K-D11 decided; if desks can be limited, the membership check lands on `main` with a test |
| 2 | Critical | A card can make an agent that holds private knowledge send that knowledge out through a search or a worker question | SR-166, open | The safe web search guard (9.3a) is on `main` and merged here, and Rizky has ruled on its residual |
| 3 | Critical | "Admins cannot read" could be read as a promise against the operator | Design | K-D13 decided and the terms say exactly what section 12.3 says |
| 4 | High | The board adds the first fan-out stream: one bug sends a card to the wrong company | Design | Section 8.2 built, with a two-company test under one tenant id (the shape that bit SR-163) |
| 5 | High | Production k8s secrets come from a plaintext file on a laptop | SR-170, open | Secrets come from Tencent Secrets Manager or KMS before TKE |
| 6 | High | Network policy is ingress-only and has never been enforced | SR-97, open | An enforcing CNI is proven on TKE and an egress allowlist exists |
| 7 | High | Backups: the job is suspended, the archive is encrypted without authentication, nothing goes off the box | SR-171, open | TencentDB automated backups when the database moves; until then a daily CVM snapshot and an authenticated archive |
| 8 | Medium | No audit trail for admin actions | Design | `board_audit` and `person_store_access` built (section 6) |
| 9 | Medium | Replica count of 1 is a manifest value, not a guard | `app.yaml:8,17` | The host refuses to start a second replica while a single-process store is configured |

### 12.2 Controls the board must have from K0

- Every board route: server mode, signed-in session, tenant and desk check, CSRF on every write (`http-adapter.ts`, `local-request.ts`), and the request rate limit.
- Input limits: title 200 chars, description and comment 20 000, 50 mentions per comment, 20 files per card.
- Markdown is rendered with the renderer's existing sanitiser; no raw HTML.
- Every agent-written comment shows "written by <name>'s agent". It is never shown as the person.
- Two-company tests for every route and for the stream.
- Personal-parity test: on Personal every board route answers `404`, and nothing on the rail changes.

### 12.3 What "admins cannot read" means

| Who | Can they read a person's store? | Why |
|---|---|---|
| The company's admin or owner, in the app | **No.** No route returns it; the module refuses; there is no "view as" | Section 6.2 and 6.3 |
| A colleague, through a card | Only what the owner's agent writes onto the card, after the owner accepted and before the owner approves | Section 9 |
| Someone holding a database dump or a backup | **No**, without the wrap key; and never after a leaver delete, because the key row is gone | Section 6.3 |
| A bug in another query | **No**, because other code cannot unwrap the person's key (and with Postgres, row-level security refuses the read) | Section 6.3 |
| The server's operator (who holds the wrap key, or the KMS permission) | **Yes, technically.** An agent has to run while its owner is offline, so the server must be able to open the key. | This is why K-D13 is a decision, and why access is logged in `person_store_access` |

## 13. Routes

All are server-mode only in v1 and answer `404` on Personal. Writes need the CSRF token. Errors are `{ error: <code>, message }` in the run's language.

| Route | Body / query | Answers | Errors |
|---|---|---|---|
| `GET /api/v1/board` | — | columns, cards (no bodies), assignee names | `404 board_not_found` |
| `GET /api/v1/board/cards/:id` | — | the card with description, comments, files, current agent task | `404 card_not_found` |
| `POST /api/v1/board/cards` | `title`, `description?`, `columnId`, `assignee?` | the card | `400 invalid_card` |
| `PATCH /api/v1/board/cards/:id` | `version`, any of `title`, `description`, `columnId`+`position`, `assignee`, `dueAt` | the card | `409 card_conflict` with the current card |
| `POST /api/v1/board/cards/:id/archive` | `version` | — | `409 card_conflict` |
| `POST /api/v1/board/cards/:id/comments` | `body` | the comment | `400 invalid_comment` |
| `POST /api/v1/board/cards/:id/files` | multipart upload, or `{ privateFileId }` to copy from the person's own files | the card file | `413 too_large`, `400 format_mismatch`, `404 private_file_not_found` |
| `POST /api/v1/board/agent-tasks/:id/accept` | — | the task | `403 not_owner`, `409 bad_state` |
| `POST /api/v1/board/agent-tasks/:id/decline` · `/cancel` · `/approve` · `/send-back` · `/retry` | `comment?` on send-back | the task | `403 not_owner`, `409 bad_state` |
| `GET /api/v1/board/events` | `Last-Event-ID` header | the stream (section 8) | `401`, `404 board_not_found` |
| `POST /api/v1/board/columns` · `PATCH /api/v1/board/columns/:id` | `name`, `position` | the column | `403 admin_only` |
| `GET /api/v1/me/agent` · `PUT /api/v1/me/agent` | the person's own profile, workflows, skills | the profile | owner only; anyone else `404` |
| `GET /api/v1/me/agent/access-log` | — | `person_store_access` rows for the caller | owner only |
| `GET /api/v1/notifications` · `POST /api/v1/notifications/read` | `ids` | — | — |
| `POST /api/v1/admin/leavers/:userId` | `decision`: `keep` / `delete` | counts only (K-D14) | `403 admin_only` |

New routes go through `packages/host/src/router.ts`, with handlers in `packages/host/src/handlers/board.ts`, and each gets its row in the tenancy route table.

## 14. In the chat-first shell

The north star is chat-first, so the board is not only a page:

- The person's own agent is a conversation in the rail, like the virtual agents. Its side panel gets a **Cards** tab: what it is working on, what waits for acceptance, what is in review.
- A card can be opened from a chat as an embed, and "make this a card" is a chat action.
- The full board is one account page beside Knowledge Base and Settings.
- New catalog namespace `board` in `apps/web/locales/{en,id}/`, with a parity test. No brand name in any string.

## 15. Operations

- **Backups**: on SQLite, the database file is in the CVM's daily snapshot and the encrypted archive (SR-171). On Postgres, TencentDB's automated backups, retained for at least 7 days (its range is 7 to 1 830).
- **Restore drill** once before the first company uses the board: restore into a throwaway desk, open a card, open one person's store as that person.
- **Metrics** (logged, no content): open streams, events per minute, agent tasks by state, card-run cost per day.
- **Logs** never carry card text, comments or anything from a personal store. They carry ids.

## 16. Risks

1. **Private knowledge leaking onto a shared card.** Covered by owner acceptance, taint from step zero, the outbound guard (9.3a), and review. A determined owner can still paste their own private material onto a card; that is their choice.
2. **Prompt injection through a card.** A card description is untrusted input (section 9.3).
3. **Event fan-out leaking cards** to people outside the desk. Covered by the per-event check (8.2) and the two-company tests.
4. **Cost runaway.** Agents cannot create or assign cards; each card run has the plan's budget; at most 3 attempts per acceptance.
5. **Two SQL dialects** if the hosted app moves to Postgres while Personal stays on SQLite (K-D10). The board keeps its SQL inside `packages/host/src/board/` and `person-store/` to limit the blast radius.
6. **Unconfirmed Tencent facts** (section 18). Nothing in K0 to K4 depends on them.

## 17. Phases

Everything up to K4 runs on one CVM and SQLite. P1 and P2 are the infrastructure track, and they start only on Rizky's word (K-D9, K-D10).

**How each phase is proven (Rizky, 2026-10-13): "local rehearsal for each phase, real server at the end".** Every phase K0 to K4 is driven on a local rehearsal of the hosted stack on this PC (server mode, real portal sign-in, two people of one company plus a person of a second company), never through a login shortcut. The real server (Enterprise or HYP AI) is driven once, after the promotion PR merges and a deploy Rizky approves.

| Phase | Builds | Proof |
|---|---|---|
| K0 | Company tables, task service, event log, `InProcessBoardBus`, SSE with heartbeat and resume, board page; people only, no agents. | Two browsers on two accounts see each other's moves live; a member of another company sees nothing (two-company test); a stale edit gets `409`; a dropped stream resumes without a gap; Personal answers `404`. |
| K1 | `person-store` module, `person_*` tables, per-person keys (`hkdf-v1`), the agent profile page, access log, leaver keep/delete. | An admin session gets `404` on every personal route; no other file names a `person_*` table (guard test); after a leaver delete the rows in a copied database cannot be opened. |
| K2 | Agent tasks: accept, claim, run, progress, result, review; tool policy of section 9.3. | A card run end to end on webdev with a real key; the agent read its owner's store and no one else's; a poisoned card that asks for a sentence of the owner's knowledge to be searched sends no such query; a killed process returns the task to `queued`. |
| K3 | Mentions and notifications. | A mention notifies the right person only, across two companies. |
| K4 | Card files and the copy-from-private action. | A chat attachment stays private until copied; the copy is visible on the card; the original is not. |
| K5 | Promotion PR to `main`, after Rizky approves. | `ci:local` green; Personal-parity test; security register rows updated. |
| P1 | (On Rizky's word, K-D10.) TencentDB for PostgreSQL; the dialect split in `packages/db`; `PostgresBoardBus`; row-level security on `person_*`; COS for files. | The board and Chat pass on Postgres; the SQLite path still passes for Personal; two concurrent writers on one desk and one open stream: the stream misses no event. |
| P2 | (On Rizky's word, K-D9.) TKE: shared run cap and rate limits, session row lock, TLS at the CLB, secrets from Secrets Manager or KMS, enforcing network policy, more than one replica. | Two replicas, a stream on each, a move on one shows on the other; a replica killed mid-run loses no task. |

## 18. Check on Tencent Cloud before building on it

Facts the documentation confirmed on 2026-10-13:

- TKE in Jakarta (`ap-jakarta`, zones 1 and 2): https://www.tencentcloud.com/document/product/457/36736
- New clusters are standard clusters; the old serverless type can no longer be created: https://www.tencentcloud.com/document/product/457/51208
- Cluster autoscaler works per node pool; a node with local storage is not removed: https://www.tencentcloud.com/document/product/457/58934
- A `LoadBalancer` Service creates a CLB; a CLB can send traffic straight to pods with VPC-CNI: https://www.tencentcloud.com/document/product/457/36832, https://www.tencentcloud.com/document/product/457/36837
- CLB HTTPS listeners take certificates from Tencent's SSL Certificate Service: https://www.tencentcloud.com/document/product/214/38450
- CLB layer-4 listeners pass the client IP through: https://www.tencentcloud.com/document/product/214/70455
- TencentDB for PostgreSQL in Jakarta (zones 1 to 3), versions 11 to 18, two-node HA, backups kept 7 to 1 830 days, point-in-time restore exists while log backup is on: https://www.tencentcloud.com/document/product/409/67590, https://www.tencentcloud.com/document/product/409/4989, https://www.tencentcloud.com/document/product/409/79623
- COS in Jakarta (`ap-jakarta`): https://www.tencentcloud.com/document/product/436/6224

Not confirmed. Each has the test that settles it:

| Unknown | Test |
|---|---|
| Row-level security and `LISTEN/NOTIFY` on TencentDB for PostgreSQL | On the smallest instance: create a policy, read as a role without `BYPASSRLS`; `LISTEN x` in one session, `NOTIFY x` in another. |
| KMS and Secrets Manager in Jakarta, and how a TKE pod gets a secret from them | Open both consoles with Jakarta selected; look for a TKE add-on or CSI driver. Until then the board uses `hkdf-v1` keys. |
| NetworkPolicy enforcement on TKE | The same cross-namespace probe as the local rehearsal (SR-97), on a TKE test cluster. |
| CLB HTTP idle timeout for a long stream | Not needed if the 15-second heartbeat is built; confirm by holding a stream open for 10 minutes through the CLB. |
| Redis pub/sub in Jakarta | Not needed: the design uses Postgres `LISTEN/NOTIFY`. |
| TKE cluster management fee | The price calculator for the chosen cluster size. |
| COS server-side encryption (SSE-COS / SSE-KMS) | The bucket settings page in the console. |
