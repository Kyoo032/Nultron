# Team board spec (2026-10-12)

Status: **draft. Nothing here is built.** Tester code only. It reaches `main` through a promotion pull request that Rizky approves ([`TESTER.md`](../../TESTER.md)).

## 1. What it is

A company shares one board of cards. A card has a title, a description, files, comments and @mentions. It is assigned to one of two kinds of worker: **a person**, or **that person's own agent**. Every person on the company has exactly one personal agent, tuned to how they work. When a card goes to an agent, the host runs that agent on the card. The result goes back onto the card, and the agent's owner reviews it before the card is done. Everyone who can see the card sees each change as it happens.

Behind it are two stores. **The company store** holds the board and what the team shares, and the admin maintains it. **The personal agent store** holds each person's workstyle, workflow, skills and memory, and only that person can read it. **The task service** sits between the two and is the only code that writes the board.

## 2. Rizky's words and decisions

On 2026-10-12, Rizky:

> "im also planning to add kanban board into the agent platform, the main goal is so that enterprise can assign job to either that human agents or that human itself, that will be fully synced, included description and files and can also tag someone"

> "there have to be something that connect them all in the backend and with this it should have now 2 databases, the company database that the admin maintain and the human agents database where it's specialised into their own workstyle and their own workflow and skills"

Asked whether "human agents" means each person's own agent or the desk's hired virtual agents, he answered: **"each person's own agent"**.

Earlier rules this spec has to keep:

| Rule | Source | What it means here |
|---|---|---|
| Private by person on Enterprise. Owners and admins may delete or keep a person's knowledge and may never read it. | the hyp-ai repo's `AGENTS.md`, "Team rules" (this repo's `AGENTS.md` until 2026-10-16) (2026-10-06) | The personal agent store is private to its person. No route returns it to an admin. |
| A document attached in Chat is private to the person who attached it. | same | A card's files are a separate scope (section 6). A private chat file reaches a card only when its owner copies it there. |
| Sharing goes through a bot. | same | What a person's agent produces on a card is shared. What the agent knows is not. |
| The host enforces, the renderer displays. | `AGENTS.md`, gateway gate | Every visibility and run rule in this spec lives in the host. |
| No new modes, harnesses, rail entries or packs on `main` (2026-10-01). | `AGENTS.md`, "Current focus" | The board is a new surface. It is built here and goes to `main` only by a promotion PR. **Rizky has not yet lifted the freeze for the build; this spec is design only until he does.** |
| Enterprise-only work is gated to server mode, with a Personal-parity test. | `AGENTS.md`, BYOK exception | Personal shows no board in v1 (decision K-D7). |
| Design only, "dont make it too complicated" (2026-10-06), for per-person knowledge. | `chat-first-plan.md`, "Hiring a bot" | The personal agent store is the first piece of per-person knowledge to be built. Building it lifts that 2026-10-06 hold for this one store, and needs Rizky's word. |

## 2a. What exists today (read 2026-10-12 on `tester/chat-first`)

| Piece | Where | What it means for the board |
|---|---|---|
| Person and company on a hosted request | `resolvePortalTenant`, `packages/db/src/portal-owner.ts:279-329`; role from `organization_members.role` (`:300-304`, `storedRole` `:335`) | The task service gets `tenantId`, `organizationId`, `workspaceId`, `userId` and `role` from the existing context. No new identity code. |
| Desk access | `portal-owner.ts:309-316` checks only that the desk belongs to the company. `workspace_members` is never read for access. | **Any member of a company can open any desk of that company.** The board inherits this. If a board must be visible to some people only, desk access needs a real membership check first (finding below). |
| Threads per person | `threads.user_id`, `packages/db/src/schema.ts:436` | A personal agent's conversations are already per person. |
| Messages | `schema.ts:443-458`, no per-person column | Access goes through the thread. |
| Desk files, versioned | `desk_files` `schema.ts:953`, `desk_file_versions` `schema.ts:979` (author kind `user` or `agent`) | Card files reuse them (section 6). |
| Private chat uploads | `privateFolderFor(userId)`, `packages/host/src/desk-files/private-uploads.ts:29` | A per-person folder on the desk; the copy-to-card action copies out of it. |
| Knowledge | `knowledge_sources` and its siblings, `schema.ts:503-599`, keyed by `workspace_id` only | **There is no per-person knowledge today.** The personal agent store's Knowledge part is new work. |
| Run policy for an agent | `runPolicyFor`, `packages/host/src/virtual-agents.ts:185` | The dispatcher builds a card run through it. |
| Paid media cap per turn | `PAID_MEDIA_PER_TURN`, `packages/core/src/agents/virtual-agents.ts:107` | Applies to a card run unchanged. |
| Job event stream | `streamJob`, `packages/host/src/job-stream.ts:39` | One request, one stream. There is no broadcast to several clients and no event log or notification table today (none in `schema.ts`). |
| Server mode | `isServerMode`, `packages/core/src/server-mode.ts:12-15` | Every board route checks it. |

**Finding, needs Rizky's call and a security-register row:** company-wide desk access (`portal-owner.ts:309-316`). It may be the intended rule ("a company shares a desk"), in which case it should be written down as such. If some desks are meant for some people only, it is an access-control gap on `main` as well, and it is fixed on `main` first.

## 3. Words

| Word | Meaning |
|---|---|
| Board | One company's set of columns and cards. v1 has one board per company desk. |
| Card | A unit of work: title, description, status, assignee, files, comments, mentions. |
| Assignee | Exactly one of: a person (`user:<id>`), or a person's agent (`agent:<userId>`). A card may have no assignee. |
| Personal agent | The one agent each person owns. It is a full chat agent like the tester's virtual agents (`chat-first-plan.md`, instruction 3), plus the person's profile. |
| Agent owner | The person whose agent it is. Only they configure it, read its store and approve its card work. |
| Participant | The card's creator, its assignee (or the assignee agent's owner), and anyone mentioned on it. |
| Card event | One row in the event log: created, edited, moved, assigned, commented, file added, agent started, agent finished, agent asked. |

## 4. The two stores

### 4.1 Company store (the admin maintains it)

Tables, each with `tenant_id` and `workspace_id`:

| Table | Holds |
|---|---|
| `board_columns` | id, name, position, `kind` (`todo` / `doing` / `review` / `done` / custom). |
| `cards` | id, title, description (markdown), column, position, `assignee_kind` (`person` / `agent` / null), `assignee_user_id`, created_by, due date, timestamps, `version` (for edit conflicts). |
| `card_comments` | id, card, author (`user:<id>` or `agent:<userId>`), body, timestamps. Agent output is a comment with artifact links. |
| `card_mentions` | comment or card, mentioned `user:<id>` or `agent:<userId>`. |
| `card_files` | card, a link to a desk file version (`desk_files` / `desk_file_versions`, which are already versioned per desk), who attached it. |
| `card_events` | append-only log: id (monotonic), card, actor, type, payload JSON, time. This is the sync source of truth. |
| `notifications` | recipient user, event id, read time. |
| `agent_tasks` | the queue of agent work: card, agent owner, state (`waiting_accept` / `queued` / `running` / `needs_input` / `done` / `failed` / `cancelled`), run id, attempt, cost so far. |

The admin's role in v1: create and rename columns, archive cards, remove a person from the board, and decide what happens to a leaver's cards. Admins read every card. They do not read any personal agent store.

### 4.2 Personal agent store (one per person)

| Part | Holds | Who writes |
|---|---|---|
| Profile | Workstyle: tone, language, format preferences, working hours. | The person, in their agent's settings, or by telling the agent in chat. |
| Workflow | Ordered steps the agent follows for a kind of card ("for a client brief: research, outline, draft, check figures"). Each step names a tool from the registry or a worker. | The person. |
| Skills | Which registry tools and workers this agent may use, within the plan's ceiling, plus saved instructions per skill. | The person, inside the host's limits. |
| Memory | What the agent learned from this person's chats and finished cards. | The agent, through the existing memory path; the person can delete. |
| Knowledge | The person's own Knowledge Base sources. | The person. |

The host builds every agent run from this store the way it builds a hired bot from its spec (`chat-first-plan.md`, "Hiring a bot"): a person cannot add a tool that is not in the registry, raise a budget above the plan's ceiling, turn off write approval, or turn off redaction.

### 4.3 One file or two: decision K-D1

The hosted app is one process on one SQLite file today (SR-29, SR-66), and the product database engine is open decision 1 in `web-pivot-2026-09-18.md`. So "two databases" can be built two ways:

| | A. Two logical stores in one database | B. Company database plus one encrypted file per person |
|---|---|---|
| How | Table groups with a host-enforced boundary. Personal rows carry `owner_user_id`; one module reads them and refuses any caller who is not the owner. | Company tables stay in the product database. Each person's store is `<dataDir>/people/<tenantId>/<userId>.sqlite`, sealed under a per-person key derived from the wrap key (`HKDF(wrapKey, "person-v1:" + tenantId + ":" + userId)`). |
| "Admin cannot read" | A rule in code. One wrong query breaks it. | The admin's request never opens the file. A bug elsewhere cannot join across it. |
| A leaver | Delete rows by owner. | Delete or keep one file. |
| Export of one person's data | A query. | Copy one file. |
| Stage 3 (several servers) | Moves with the product database. | Files must move to object storage, like customers' files already must (`AGENTS.md`, "Hosting and scaling"). |
| Cost to build | Lower. | Higher: a second connection per run, schema migration per file. |

Recommendation: **B for the personal agent store**, because it makes Rizky's "it must be blocked" a property of where the data is, not of every query. Be plain about the limit: the server holds the wrap key, so the operator of the server can decrypt any file. "Admin" here means the company's admin inside the app.

## 5. The task service: what connects them

One host module, `packages/host/src/board/`, is the only writer of the company tables above.

```
renderer ──HTTP──▶ board routes ──▶ task service ──┬─▶ company store (one transaction:
                                                   │      change + card_events row)
                                                   ├─▶ event bus ──▶ SSE to each viewer
                                                   ├─▶ notifications (mentions, assigned, done)
                                                   └─▶ agent dispatcher ──▶ agent run
                                                                              │
                          personal agent store ◀── read by the owner's run ───┘
                          card comment + files ◀── result posted back ────────┘
```

Rules:

1. **Every change writes its event in the same transaction.** A change without an event row cannot exist, so a client that missed a message can always catch up from the log.
2. **The bus carries event ids, not content.** Each SSE connection is opened by one person. The service re-checks that person's right to see the card before it sends anything, so a card never reaches someone who may not see it.
3. **Edits carry the card's `version`.** A stale edit answers `409` with the current card, and the renderer shows it. No silent last-write-wins on the description.
4. **Agents do not create or assign cards in v1.** An agent may comment, attach files and move its own card to `review` or `blocked`. This stops one agent from handing work to another in a loop and spending tokens nobody approved.

### 5.1 Assigning a card to an agent

1. A person assigns a card to `agent:<userId>`. The task service writes an `agent_tasks` row in `waiting_accept` and notifies the agent's owner.
2. **The owner accepts** (decision K-D3). Only then does the run start. The owner can turn on auto-accept for cards they assign to their own agent.
3. The dispatcher starts a run of the owner's agent through the host's existing run path and run policy, with: the card's title and description, the card's files, the last comments, and the owner's workflow for this kind of card. The agent reads its owner's personal store. It reads no one else's.
4. Progress goes onto the card as `agent.progress` events, so viewers see it working.
5. If the agent needs input it posts a question that mentions its owner, and the card goes to `blocked`.
6. The result is posted as an agent comment, with its artifacts attached as card files. The card moves to `review`.
7. The owner approves, and the card moves to `done`. Or the owner sends it back with a comment, and the agent runs again with that comment added.

Why the owner accepts first: the agent reads its owner's private knowledge and then writes onto a shared card. If a teammate could start it, a teammate could make it pour out private material by writing the right card description. Acceptance puts a person between the request and the private data.

### 5.2 Mentions

- `@person` notifies them and makes them a participant.
- `@person's agent` in a comment asks that agent to reply on the card. It goes through the same acceptance as an assignment.
- Mention search lists people on the company and each person's agent. It never lists anything from a personal store.

### 5.3 Sync

- `GET /api/v1/board/events` is an SSE stream for the person's company desk, with `Last-Event-ID` resume from `card_events`.
- One process today: an in-process bus is enough.
- More than one server (Stage 3): the bus moves to Postgres `LISTEN/NOTIFY` or Redis. The event log stays the source of truth, so the wire to the renderer does not change.
- The packaged Personal app has no HTTP port. If Personal ever gets a board, the stream goes over the IPC bridge (`window.agentforge`) like every other call.

## 6. Files on a card

- A card file is visible to everyone who can see the card. It is stored as a desk file version in the company scope, so it is versioned and survives a re-upload.
- A file attached in Chat stays private to its owner. To put it on a card, the owner copies it there with a deliberate action. The copy is the company's; the original stays private.
- A file the agent makes during a card run is attached to the card. It is company data from then on.
- Size and type limits are the existing upload limits. Extraction uses the existing local extractor; no hosted OCR.

## 7. Privacy and leakage rules (host-enforced)

1. A personal agent store is opened only for: its owner's own requests, and runs of its owner's agent.
2. No admin route reads a personal store. The admin's leaver choice is "keep" or "delete", per `AGENTS.md`.
3. Card text and card files are **untrusted input** to the agent, the same as a web page. The egress guard (`packages/core/src/runtime/egress-guard.ts`) must treat a card run as having read private material from the first step, because the agent's own knowledge is private.
4. What an agent posts on a card is shared. The run's prompt says so, and the review step lets the owner catch a leak before `done`. This is a rule for the model, not an enforcement; the enforcement is rules 1 and 3 plus the owner's acceptance.
5. Every route checks the company (tenant) and the person's membership of the desk before it reads a card.

## 8. Cost

- An agent run on a card spends tokens like any other run. Whose key: decision K-D4. Default: the owner's personal key if they have one (BYOK), otherwise the company key.
- A card run has the plan's run budget and the paid-media cap per turn (`PAID_MEDIA_PER_TURN`).
- Agents cannot start each other (rule 4 in section 5), so a card run cannot fan out.

## 9. Routes (sketch)

| Route | Does |
|---|---|
| `GET /api/v1/board` | columns and cards the person may see |
| `POST /api/v1/board/cards` | create |
| `PATCH /api/v1/board/cards/:id` | edit with `version`; move; assign |
| `POST /api/v1/board/cards/:id/comments` | comment, with mentions |
| `POST /api/v1/board/cards/:id/files` | attach (upload, or copy from the person's own files) |
| `POST /api/v1/board/agent-tasks/:id/accept` · `/decline` · `/approve` · `/send-back` | the agent owner's controls |
| `GET /api/v1/board/events` | SSE stream with resume |
| `GET /api/v1/me/agent` · `PUT /api/v1/me/agent` | the person's own agent profile, workflow and skills; owner only |
| `GET /api/v1/notifications` · `POST /api/v1/notifications/read` | the person's notifications |

All are server-mode only in v1 and answer `404` on Personal.

## 10. In the chat-first shell

The north star is chat-first, so the board is not only a page:

- The person's own agent is a conversation in the rail, like the virtual agents. Its side panel gets a **Cards** tab: what it is working on, waiting for acceptance, and in review.
- A card can be opened from a chat as an embed, and "make this a card" is a chat action.
- The full board is one account page beside Knowledge Base and Settings.

## 11. Phases

| Phase | Builds | Proof |
|---|---|---|
| K0 | Company tables, task service, event log, SSE, board page; people only, no agents. | Two browsers on two accounts see each other's moves live; a member of another company sees nothing. |
| K1 | Personal agent store (per decision K-D1), the person's agent profile page, workflow and skills within the host's limits. | An admin's session gets `404` on every personal-store route; a leaver delete removes the store. |
| K2 | Assign to an agent: accept, run, progress, result, review. | A card run end to end on webdev with a real key; the agent read its owner's knowledge and no one else's. |
| K3 | Mentions and notifications. | |
| K4 | Card files and the copy-from-private action. | A chat attachment stays private until copied. |
| K5 | Promotion PR to `main`, after Rizky approves. | `ci:local` green; Personal-parity test. |

## 12. Decisions needed from Rizky

| # | Question | Default this spec assumes |
|---|---|---|
| K-D0 | Lift the 2026-10-01 freeze for building the board in the tester code? | Not lifted; design only. |
| K-D1 | Personal agent store: one database with a rule (A), or a sealed file per person (B)? | B. |
| K-D2 | One board per company desk, or several boards (per team, per project)? | One. |
| K-D3 | Must the owner accept before their agent runs on a card someone else assigned? | Yes. |
| K-D4 | Whose key pays an agent's card run? | The owner's personal key, else the company key. |
| K-D5 | Must a person approve agent work before `done`? | Yes, the agent's owner. |
| K-D6 | When a person leaves: their open cards go to whom, and their agent's comments stay? | Cards go back to unassigned; comments and files stay (they are company data). The personal store follows the admin's keep/delete choice. |
| K-D7 | Does Personal get a board (agents only, one human)? | Not in v1. |
| K-D8 | Is the board on the free trial? | Yes, within limits. A card run that needs a computer needs a paid plan, as with routines. |

## 13. Risks

1. **Private knowledge leaking onto a shared card.** Covered by owner acceptance, the egress rule, and review. A determined owner can still paste their own private material onto a card; that is their choice.
2. **Prompt injection through a card.** A card description can instruct the agent. It is untrusted input (section 7, rule 3).
3. **Event fan-out leaking cards** to people outside the desk. Covered by the per-connection check in section 5, rule 2. Needs a test with two companies on one server.
4. **Cost runaway.** Agents cannot create or assign cards, and each card run has the plan's budget.
5. **Stage 3.** The in-process bus and per-person files both need work before a second server. The event log design keeps the renderer side unchanged.
