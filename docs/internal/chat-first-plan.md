# Chat-first plan (2026-10-06)

Status: **draft for Rizky's review. Track M's M0 and M1 are built and committed on `tester/chat-first` (the tier resolver and the Daily, Fastest and Reasoning picker). Since 2026-10-09 the parts listed in the update below are built in the uncommitted tester working tree. Everything else here is not built.**

### Update 2026-10-09: virtual agents pulled ahead

The owner said: "we're going to revamp this to be more like muse and hark style, focuses on UIUX of the chat mode, removing all the workspaces and hide them, also to rebrand the name of workspaces into virtual agents, with each using their own harness and with skill and tools embed inside". That moved track B (bots) ahead of track C. On screen a "bot" is now a **virtual agent**, and "Workspaces" is now "Virtual agents". The status line above is older than this block: part of B and C0 is now written in the tester working tree (`tester/chat-first`, uncommitted). It was driven in part on `:3200` the same day, with the owner's key (record: `.cursor/skills/verify-agentforge/evidence/virtual-agents/2026-10-09-first-drive/RECORD.md`, rows 1 to 20). The code is described in [`maps/virtual-agents.md`](maps/virtual-agents.md), and the recipe, which says per step what was driven and what was not, is `.cursor/skills/verify-agentforge/features/virtual-agents.md`. The owner changed the model later the same day; see "Later the same day" below, which supersedes any line here that says otherwise.

Built in the working tree:

- **B0, the registry.** One agent per harness spec, with a test (`packages/core/src/agents/virtual-agents.ts`, `virtual-agents.test.ts`). The tools of an agent come from its registry entry, not from `ModeHarnessSpec.tools`. Every agent binds the same tool set (Chat's 17 tools plus `research_dossier`) under Chat's budget. `conversation` says only where the agent's own harness runs: `harness` (in chat) for Chat and Research, `studio` (in its studio screen) for the rest.
- **B1, partly: the rail and per-agent conversations.** `AgentRail`, `GET /api/v1/virtual-agents`, one agent row per desk, person and agent, and `/chat?agent=<mode>` with its own history, header and harness panel. One agent handing a task to another is **not** built. The B1 proof as written (the Presentation bot's thread holds the deck) cannot pass, but an Images agent, or any agent, builds a deck in its own thread (RECORD row 17). `SHELL_LAYOUT` is `"chat-first"` (`packages/core/src/agents/product-modes.ts:29`).
- **The C0 pieces Research needed.** One worker (`research_dossier`, `packages/host/src/workers/`), the `tool.progress` stream event (`packages/core/src/runtime/types.ts:29`), a dossier result card (`apps/web/components/chat-dossier-card.tsx`), and the bare composer (`+`, the message box, Send; `apps/web/components/composer-plus-menu.tsx`).
- **The Virtual agents page.** It replaces the Workspaces checkboxes at `/workspaces` (`apps/web/components/virtual-agents-page.tsx`). Hire and Let go change the desk's `productModes`.
- **The character stays out of the generated content.** The owner, 2026-10-09: "careful, to not let the IP overlap with the generated content". In this shell Nultron is not drawn on the composer ledge, where the thread scrolls behind it. It is the small head in the rail footer, the one place nothing scrolls under (`apps/web/components/agent-rail.tsx`, `DeskBuddyChip`; `chat-session.tsx`, `empty || shell`).

Not built: the specialty's own checked run for every agent except Chat and Research (it still lives in that agent's studio screen, which an empty conversation links to); the other twelve workers of C1 to C3; the side panel's mode controls (B2; the panel only says what the agent is made of); the Computer and Routines tabs (B3, B4); hiring your own agent (B5); the free and paid gate (B6); per-person and per-agent knowledge; and tracks K and M, which this update does not touch.

Where the build differs from the specs:

1. **One tool per worker, `research_dossier`, not the `run_worker` multiplexer.** It is bound to every agent, the default agent included (since the owner's later instruction, below). There is no `read_result` tool.
2. **The card is drawn from the saved `tool_call` part.** There is no `artifact` message part, and `packages/core/src/content/types.ts` is unchanged. The card is dossier-only, and Open shows the dossier inside the thread, not in a full-result view. `tool.progress` has no `toolCallId`, and the renderer reads the event's `label` rather than folding it with `reduceJobProgress`.
3. **The model tier sits in the agent header, not under `+`.** The `+` menu holds Add files and Enhance. There is no worker choice in it.
4. **Every agent binds every worker, and a mode agent is a full chat, not a single-harness bot.** The same tools and budget for all (`FULL_CHAT_TOOLS`, `FULL_CHAT_BUDGET`, `packages/core/src/agents/virtual-agents.ts:99-120`). An agent differs by its specialty prompt and its own conversations. This departs from "a bot is one harness" and "a bot elsewhere is instructions the model may ignore" (section 3, "Second reference"), because a mode agent's specialty is partly a prompt. It is the owner's call (instructions 2 and 3 below). What keeps it honest: the host still decides the tools and the budget, never the stored row or the prompt (`runPolicyFor`, `packages/host/src/virtual-agents.ts:185-206`), and the screen and the prompt say where the specialty's checked run lives.
5. **The default agent's tool bindings are not from the registry.** The default agent still binds the stored row's tools plus `past_sessions` and the workers (`packages/host/src/runs.ts:499-503`); only its budget comes from the registry. The catalog and the panel list the registry's tools for it.

#### Later the same day (2026-10-09)

After the first pass the owner gave three more instructions. His words:

1. "the default mode needs to be nultron [...] take notes and check again"
2. "the chat agents need to be able to do anything inside their chat, they dont have to create a new virtual agents to be able to generate image or videos"
3. "not just default agents, all virtual agents able to do everything, its a chat mode now, with model picker and enhance mode, can generate images, videos and all kind of docs, or even build somethings"

What each changed:

- **Instruction 1: the default agent is the brand's character.** `resolvedAssistantName()` reads `AGENTFORGE_ASSISTANT_NAME` and falls back to the product's name (`packages/core/src/gateway.ts:35-37`). The ping carries it as `assistantName` (`packages/host/src/handlers/misc.ts:108`), the Soul names it (`packages/host/src/knowledge-soul.ts:52-67`), and the rail, the header, the page and the greeting read it through `assistantNameOf` (`apps/web/lib/product-brand.tsx:23`). No brand's character is named in the code. **Owed:** `apps/desktop/main.cjs:84-85` does not set the variable from `brand.json`, and `webapp-deploy/.env.example` does not list it, so a packaged flavor or a hosted brand has to be wired before it shows its own character. A desk that already stored its Soul keeps the stored name for the model (`packages/host/src/knowledge.ts:143-157`).
- **Instruction 2: the default agent can do it all in its own chat.** It binds the worker `research_dossier` as well, hired or not (`withGeneralistWorkers`, `packages/host/src/virtual-agents.ts:156-169`), and its prompt gains a paragraph about workers (`GENERALIST_WORKER_PROMPT`, `packages/core/src/agents/virtual-agents.ts:87-94`). Pictures, clips and decks were already Chat's own tools. This answers part of the missing B1 handoff, since nothing has to be handed over.
- **Instruction 3: every agent is a full chat.** Each mode agent binds the same tools and budget, takes text, picture and video, and gets the desk's Knowledge Base and its own earlier chats like Chat (`packages/host/src/runs.ts:182-189`, `:216-220`). A `studio` agent no longer has a separate pane: its empty conversation says its checked run lives in the studio and offers a button (`apps/web/components/agent-home.tsx`). "All kind of docs" means what the chat tools make: a deck (`build_deck`), text files (`write_file`), code run in the sandbox (`run_code`), pictures and clips. There is no Word, Excel or PDF writer tool in chat. The model picker is the tier chip in the header; Enhance is a row under `+`.

Also from that pass, found by driving and fixed in the working tree:

- The desk's Soul block made the Images agent answer with the default agent's name, so a mode agent now has a closing line after the Soul block (`packages/core/src/agents/virtual-agents.ts:219-222`, `runs.ts:212`). The line is an instruction to the model, not an enforced rule.
- The model runtime's own stream watchdog read a running worker as a dead stream and ended the default agent's dossier at 60 s. A run of the default agent or a mode agent now raises that watchdog's idle budget to 10 minutes, and the worker's heartbeat stops at 8 minutes (`packages/host/src/workers/worker-channel.ts:35`, `:46`; `runs.ts:520-522`). This is a behaviour change on every turn of those agents, in a protected shared file.

Risks the new model opens, none ruled on yet:

- A mode agent now reads private material (Knowledge Base, earlier chats) and can send text to the web through `web_search` or `research_dossier`. The egress guard refuses only `web_fetch`, and only after a tool-read of private material (`packages/core/src/runtime/egress-guard.ts:150-169`). This is risk 5 in section 7, still without a ruling from C0. Chat has had the same exposure; mode agents are new to it.
- Plan risk 4 (paid steps the model starts) is half answered: a turn may make at most 4 pictures and 1 clip (`PAID_MEDIA_PER_TURN`, `packages/core/src/agents/virtual-agents.ts:107-110`). The D4 cost card with a Run control is not built, and every agent's prompt now tells it to make media.
- The renderer's cap on a turn (the `touchOutput` finding above) stops a long dossier before the host's 8 minute ceiling.
- The Research harness's keyless search returned unrelated or thin sources in two of three drives (RECORD rows 5 and 20). That is a finding for `main`.

"Hark" was named as a look reference, but no screenshot or link for it is on file. The look follows the two 2026-10-06 references in `nultron-files/chat-first/` only.

One known problem found while reading, for `main` and not fixed here: the renderer's stream watchdog is fed with `touch()` only, so a chat turn is cut off on the client at the first-token budget (240 s on Daily and Reasoning, 120 s on Fastest) however much it has streamed, and a Research dossier that runs longer ends with no card. See "Known limits" in the map page.
Direction it serves: `AGENTS.md`, "Product direction (Rizky, 2026-10-06; this repo Nultron only since 2026-10-15): chat-first".
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
8. **Same on Nultron and under white-label brands.** A white-label brand carries the same shell under its own name.

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

Hiring a bot is not built in Nultron. Custom-agent Build stays parked (`AGENTS.md`).

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
| B5 | Hire your own bot: the setup questions fill a harness spec, the host enforces it, and the bot joins the rail. Plan ceilings apply. Not built in Nultron: the tester's prompt-made agents were removed on 2026-10-16. | A person hires a bot that reads a folder of invoices and writes a weekly summary; a tool outside its spec is refused by the host, not by the prompt. |
| B6 | Free and paid: the host reads the plan and refuses a computer start on a free desk; the choice is greyed with the reason. | A free desk gets `403` with a reason code on a computer start through the API, not only a greyed button. |

The first-desk hard rule still decides what a fresh desk shows. Since 2026-10-21 (Rizky: "all people will start with one agents, which is nultron") that is the generalist alone, on local and hosted desks; the other agents are hired. Bots replace rail entries one for one.

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

**Order changed on 2026-10-09 at the owner's word:** track B (virtual agents) was pulled ahead of track C. Research is the first agent wired to a conversation, which is the C0 proof. The plan expects the other agents to follow as their workers are wired in C1 to C3. See the update block at the top.

All of this is built in the tester code, `C:\Users\rizky\agentforge-chat` on `tester/chat-first`. The published code on `main` does not change until Rizky approves a phase for promotion. See `TESTER.md`.
