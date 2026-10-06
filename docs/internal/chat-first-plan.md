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

Three tracks. Track M (models) is small and independent, so it ships first. Track K (the orchestrator and its computer) makes the chat agent a generalist that can build things. Track C (chat workers) moves the modes behind the chat.

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
