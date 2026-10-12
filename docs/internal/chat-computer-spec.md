# Chat computer and safety spec (2026-10-06)

Status: draft. Nothing here is built. This file belongs to the tester code (`TESTER.md`).
Plan: [`chat-first-plan.md`](chat-first-plan.md). Related: [`chat-workers-spec.md`](chat-workers-spec.md), [`model-tiers-spec.md`](model-tiers-spec.md).

Rizky's goal, 2026-10-06: the default chat agent is the orchestrator and the generalist. It can be asked anything and can build anything. This spec says what that agent needs to work freely, where it works, how the person sees the work, and what keeps it safe.

## 1. Where the ideas come from

We read two open-source projects for ideas and wrote none of their code into ours.

- OpenMausBot (Apache 2.0, `enterprise/` not opened). It gives each bot one computer, shows that computer in a side panel, and puts approval, question and routine cards in the thread.
- Hermes Agent (MIT). It runs one generalist loop over a small tool set, with pluggable places to run commands and a written safety position.

What we take from them:

1. Isolation is the only real safety boundary. Approval prompts, scanners and redaction prevent accidents. They do not contain an attacker. Hermes says this in its `SECURITY.md`, and it matches our own register (SR-111).
2. The agent's brain never runs inside the computer. The computer is a place that tools act on.
3. One computer serves many threads, and one turn at a time uses it.
4. Anything that reaches outside the sandbox asks a person first. The request fails closed when nobody answers.
5. A small core tool set. Every tool schema is sent on every model call, so each added tool costs speed and accuracy, most of all on Fastest-tier models.
6. The assistant acts on its own only from an explicit trigger the person confirmed. There is no hidden background loop.

What we do differently:

- Both projects run a vendor's command-line agent as the brain. Ours is the host's own runtime (`packages/core/src/runtime/ai-sdk-runtime.ts`) on the model tiers.
- OpenMausBot's default is a side panel. Rizky's reference is a bare thread, so our computer is a card in the thread that opens to a full view.
- Hermes skips command checks inside a container. We keep a hard refusal list everywhere.

## 2. What exists today, and the gaps

Verified by a read of `main` at `6105c5c`.

What exists:

- A code sandbox, `run_code`. Python and JavaScript in WebAssembly, in a child process, 30 seconds a run, no packages beyond numpy and pandas (`packages/host/src/code-runner/`). It is off on hosted because nothing at the operating-system level blocks its network access (SR-111, open).
- Desk files with versions, 2 MB a file, 2000 files a desk, and six file tools.
- A real folder on Personal. Reads are free. A write or delete becomes a proposal the person approves in a panel above the composer.
- A guard on every tool call, in this order: budget, egress guard, disabled list, injection scan of the arguments, the call, output trimming, injection scan of the output (`packages/core/src/runtime/invoke-guarded.ts:24`).
- Three trust levels for tools: `internal`, `network`, `user_content`.
- A budget for chat: 12 steps and 40 tool calls.

Gaps, each of which blocks a free-working generalist:

| # | Gap | Evidence |
|---|---|---|
| G1 | No general way to ask the person before a tool call. Only folder writes have it, and that mechanism was built outside the stream because the stall guard would end a waiting run. | No approval event in the runtime types |
| G2 | No sub-agents. One run cannot start another. | Not found in `packages` |
| G3 | A chat run is tied to its request. Closing the tab ends the work. | `packages/host/src/runs.ts:224-234` |
| G4 | No scheduler. | Not found |
| G5 | No shell, no package installs, no long processes. `run_code` forgets everything between runs. | `code-runner/limits.ts` |
| G6 | A run that spends its 12 steps on tools ends with no answer and no notice. | `ai-sdk-runtime.ts:684` |
| G7 | Tool inputs and outputs are not redacted for secrets. | No `redactSecrets` call on the tool path |
| G8 | No memory beyond the Knowledge Base and past-session search. | |
| G9 | No plan the person can see while a long task runs. | |
| G10 | No time or cost ceiling on a whole chat run. | Only first-token and idle timers |

Phase K0 closes G1, G6, G7, G9 and G10 before anything new is added. That is the "perfect what we already built" part of the work.

## 3. Places the agent works

A place is where a tool call takes effect. The person never has to pick one. The agent uses the safest place that can do the job.

| Place | What it is | Exists | Reaches |
|---|---|---|---|
| Desk | Desk files and the WebAssembly sandbox | Yes | Nothing outside the desk |
| My folder | One real folder on a Personal machine | Yes | That folder, each write approved |
| Computer | A Linux container the agent can use like a machine: a shell, installed packages, long-running processes, a workspace folder | No | Its own workspace, and the network through an allowlist |
| Browser | A browser the agent drives | No, last phase | The open web |

### The computer

One computer for each desk. Every thread on the desk shares it, and one turn at a time holds it. A second turn that needs it waits and says so in its thread.

**Decided by Rizky, 2026-10-06.** The computer runs on the cloud machine, on Tencent Cloud, the same hosting as the sites and the app. The agent never runs commands on the person's own machine. This replaces the earlier draft, which put a local container on Personal first.

What follows from that:

- **One kind of computer.** A container on a Tencent Ubuntu server, one for each desk, started when a turn first needs it and put to sleep when idle.
- **Its own server.** The current Lighthouse box has 2 vCPU and 7.5 GB and already serves three sites and eleven desks. Computers go on a second Tencent server so a busy container cannot slow the sites. The app reaches that server over a private address, never a public port.
- **SR-111 comes first.** A hosted computer is hosted code execution. It does not ship until the network block at the operating-system level exists and is tested.
- **Personal needs an identity.** A Personal user with only a pasted gateway key has no account to attach a cloud computer to. Until that is decided, the computer is available on hosted desks, which is where the testers are. Personal keeps the Desk and My folder.
- **Sleep and limits.** A container sleeps after 15 idle minutes and wakes in a few seconds. The server runs a fixed number at once. When all are busy, a turn waits in line and says so.

Kept as a later option, not built now: a person attaching their own rented server over SSH. The tools would be the same.

Container rules:

- Every Linux capability dropped, no new privileges, limits on processes, memory, CPU and disk.
- No published ports. The host refuses to use a container that publishes one.
- One mounted folder, the workspace. Nothing else from the host is visible. The Docker socket is never mounted.
- No secrets in its environment. The gateway key never enters it.
- Network through an allowlist: package registries and the hosts the person named in the thread. An owner can open it wider for one desk in Settings. The default stays narrow.
- The workspace survives a restart. Everything else in the container is disposable.

Desk files and the computer's workspace are separate. The agent copies a desk file into the workspace on purpose, and delivers a result back with a tool. Nothing syncs on its own, so a mistake in the computer cannot damage the desk.

## 4. How the person sees it

The thread stays as plain as the reference screenshot.

- **While the agent uses the computer:** one line in the turn, such as "Installing packages" or "Running the tests". No terminal in the thread.
- **A computer card** when the turn ends: what ran, how many files changed, one button.
- **The button** opens the computer view over the chat, with Back to return. Three tabs:
  - Activity: each command, its result and its time, newest first.
  - Files: what changed in the workspace this turn, each file openable.
  - Status: running, sleeping, starting, unreachable, with one action that fits the state.
- **A plan card** for long tasks: the agent's steps as a checklist that ticks as it works. It is the same card for every long task, with or without a computer.

Status states, each with one sentence of copy in both languages and one action: no computer set up, starting, ready, busy in another thread, waiting for you, sleeping, unreachable, unsafe (a published port or a changed image), stopped.

The first build has a shell and files, with no screen. Shell and files cover building software, data work and documents.

### Graphical work on a server with no screen

A Tencent Ubuntu server has no monitor, no desktop and no graphics card. A program that needs a window fails to start there. Three ways around it, cheapest first. They are built in this order, and each is added only when a real task needs it.

1. **A browser without a window.** Most "graphical" tasks are web tasks: open a site, fill a form, check that a page the agent built looks right. A headless browser does this with no desktop at all. The agent reads the page as a tree of elements and acts on them, and the person sees screenshots in the Activity tab. It adds about 300 MB of memory for each active computer. This is the K4 browser phase and covers most needs.
2. **A virtual screen inside the container.** For a program that insists on a window, the container runs a virtual display in memory (Xvfb) with a small window manager. The program draws to it as if a monitor were attached. The agent takes screenshots and sends clicks and keys. The person watches through a view streamed over the app's own connection, with no extra port. It needs no graphics card, because drawing is done by the processor. It adds about 1 GB of memory for each active computer and is slow for video or 3D.
3. **A full desktop image.** The same virtual screen with a complete desktop and office programs installed. Heavy: about 2 GB each, and a much larger image to keep patched. Only worth building if testers ask for tasks the first two cannot do.

What stays hard on any of the three:

- Anything that needs a graphics card, such as 3D or video editing. The existing media workers already do that work through the gateway, so the computer does not need to.
- Sites that block automated browsers or show a CAPTCHA. The agent stops and asks the person. It never tries to get past one.
- Signing in to the person's accounts. That needs the credential card from layer 5, and for some sites the person taking control of the screen for a moment.

Safety is stricter with a screen. A page the agent looks at can show text written to steer it, so everything read off a screen is untrusted data, and any action with a consequence outside the container still asks first.

## 5. Tools

### The core set

The orchestrator's tool list, grouped. "New" means it does not exist today.

| Group | Tools | State |
|---|---|---|
| Think | `calculator`, `datetime` | Exists |
| Plan | `plan` (write and tick a checklist), `ask_user` (a question with choices) | New |
| Web | `web_search`, `web_fetch` | Exists |
| Recall | `knowledge_search`, `past_sessions`, `memory` | First two exist, `memory` is new |
| Files | `list_files`, `read_file`, `write_file`, `edit_file`, `search_files`, `delete_file`, each with `root: desk, folder or computer` | Exists for desk and folder |
| Code | `run_code` in the sandbox | Exists |
| Computer | `shell` (one command, with a time limit), `process` (start, check or stop a long-running command), `deliver_file` (copy a workspace file to the desk and show it in the thread) | New |
| Workers | `run_worker`, `read_result` | New |
| Team | `delegate` | New |

That is 21 tools. The limit for the core set is 24. A capability beyond that comes in as a skill or a worker, not as another tool.

**One worker tool, not thirteen.** The workers spec lists thirteen workers. Thirteen schemas on every call would crowd the list, so the agent gets one tool, `run_worker({ worker, prompt, files?, options? })`. The system prompt carries a one-line index of the workers, and the host validates `options` for the named worker. This changes section 2 of the workers spec; the contract in its section 1 is unchanged.

### On by default, and gated

- **Free:** Think, Plan, Recall, Web within its limits, Files on the desk, Code, and everything inside the computer.
- **Asks first:** a write or delete in My folder, a paid media worker, opening the computer's network beyond the allowlist, `deliver_file` over an existing desk file, installing a skill, anything a connector sends on the person's behalf.
- **Never:** reading credential files, mounting a folder on the refusal list (`packages/host/src/folder-root/mount-validate.ts`, `denied-names.ts`), the Docker socket, changing the agent's own rules or budget, starting a scheduled task without the person's confirmation.

The Never list is checked in code before approvals. No setting, approval or "always allow" overrides it.

## 6. The safety design

Seven layers. The first is the boundary. The rest prevent accidents and limit damage.

### Layer 1: isolation

Free work happens only in the sandbox or the container. This is why SR-111 comes first: until the sandbox child has an operating-system network block, `run_code` stays off on hosted, and the hosted computer does not ship.

### Layer 2: approval

A general form of the folder proposal that already works.

- A tool that needs approval does not run and does not wait. It records a proposal and returns `pending_approval`. The agent ends its turn by saying what it needs.
- The thread shows an approval card: what will happen in plain words, the exact command or change behind a disclosure, and three choices. Allow once. Allow for this thread. Deny, with an optional reason.
- On Allow, the host performs the action and starts the agent's next turn with the result. On Deny, the next turn starts with the refusal and the reason.
- A proposal expires after 24 hours and counts as denied.
- "Allow for this thread" is offered only for repeatable, low-risk kinds. It is never offered for a paid step, a network change or a delete.
- The approval records who allowed it. On Enterprise, a company can limit who may approve.

This avoids the stall-guard problem behind gap G1, because no run sits waiting on a person.

### Layer 3: budgets

- Steps and tool calls scale with the tier. Draft numbers: Fastest 12 steps, Daily 25, Reasoning 40. Per-tool caps stay.
- A wall-clock ceiling for a turn, 10 minutes by default, 30 with a computer.
- A cost ceiling for a turn, estimated from the usage ledger's prices. Reaching it stops the turn.
- A budget that runs out always produces a visible message: what was done, what was not, and a Continue control. This closes gap G6.
- Repeated identical failing calls stop after three.

### Layer 4: untrusted content

- Web pages, files, search results, worker summaries of web content and every byte of computer output are data. The existing scan runs on them, and the system prompt says so.
- Computer output has `network` trust. It may contain anything a web page or a package printed.
- The egress guard stays: after a private read, `web_fetch` goes only to hosts the person named or a search returned.
- A new rule for the computer: copying a desk file into the workspace marks the computer as holding private data, and its network then accepts only the registries on the allowlist until the workspace is cleared.
- Content from the web can never trigger an approval that looks like the person asked for it. The approval card states where the request came from.

### Layer 5: secrets

- Tool inputs and outputs pass through `redactSecrets` before they are stored or shown. This closes gap G7.
- The gateway key and provider keys never enter the sandbox, the container or a sub-agent's context.
- When a task needs a credential, the agent asks through a credential card. The value goes to the host and is injected for one command. It is never typed into the thread and never written to the workspace.

### Layer 6: record

- Each desk gets an append-only decision record: time, thread, tool, a hash of the arguments, the verdict, the rule that decided it, and who approved. Redacted before writing.
- The computer's Activity tab reads from the same record. What the person sees is what was logged.

### Layer 7: undo

- Desk files already keep every version.
- The computer's workspace gets a snapshot before each turn. "Undo this turn" restores it.
- My folder writes already re-check the file's hash before applying.

### What stays true when unattended

A scheduled or delegated run has nobody to ask. Anything that needs approval is denied in that run, and the result says what was skipped.

## 7. The orchestrator loop

1. **Understand.** Answer directly when the request is a question. Most are.
2. **Plan.** For a task with more than three steps, write the plan with `plan`. The person sees it and can correct it.
3. **Act.** Pick the safest place that can do the step. Call a worker for a deliverable. Use the computer for building.
4. **Check.** Run the thing, read the result, compare it with the request. A worker's checks are reported as they are, including failures.
5. **Report.** Say what was done, what was not, and where the result is.

Supporting parts:

- **Sub-agents.** `delegate` gives a task to a fresh run that returns a summary. A sub-agent gets the parent's tools without `delegate`, `ask_user`, `memory`, paid media and anything that needs approval. Depth is one level. At most three run at once. Their cost counts against the parent's ceiling.
- **Memory.** Two short notes for each desk: what the agent learned about the work, and what it knows about the person. Each has a size limit. A full note must be tidied before it accepts more. The notes load when a thread starts and do not change mid-thread, which keeps the system prompt stable for caching. Entries are facts, not commands. The Knowledge Base stays the home for documents.
- **Context.** A long task outgrows the context window. Old tool results are dropped first, then the middle of the thread is summarised by the Fastest tier. The first messages and the most recent ones stay whole.
- **Skills.** A skill is a short written procedure. The prompt lists skill names and one-line descriptions, and the agent loads one when it applies. An agent may propose a new skill after a hard task. A proposed skill waits for the person's approval and never activates on its own.
- **Runs that outlive the tab.** A long task keeps running on the host when the tab closes, and the thread shows the result on return. This closes gap G3 and comes before scheduling, which depends on it.

## 8. Phases

This is track K in the plan. K0 runs before the worker phases, because workers need approval and the plan card.

| Phase | Outcome | Proof |
|---|---|---|
| K0 | The gaps closed: approval cards (G1), a visible stop with Continue (G6), redaction on the tool path (G7), `plan` and `ask_user` (G9), time and cost ceilings (G10), the decision record. | Drive each on `:3200`. A test that a secret in tool output never reaches the stream. |
| K1 | The orchestrator: `delegate`, `memory`, context trimming, the skill index, runs that outlive the tab. | A 30-step task finishes on the Daily tier with the tab closed halfway. |
| K2 | SR-111 closed, then the computer on a second Tencent server: `shell`, `process`, `deliver_file`, the computer card and view, workspace snapshots, sleep and wake. Hosted desks only. | Ask the agent to build and run a small web app. The tests it wrote pass inside the container. A test proves the container cannot reach a host outside the allowlist. |
| K3 | The headless browser, with screenshots in the Activity tab. | The agent opens the web app it built in K2, finds a layout fault from a screenshot and fixes it. |
| K4 | Scheduled tasks that the person confirms, with a run card in the thread. Then the virtual screen, if a real task needs it. | A daily task runs and reports into its thread. |

## 9. Decisions for Rizky

| # | Decision | Default assumed |
|---|---|---|
| C1 | Where commands run. | **Answered 2026-10-06.** On the cloud machine only. Never on the person's own machine. |
| C2 | Where the computer is hosted. | **Answered 2026-10-06.** Tencent Cloud, the same hosting as today, on a second server. Its network stays an allowlist by default. |
| C3 | A graphical desktop. | **Answered 2026-10-06.** Wanted, and the server has no screen. Solved in three steps in section 4: headless browser, then a virtual screen, then a full desktop image only if needed. |
| C4 | Budget numbers for each tier, and the cost ceiling for a turn. | The drafts in layer 3. To be set from measured runs in K0. |
| C5 | Who pays for a hosted computer on Enterprise. | Not decided. It blocks K2. |
| C6 | Whether sub-agents use the Fastest tier to save cost. | Yes. |
| C7 | How a Personal user, who has only a pasted key, gets a cloud computer. | Not decided. Until then the computer is for hosted desks. |
| C8 | The size and monthly cost of the second Tencent server, and how many computers run at once. | Not decided. Measure one container under a real task in K2 first. |

## 10. Security register

Rows to open when each phase starts, from SR-135 onward: the approval mechanism and its expiry, the container's hardening and image pin, SSH credentials for a person's server, the network allowlist and the private-data mark, sub-agent tool limits, the decision record's contents, and runs that outlive the request. SR-111 must close before any hosted code execution, sandbox or computer.
