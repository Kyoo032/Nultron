# Chat workers spec (2026-10-06)

Status: **draft. Nothing here is built.** Plan: [`chat-first-plan.md`](chat-first-plan.md).

A **worker** is an existing mode harness exposed to the chat agent as a tool. This spec defines the contract, the data that crosses the wire, what the thread renders, and the rules each worker follows.

## 1. Contract

A worker tool is defined with `defineTool` (`packages/core/src/tools/define-tool.ts:11-47`) and registered in `ensureToolsRegistered` (`packages/host/src/register-tools.ts:20-44`). Worker files live in `packages/host/src/workers/<worker>-tool.ts`, one per worker.

```ts
type WorkerResult = {
  ok: true;
  artifact: { id: string; kind: WorkerKind; title: string };
  /** At most 1200 characters. This, not the full result, is what the model sees. */
  summary: string;
  /** Checks the harness ran and what they said, so the agent can report them honestly. */
  checks: { id: string; ok: boolean; why?: string }[];
  notices?: { code: string }[];
} | {
  ok: false;
  reason: "needs_input" | "budget" | "gateway_blocked" | "failed";
  /** For needs_input: what is missing, in the run's language. */
  ask?: { field: string; question: string; choices?: string[] };
  message?: string;
};
```

Rules:

1. **A worker calls the mode's existing entry function in process.** `research_dossier` calls `generateResearchNotes` (`packages/host/src/research-generate.ts:119`), and so on. It never reimplements a harness and never calls the host over HTTP.
2. **The harness spec still governs the inner run.** Tools, budget and repair rounds come from `ModeHarnessSpec` (`packages/core/src/harness/spec.ts:20-29`) through `toolKeysWithinSpec` (`packages/host/src/job-regen.ts:118`), exactly as when the screen starts it.
3. **The model sees a summary and an id.** The full result stays in the artifacts table. A new tool, `read_result(artifactId, section?)`, lets the agent read it when a later question needs it.
4. **Every worker result is an artifact.** Media workers write a gallery row as today and also an artifact row pointing at it, so the thread references one kind of thing.
5. **A worker never asks through a form.** Missing input returns `needs_input`; the agent asks in the thread.
6. **Locale.** The worker passes `localeForRun()` on, as the harness already does. No worker writes its own copy.
7. **Gate.** The chat run is already gated (`packages/host/src/handlers/runs.ts:30`). A worker does not check again.
8. **Trust.** A worker's output is `internal`. What it read from the web inside its own run was already scanned by the harness.

## 2. Workers

**Amended 2026-10-06 by [`chat-computer-spec.md`](chat-computer-spec.md), section 5.** The agent gets one tool, `run_worker({ worker, prompt, files?, options? })`, not thirteen. The keys in the table below become values of `worker`. Each worker still has its own file under `packages/host/src/workers/`, and the host validates `options` for the named worker. Thirteen schemas on every model call would crowd the tool list, most of all on Fastest-tier models.

| Tool key | Harness entry | Input from chat | Result kind | Regenerate one |
|---|---|---|---|---|
| `research_dossier` | `generateResearchNotes` | prompt | `research` | no route today |
| `write_document` | `generateDocumentDraft` | prompt, optional source artifact | `document` | section |
| `build_deck` | `generatePresentationOutline` | prompt, optional slide count, source artifact or files | `deck` | slide |
| `market_briefing` | `generateMarketBriefing` | prompt, tickers (asked for if absent) | `briefing` | section |
| `make_image` | `generateStudioImage` | prompt, optional aspect, optional image | `image` | no |
| `make_video` | `generateStudioVideo` | prompt, optional aspect, seconds, image | `video` | no |
| `make_music` | `generateStudioMusic` | prompt or lyrics, optional style | `music` | no |
| `analyze_data` | `analyzeDataset` | prompt, an attached table | `analysis` | no route today |
| `finance_task` | `generateFinanceBrief` / `runFinanceTask` | prompt, task (inferred, defaults to brief), an attached table | `finance` | section |
| `meeting_minutes` | `transcribeMeeting`, `runMeeting` | an attached recording or transcript | `minutes` | no route today |
| `legal_review` | `generateLegalRun` | attached .docx files; side and work type asked for | `legal` | no route today |
| `edit_media` | `runEditAgent` | prompt, attached media | `edit` | clip ops |
| `teach` | education runners | topic, optional file | `lesson` | no |

`make_image` and `make_video` replace `image_generate` and `video_generate` in `DEFAULT_CHAT_TOOLS`. The old keys stay registered for custom agents and existing bindings.

`ensureStarterBindings` (`packages/core/src/agents/service.ts:493`) backfills the new keys onto existing desks, the way `run_code` reached them.

## 3. Wire changes

All three land in phase C0, in one change, with tests.

**New message part** (`packages/core/src/content/types.ts`):

```ts
type ArtifactPart = {
  type: "artifact";
  artifactId: string;
  kind: WorkerKind;
  title: string;
  /** The tool call that produced it, so the card sits where the call was. */
  toolCallId?: string;
};
```

`ContentPart` gains `ArtifactPart`. Parsers treat an unknown part type as today: ignored on read, never a crash. Old threads are unchanged.

**New stream event** (`packages/core/src/runtime/types.ts`):

```ts
{ type: "tool.progress"; toolKey: string; toolCallId: string; job: JobEvent }
```

`job` is the existing job event (`packages/core/src/jobs/job-events.ts`). The renderer folds it with `reduceJobProgress`, the same reducer the mode screens use, so a worker's progress in chat reads the same as on its old screen.

**`readRunStream`** (`apps/web/components/chat-composer.tsx:141`) gains one branch for `tool.progress`.

## 4. What the thread renders

The look follows the reference screenshot (`nultron-files/chat-first/reference-2026-10-06.png`): plain bubbles, and a card that is a title, a kind label, one or two lines and one button.

- **While a worker runs:** one progress line in the turn that names the current phase. A Stop control aborts the worker through the run's abort signal (`throwIfJobAborted`, `packages/host/src/job-stream.ts:19`). The step-by-step detail opens from that line.
- **When it finishes:** a result card (`apps/web/components/chat-results/result-card.tsx`, one component for every kind). Title, kind, a two-line preview, one button. Media cards show the image, the player or the audio control in place of the preview. A failed check shows as one line on the card, never hidden.
- **The button:** opens the full result over the chat, holding the mode's existing result component. It is a view inside `/chat`, not a route to the parked screen. Back returns to the thread at the same scroll position. There is no split view at any width.
- **Follow-ups in the thread act on the result.** "Make slide 3 shorter" reaches `build_deck` with the artifact id and the instruction. This is the first way to change a result and it works from phase C1.
- **In the opened result (phase C3):** the worker's edit rules. Inline text edits; Regenerate on one section, slide or item where the host has a route; Export where the host has one (`/docx`, `/pptx`, `/export`).
- **A regeneration keeps the person's edits.** The view sends the edited result with the regenerate request, as the screens do now.

Reuse rule: the full-result view imports the result component from the parked studio. If a studio's result and setup are one component, the lane that owns that worker splits the file first, with no behaviour change, and that split is its own commit.

## 5. Choosing a worker

Two doors, both always present.

1. **The agent decides.** Each tool description states plainly when to use it and when not to. The chat system prompt gets one short paragraph: prefer answering directly; call a worker when the person asks for a deliverable.
2. **The person decides.** The composer's `+` menu (and `/` typed at the start of a line) lists the workers, beside Attach and the model tier. Choosing one sends the turn with `worker: "<key>"`; the host forces that tool call for the first step. The menu shows worker names in the person's language, never tool keys. The composer itself shows nothing about workers.

An eval set of at least 40 requests with the expected worker (or "none") runs against every model on the tier lists, under `packages/host/eval/`. A model that picks the wrong worker in more than 1 of 10 cases does not go on the Fastest list.

## 6. Files as setup

- An attachment is saved as a desk file, as today. The chat agent sees its name, type and size.
- A worker that needs structured state builds it from the attachment: `analyze_data` and `finance_task` create a dataset through the import path (`POST /api/v1/finance/import` limits apply: 25 MB, 30 sheets, 5000 rows); `legal_review` creates a matter; `meeting_minutes` creates a meeting.
- What was created is kept and named after the thread, so the Knowledge and Workspaces pages still show it.
- What cannot be inferred is asked once, in the thread, with choices where the set is closed (legal side, work type).

## 7. Budget and paid steps

- Chat's budget (`packages/core/src/harness/modes/chat.ts`) gains per-tool caps for workers: 2 calls per turn for text workers, 1 for `make_video` and `make_music`, 4 for `make_image`. Workers count toward `maxToolCalls`.
- A worker call has its own time ceiling, set per worker, and its progress events reset the chat watchdog.
- `make_video` and `make_music` return a **cost card** first: the estimate the Videos and Images screens already compute, and a Run control. The model cannot press Run. (Decision D4 in the plan.)
- A refused call returns `{ok: false, reason: "budget"}`, as `createToolBudget` does today (`packages/core/src/runtime/tool-budget.ts:33`).

## 8. Open questions for C0

1. **Egress after a private read.** A thread that read a desk file trips the egress guard on `web_fetch`. Does `research_dossier`, which searches the web inside its own run, count as egress from that thread? Proposed: the worker receives only the prompt, never the thread's private reads, so it may run; the summary it returns is treated as untrusted web content.
2. **Custom agents.** They get 6 steps and no call cap (`packages/host/src/runs.ts:346`). Proposed: workers are bound to the default chat agent only.
3. **Thread to artifact link.** Nothing links a job to a message today. `ArtifactPart` is that link; the artifact row also gains `threadId` and `messageId` so deleting a thread can offer to delete its results.

## 9. Tests each worker ships with

- Unit: the tool maps chat input to the harness input, including `needs_input`.
- Host: a stub-runtime run through the real router that ends with an `artifact` part and an artifact row.
- Renderer: the card and the full-result view render from a fixture; `en` and `id` catalogs have identical keys.
- Parity: the same test on Personal and in server mode.
- Recipe: a section in `features/chat-workers.md`, driven on `:3200`.
