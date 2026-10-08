# Chat-first plan (2026-10-06)

Status: **draft for Rizky's review. Nothing here is built.**
Direction it serves: `AGENTS.md`, "Product direction (Rizky, 2026-10-06): Nultron + HYP AI, chat-first".
Specs: [`chat-workers-spec.md`](chat-workers-spec.md) (harnesses called from chat), [`model-tiers-spec.md`](model-tiers-spec.md) (masked models) and [`chat-computer-spec.md`](chat-computer-spec.md) (the orchestrator, its computer and the safety design).
This plan belongs to the tester code. See [`TESTER.md`](../../TESTER.md).

## 1. The change in one paragraph

Today Nultron is a rail of 14 mode screens, and Chat is one of them. After this plan the product is one chat screen. A person types a request, adds files if they have any, and the chat agent calls the right **worker**: the existing mode harness (prompt, tools, checks, output) wrapped as a tool. The result appears in the thread as a card that can be opened, edited and partly regenerated. The mode screens stay in the tree, parked and unreachable from the rail. The model picker is replaced by three choices, Daily, Fastest and Reasoning; the host turns the choice into a real model and the renderer never learns which.

## 2. What exists today (verified 2026-10-06 at `6105c5c`)

**Chat.**
- Send path: `ChatComposer.send()` (`apps/web/components/chat-composer.tsx:321`) posts `{content, model}` to `/api/v1/threads/:id/runs/text`; the host runs `startModalityRun` (`packages/host/src/runs.ts:130`) and streams SSE back.
- The renderer handles seven stream events: `run.started`, `run.probing`, `assistant.delta`, `assistant.thinking`, `tool.started`, `tool.completed`, `run.failed` (`chat-composer.tsx:163-178`).
- A stored message has five part types: `text`, `image_url`, `video_url`, `thinking`, `tool_call` (`packages/core/src/content/types.ts:36`).
- The chat agent binds 15 tools (`DEFAULT_CHAT_TOOLS`, `packages/core/src/agents/default-chat.ts:39`) under a budget of 12 steps and 40 tool calls (`packages/core/src/harness/modes/chat.ts`).
- Chat has no model fallback. Jobs have one (`packages/host/src/job-model-fallback.ts`).

**Modes.**
- Every mode has one harness spec (`packages/core/src/harness/modes/`) of type `ModeHarnessSpec` (`packages/core/src/harness/spec.ts:20-29`).
- No mode harness is callable from Chat. The only chat tools that overlap a mode are `image_generate` and `video_generate`, and they call the gateway directly without writing a gallery row.
- Six modes already start from one prompt: research, documents, presentations, images, videos, music. Market needs a prompt plus tickers.
- Five need state that only their screen collects today: finance (task and figures or a dataset), data (a dataset), legal (a matter with files, side, work type), meeting (a recording or transcript), edit (a project).
- Jobs stream a shared event set, `job.phase | step | source | delta | round | done | error` (`packages/core/src/jobs/job-events.ts`), through `streamJob` (`packages/host/src/job-stream.ts:30`).
- There is no shared job table. Research, documents, presentations, finance, data and market each save a row in the kernel artifacts table. Meeting writes artifacts, legal writes its own run rows, media writes gallery rows.
- One section can be regenerated in documents, presentations, finance and market. Research, data, legal and meeting have no such route.

**Shell.**
- The rail shows `PRODUCT_MODES` filtered by the desk's `productModes` (`apps/web/components/app-rail.tsx:207`). A hidden mode's path redirects (`redirectIfHiddenMode`, `packages/core/src/agents/product-modes.ts:172`).
- Hiding is per desk. No switch hides a mode for everyone.

**Models.**
- The catalog comes from the gateway, cached per tenant, curated into friendly labels and a Recommended group (`packages/core/src/models/curation.ts`, `preferred.ts`).
- The only tier that exists is `everyday | advanced` (`model-policy.ts:63`). "Fast drafts" and "Deep reasoning" are hint strings, not choices.
- Raw model ids reach the renderer in the picker, 14 studio selects, the usage page, one fallback notice, one error string and the run stream.

## 3. Target

**Reference (Rizky, 2026-10-06):** the screenshot kept at `nultron-files/chat-first/reference-2026-10-06.png`. It shows a narrow icon rail, plain message bubbles, a small card inside the thread with a title, one line of text and one button, and a composer that is only `+` and a message box. His words: "simple like this. just chat with multiple capabilities", the modes "being turned into the backend harness". When this plan and the reference disagree, the reference wins.

1. **One screen.** `/chat` is the product. The rail is icons only: chat, search, and the account pages (Knowledge, Channels, Workspaces, Usage, Settings).
2. **Workers, not screens.** Each harness is a tool the chat agent calls. The person just asks. The screen has no mode switch.
3. **Results in the thread.** A worker's result is a small card in the message: a title, a line or two, one button. The button opens the full result over the chat; Back returns to the thread. No split view, no side panel.
4. **Change by asking.** "Make slide 3 shorter" in the thread is the first way to edit a result. Inline edits in the opened result come after (phase C3).
5. **Files are the setup.** Attaching a spreadsheet, a contract or a recording replaces the mode's form. What the harness cannot infer, the agent asks in the thread.
6. **A bare composer.** `+` and the message box. Files, the model tier and the explicit worker choice all live under `+`. Nothing else sits on the composer.
7. **Three model choices.** Daily, Fastest, Reasoning, with Daily chosen for you. Details in the tiers spec.
8. **Same on both products and under white-label brands.** HYP AI carries the same shell under its own name.

The reference also shows the assistant starting a message on its own, a scheduled check-in. That needs a scheduler and runs that keep going without an open tab. Both are in track K: runs that outlive the tab in K1, scheduled tasks in K4.

### Second reference (Rizky, 2026-10-06 evening): bots that run on harnesses

Kept at `nultron-files/chat-first/reference-2026-10-06-bots.png`: a screenshot of the OpenMausBot desktop app. His words: this "is how I envisioned the new chat modes". It "will also incorporate into the embedded modes tools with different harness on different agents". The difference from that product: "in our platform we have the capabilities to design a bot that is fully working on a harness instead of just skills and instructions". And "there will also be a UI interface in case you needed control and field to fill in".

Ideas only, as with every `.ref/` source. No code, layout file or asset is taken from it.

What the screenshot shows:

- A rail of bots, one icon each. Picking one opens that bot's own conversation.
- A header with the bot's name and a chip for the model behind it.
- A side panel with three tabs: Computer, Routines, Browser.
  - Computer: a live picture of the bot's screen, **Take control** and **Sleep**, and "Works on": Auto, Cloud (hosted desktop), Local VM, This computer, Browser (web pages only), Off.
  - Cloud provider: managed, or a self-hosted VPS.
  - Routines: the bot's schedules.
- A new bot that asks four setup questions in the thread: the job, when it runs, which apps it touches, which folder it works in.

What it means for this plan:

| Was (first reference) | Now |
|---|---|
| One chat. The harnesses are workers the chat agent calls. No mode switch on screen (target 2). | **Several bots in the rail.** Each bot is one harness with its own conversation. The generalist stays as the first bot and can still hand work to the others. |
| No split view and no side panel (target 3). | **A side panel per bot**, opened on demand: Computer, Routines, and the bot's own controls. Result cards in the thread stay. |
| Files and questions replace every form (target 5). | Still the first way. **A bot may also show a control panel** with fields, for the cases where a form is faster than a conversation. It is the mode's existing "More" controls, moved beside the chat. |

What sets ours apart, in his words and in the code: a bot here is a **harness spec**, not a prompt with skills. The spec (`packages/core/src/harness/modes/`) fixes the prompt, the tools the bot may call, its step and cost budget, the checks its output must pass and the judges that run in code. The host enforces it on every run (`packages/host/src/job-regen.ts`). A bot elsewhere is instructions the model may ignore.

The built-in bots are the modes that exist: Research, Documents, Presentation, Finance, Data, Market, Legal, Meeting, Images, Videos, Music, Edit, Education. No new mode is added, so the 2026-10-01 rule holds.

Not decided, each with the default this plan assumes:

| # | Question | Default |
|---|---|---|
| B-D1 | Does a person design their own bot, or only use the built-in ones? Designing one means a harness editor, and custom-agent Build is parked by `AGENTS.md`. | **Answered 2026-10-06:** "yes the people are able to hire their own bot". A person adds bots to their desk, built-in ones and ones they set up. That lifts the parked-Build rule in the tester code. See "Hiring a bot" below. |
| B-D2 | Does the bot rail replace the first reference's icon-only rail, or sit inside it? | It replaces it: bots first, then the account pages. |
| B-D3 | Which "Works on" choices we offer. | **Answered 2026-10-06:** the cloud computer (VPS) and the person's own computer are paid features. A free trial cannot use either, and what it does get is limited, with no graphical screen. See "Free and paid" below. No local VM. |
| B-D4 | One conversation per bot, or many. | Many, as Chat has today, listed under the bot. |

This adds **track B (bots)** to section 5 and moves two phases of track C: the result card and the worker contract stay, the "park the screens" phase (C4) becomes "each screen's controls become its bot's panel".

#### Hiring a bot (Rizky, 2026-10-06: "yes the people are able to hire their own bot")

"Hire" is the word on screen: a desk is a one-person company and a bot is a worker on it.

- **Hire a built-in bot.** Pick it from the list. It arrives complete, because it is a harness we wrote. This replaces the Workspaces checkboxes.
- **Hire your own bot.** The person answers a few questions in the thread, as the reference does (the job, when it runs, what it touches, where it works). The answers fill a **harness spec**, not a block of instructions: a prompt, a set of tools chosen from the registry, a budget, an output type, and checks picked from the ones that exist.
- **What a person cannot do.** Add a tool that is not in the registry, raise a budget above their plan's ceiling, switch off the approval step for a write, or switch off redaction. The host builds the run from the spec and refuses the rest, the same way it does for built-in bots.
- **Judges.** A built-in bot has judges written in code for its output (figures computed in core for Finance, the slide checks for Presentation). A person's bot gets the generic checks only. Say so on screen, so nobody reads a hired bot's output as checked the way Finance's is.

- **A bot has its own knowledge, and that is what a team shares** (Rizky, 2026-10-06). On Enterprise each person's Knowledge Base is private to them. A bot carries knowledge of its own: the sources its owner gives it. Sharing a bot with the team shares that knowledge with it, so teammates can use the bot and call it from their own conversations. A person's private knowledge never travels with a bot unless they put a source into the bot on purpose. The host checks on every retrieval which knowledge a run may read: the caller's own, plus the knowledge of the bot being run, and nothing else.
- **When a person leaves** (Rizky, 2026-10-06): the business owner or an admin decides whether that person's knowledge, and the bots they made, are deleted or kept.
- **Nobody else reads a person's knowledge, the owner and admins included** (Rizky, 2026-10-06: "they cant read the knowledge, it must be blocked. and protected by legal clausal terms later"). They may delete it or keep it. They may never open it. The host blocks the read; the legal terms come later and do not replace the block.
- **Design only for now** (Rizky, 2026-10-06: "dont make it too complicated for now, this is design only for now, focus more on the chat and multiple agents to be working"). Knowledge per person, knowledge per bot, sharing and leaver controls are not built in this round. The build order is: the chat works, then several bots work and hand tasks to each other (C0, B0, B1). Knowledge ownership comes after that, as its own phase.

This is the parked custom-agent Build coming back, under a different shape. The published code keeps it parked (`AGENTS.md`); the tester code builds it in phase B5. The agent tables and Studio files that stayed in the tree for "a later show Build again pass" are where it starts.

#### Free and paid (Rizky, 2026-10-06)

His words: "this vps and own computers is for the paid customer features, otherwise its not possible to use it on a free trial and the usage is limited such as no graphical interface".

| | Free trial | Paid |
|---|---|---|
| Bots, conversations, result cards | Yes, within the trial's limits | Yes |
| Built-in tools that run inside the app: web search and fetch, desk files, knowledge search, the code sandbox | Yes, within limits | Yes |
| The cloud computer (a VPS the bot works on) | No | Yes |
| The person's own computer ("This computer") | No | Yes |
| A graphical screen: the live picture, Take control, a desktop | No | Yes, where the cloud computer or own computer is on |
| Routines (scheduled runs) | Yes | Yes |

Routines are free (Rizky, 2026-10-07): "routines are free, since they cost tokens anyway". A scheduled run spends the person's tokens like any other run, so the plan does not gate it. A routine that needs the cloud computer or the person's own computer still needs a paid plan for that part.

Two rules follow from the repo's own:

- **The host decides, the screen shows.** Whether a desk may start a computer comes from the plan the portal reports for that customer, checked by the host on every start. The renderer only greys the choice out and says why. A check in the renderer alone is not a check (`AGENTS.md`, "The gate is advisory").
- **A paid computer has a size and a bill.** It is the only part of the product whose cost grows with each paying seat. The sizing and the 40% margin sums are in the vault note `40-Dev/nultron-hosting-map.md`; a dedicated 4 vCPU / 8 GB machine does not fit inside a 20 USD seat, so the paid computer is a capped share of a machine unless the plan is priced for a whole one.

## 4. Decisions needed from Rizky

Each has a default the plan assumes until he says otherwise.

| # | Decision | Default assumed |
|---|---|---|
| D1 | What to borrow from Dots and Muse. | **Answered 2026-10-06** by the reference screenshot in section 3. |
| D2 | How deep the model mask goes: display only, or the renderer never receives real ids. | The renderer never receives them. An owner-only switch in Settings, under More, shows real names. |
| D3 | Whether a worker uses its own tier or follows the person's choice. | Its own tier from its spec. The person's choice sets the chat agent only. |
| D4 | Paid media from chat: run at once, or show a cost card with Run. | Videos and music show a cost card and wait for Run. Images run at once, as today. |
| D5 | The first-desk hard rule (`FIRST_RUN_MODES`, 2026-09-29) once the rail has no modes. | Desk data and its tests stay untouched. The chat-first shell ignores `productModes` for the rail, and every worker is available on every desk. |
| D6 | Whether a desk can still switch workers off (the old Workspaces checkboxes). | Yes, later. Not in this plan. |
| D7 | Whether the parked screens stay reachable by URL for the owner. | Yes on webdev only, behind a dev switch. Never in a packed or hosted build. |
| D8 | The 0.16.0 installers were packed before two fixes that are now on `main`. Publish them, repack, or skip 0.16.0 for the chat-first release. | Not published. The next public Personal release is the chat-first one. |
| D9 | "No new modes" (2026-10-01). Workers add tools, not modes, so the rule is kept as written. | Kept. |

**Confirmed 2026-10-06.** Rizky said "go ahead, use the defaults". That settles D2 to D9 as written, approves the seed model lists in `packages/core/src/models/tiers.ts`, and lets the two K0 fixes to published behaviour (gaps G6 and G7) start on `main`. Still open, with no default: how a Personal user gets a cloud computer (C7), and the size and cost of the second Tencent server (C8).

## 5. Phases

Four tracks. Track M (models) is small and independent, so it ships first. Track K (the orchestrator and its computer) makes the chat agent a generalist that can build things. Track C (chat workers) moves the modes behind the chat. Track B (bots), added on 2026-10-06, is the screen that shows each harness as a bot with its own conversation and side panel.

### Track M: model tiers

| Phase | Outcome | Proof |
|---|---|---|
| M0 | Tier registry and resolver in core. No UI change. | Unit tests: resolution order, breaker skip, unknown tier, Personal parity. |
| M1 | Chat sends a tier. The picker shows three choices. | Drive on `:3200`: each tier answers; the network tab shows no model id in the request. |
| M2 | Every leak closed: catalog route, run stream, usage page, notices, errors. | A test that fails if a catalog model id appears in any renderer-bound payload. |
| M3 | Chat falls back inside its tier. Workers resolve their own tier. | Kill the head model of a tier in a test; the next one answers. |
| M4 | Enterprise BYOK: tier lists per provider. Server mode only. | Personal-parity test, as every BYOK change requires. |

### Track K: the orchestrator and its computer

Full detail in [`chat-computer-spec.md`](chat-computer-spec.md). K0 comes before C0, because workers need approval cards and the plan card.

| Phase | Outcome | Proof |
|---|---|---|
| K0 | Gaps in what exists are closed: approval cards, a visible stop with Continue when a budget runs out, secret redaction on tool results, the `plan` and `ask_user` tools, time and cost ceilings, a decision record. | Drive each on `:3200`. A test that a secret in tool output never reaches the stream. |
| K1 | The orchestrator: sub-agents, a short memory for each desk, context trimming, a skill index, runs that keep going when the tab closes. | A 30-step task finishes on Daily with the tab closed halfway. |
| K2 | SR-111 closed, then the computer on a second Tencent server, with a shell and files. Hosted desks only. | The agent builds and runs a small web app, and its own tests pass in the container. |
| K3 | The headless browser, with screenshots the person can see. | The agent finds a layout fault in the app it built from a screenshot and fixes it. |
| K4 | Scheduled tasks the person confirms, then a virtual screen if a real task needs it. | A daily task reports into its thread. |

**K0 splits between the two codes.** Two of its items fix what the published version does today, so under the two-codes rule they are fixed on `main` first and merged down, never fixed by hand in both: a run that spends its steps on tools ends with no answer and no notice (gap G6), and tool inputs and outputs are not redacted for secrets (gap G7). The approval cards, the `plan` and `ask_user` tools, the time and cost ceilings and the decision record are new, so they are built in the tester code. Starting the published-code part needs Rizky's word, because `main` carries uncommitted edits and the repo rule is no commit unless asked.

### Track C: chat workers

| Phase | Outcome | Proof |
|---|---|---|
| C0 | Foundations: the worker contract, an `artifact` message part, a `tool.progress` stream event, the result card, the full-result view, and the bare composer and icon rail from the reference. **One worker end to end: research.** | Ask Chat for a dossier on `:3200`; progress shows live; the card opens the dossier; the artifact row exists. |
| C1 | Prompt-first workers: documents, presentations, market, images, videos, music. Media results write gallery rows. Hand-off by artifact id ("turn that into a deck"). | One drive per worker, plus research to deck in one thread. |
| C2 | File-driven workers: data, finance, meeting, legal. An attachment becomes the dataset, matter or meeting. The agent asks for what it cannot infer. | Attach one xlsx, one docx, one audio file; each produces its result without leaving chat. |
| C3 | Editing in the opened result: inline edit and regenerate-one for documents, presentations, finance, market. Edit and education workers. | Regenerate one slide from the opened deck; the person's inline edits survive. |
| C4 | Park the screens. Rail reduced. Onboarding and the guide rewritten for one screen. Maps and recipes refreshed. | `ci:local` green, verify pass on webdev, then a packed Windows build driven with `doctor --desktop`. |

C0 is the phase that proves the design. If research does not feel right in the thread, stop and change the contract before building eleven more.

### Track B: bots (added 2026-10-06, from the second reference)

Track B is the screen for what tracks K and C build. It starts after C0, because a bot's conversation needs the worker contract and the result card.

| Phase | Outcome | Proof |
|---|---|---|
| B0 | A bot registry read from the harness specs: name, icon, one line on what it does, its tools, its tier, its output type. No screen change. | A test that every mode with a harness spec yields exactly one bot, and that a bot can call no tool its spec does not list. |
| B1 | The rail lists the bots. Each opens its own conversations. The generalist is first and can hand a task to another bot, which answers in its own thread with a link back. | Drive on `:3200`: ask the generalist for a deck; the Presentation bot's thread holds the result; the first-desk rule decides which bots a fresh Personal desk shows. |
| B2 | The side panel: the bot's controls (the mode's "More" fields), bound to the same values the conversation sets. A value set in the panel shows in the thread as a short note, and the other way round. | Change a deck's slide count in the panel, then by asking; both paths give the same run input. |
| B3 | The Computer tab: the screen picture, Take control, Sleep, and "Works on". Needs K2 and K3. | The Research bot opens a page in its browser; the person takes control, clicks, and hands it back. |
| B4 | The Routines tab: schedules the person confirms. Needs K4. | A daily Market briefing lands in the Market bot's thread with the tab closed. |
| B5 | Hire your own bot: the setup questions fill a harness spec, the host enforces it, and the bot joins the rail. Plan ceilings apply. | A person hires a bot that reads a folder of invoices and writes a weekly summary; a tool outside its spec is refused by the host, not by the prompt. |
| B6 | Free and paid: the host reads the plan and refuses a computer start on a free desk; the choice is greyed with the reason. | A free desk gets `403` with a reason code on a computer start through the API, not only a greyed button. |

The first-desk hard rule still decides what a fresh Personal desk shows: Chat (the generalist), Research, Images, Videos, Presentation. Bots replace rail entries one for one, so `FIRST_RUN_MODES` and its tests are not touched.

## 6. What gets parked, and how

- A single constant, `SHELL_LAYOUT`, in `packages/core/src/agents/product-modes.ts` decides `"chat-first"` or `"modes"`. The rail and `redirectIfHiddenMode` read it. One place, one test.
- Parked screens keep compiling and keep their unit tests. Their **result** components are reused by the full-result view; their setup forms are what is parked.
- Host routes for each mode stay. The worker tools call the same entry functions in process, so the routes still work and the existing route tests still cover them.
- Nothing is deleted in this plan. Deleting parked code is a later decision, after a release has shipped without it.

## 7. Risks

1. **Routing by a weak model.** A Fastest-tier model may call the wrong worker or none. Mitigation: explicit worker selection in the composer, tier lists limited to models verified for tool calls, and an eval set of 40 requests with the expected worker.
2. **Context cost.** A dossier or a deck returned whole into the chat context would bloat every later turn. Mitigation: a worker returns a short summary and an artifact id; the agent reads the artifact with a tool only when asked about it.
3. **Long runs inside a chat turn.** Research and legal run for minutes; the chat watchdog and the step budget were sized for short tools. Mitigation: worker calls get their own time budget and stream progress so the watchdog sees activity.
4. **Paid steps triggered by the model.** A model that decides to make three videos spends real money. Mitigation: D4, plus per-tool caps in the chat budget.
5. **Private reads then egress.** The egress guard (SR-112) blocks `web_fetch` after a private read. Research needs the web; a thread that has read a desk file may then refuse research. Needs a ruling in C0.
6. **Two products, one renderer.** Every change lands on Personal and Enterprise. BYOK tier lists stay server mode only.
7. **HYP AI clone drift.** The clone syncs by vendor branch. A shell rewrite makes that sync large; do it once, after C4.

## 8. How the work is run

- One lane per worker, each owning its own tool file, its card and its test, so lanes do not collide. Shared files (`content/types.ts`, the stream reader, `chat-turn.tsx`) change only in C0.
- Every lane: read the map page, write the test first, drive on `:3200`, refresh the map and the recipe in the same change.
- Each phase ends with `npx pnpm@9.15.9 ci:local` and a driven check, not a green `tsc`.
- New verify recipes: `features/chat-workers.md` and `features/model-tiers.md`. New map pages: `chat-workers.md` and `model-tiers.md`.
- New security register rows are expected for: worker tools and trust levels, model-triggered paid steps, the egress ruling, and the mask (what the renderer may still learn from timing or errors).

## 9. Order of work

1. Rizky answers D2 to D4. D2 and D3 block Track M; D4 blocks C1.
2. M0 and M1.
3. K0, which fixes what already exists.
4. C0, with research only. Review with Rizky before going further.
5. M2 and M3 alongside C1 and K1.
6. C2 and K2.
7. C3, then C4 and a tester build.
8. K3 and K4.

All of this is built in the tester code, `C:\Users\rizky\agentforge-chat` on `tester/chat-first`. The published code on `main` does not change until Rizky approves a phase for promotion. See `TESTER.md`.
