# Finance in chat: the `finance_task` worker (design, 2026-10-20)

Status: **built on `tester/chat-first`, not driven.** Tester only. Lanes: tester. The sections below are the design as reviewed. "As built" lists every place the build differs, and only some of those are also corrected in the sections below. How it works now is [`maps/finance-chat-worker.md`](maps/finance-chat-worker.md).

Specs it follows: [`chat-workers-spec.md`](chat-workers-spec.md) § 1 (contract), § 2 (the `finance_task` row), § 6 (files as setup); [`chat-first-plan.md`](chat-first-plan.md) Track C, phase C2. Where the built Research worker differs from those specs, this design follows the build (plan, "Where the build differs from the specs").

## As built (2026-10-20)

Four commits on `tester/chat-first`, in order:

| Commit | What it holds |
|---|---|
| `ec41fd07` | No behaviour change. The Finance readers are exported, and `joinSheetTexts` and `splitUserFileBlocks` move to core |
| `fa0baa0d` | The figures file at attach and send, its note, auto's `no_opening_cash` warning and its optional `task` |
| `e2993489` | The card and the open view in Chat |
| `0fdf2bb1` | The `finance_task` worker, its wiring and the budget pin |

Nothing was driven on `:3200`. This doc was checked against the code at `0fdf2bb1` by reading it. Where the build differs from the design below:

- **The file is `<name>.figures.json`, not `.figures.txt`.** It is a JSON object with the figures text, the prose text and the sheet names. The worker accepts only a path in the person's own folder with three segments that ends in `.figures.json` (`ownFolderPath`, `packages/host/src/workers/finance-task-tool.ts`).
- **The note reads** `[Figures kept: <path>. To answer a question about these figures, call finance_task with this path as file.]` (`packages/host/src/chat-documents/notes.ts:75`). Its prefix is in `HOST_NOTE_PREFIXES` (`packages/core/src/chat-documents/markers.ts:17`) and `MODEL_ONLY_NOTE_PREFIXES` (`apps/web/lib/message-embeds.ts:110`).
- **The figures read waits behind `documentLimiter`** at attach (`packages/host/src/chat-documents/handler.ts:62-66`). Any failure there becomes "figures not read" and the attachment still works. It reads the raw extract, `extractedTables` and `extractedMarkdown`, never the chat-masked text.
- **The formats are xlsx (a `.xls` or `.xlsm` is read as xlsx, `packages/core/src/chat-documents/formats.ts:44-46`), docx, pdf and pptx** (`packages/host/src/finance-figures/figures.ts:28-30`).
- **The author check needed no new store read.** `listVersions` and `readVersion` already existed (`packages/host/src/desk-files/file-store.ts:387`, `:407`). The worker reads the newest version's author with them (`finance-task-tool.ts:120`, `:124`).
- **Only the generate step is inside `runWithWorkerProgress`** (`finance-task-tool.ts:216`). The file read and auto run before it and send no progress.
- **One more ask.** A discount rate that auto found only in the model-written `request`, and not in the figures, the prose or the person's typed text, is asked for (`rateUntrusted`, `finance-task-tool.ts:135-146`).
- **An applied answer drops its own warning.** `withAnswer` (`finance-task-tool.ts:148`) writes the answer into the task input, and the warning it settles (`warningSettledBy`, `packages/host/src/workers/finance-task-asks.ts:151`) leaves the card's notes.
- **Decision 2 is (b).** The output gains `facts`: a "Key figures" table of every KPI, then the report tables with the inputs last, whole rows only, up to 3,000 characters (`factsOf`, `packages/host/src/workers/finance-task-facts.ts:82`). (d) is still open.
- **The card has Download Excel and Word next to Open,** not only inside the open view.
- **The harness panel shows no Open studio button for the Finance agent now.** The panel draws it only for an agent whose conversation is `studio` (`ownRunsHere`, `apps/web/components/agent-harness-panel.tsx:39`, `:120`). § 1's claim that the studio stays reachable from that button no longer holds. `/finance` itself is unchanged. Whether another way in from the agent's conversation remains was not checked.

## 1. What the person gets

The person attaches a spreadsheet in any agent's chat and asks a question about it. For example: "how healthy is this company?", "which budget lines went over?", "how long will our cash last?" or "is this project worth it at 12%?".

The agent runs the Finance harness, the same task engine the studio uses:

1. **While it runs.** A progress line names the phase.
2. **Result card.** When the run ends, a card appears under the answer. It shows "Finance · Ratios" (or the task that ran), the title, up to four headline figures, and one check line if something was assumed or left out. It has one button, Open.
3. **Open.** This draws the studio's own result screen (tiles, tables, charts and the write-up) inside the thread, with Download xlsx and Download docx.

The agent asks at most one question per run, and only for a value that changes every number.

**What does not change.** There is no new mode, rail entry, task or host route. The Finance agent's conversation changes from `studio` to `harness`. The studio stays reachable from the harness panel's Open studio button (`apps/web/components/agent-harness-panel.tsx:121-126`).

## 2. Where the figures come from

**The problem on the hosted app:**

- **No original bytes.** Chat keeps none when hosted (`packages/host/src/chat-documents/original.ts:35`, SR-185).
- **The desk copy is chat-masked Markdown.** It is written by `saveDeskCopy` after `maskPii` (`packages/host/src/chat-documents/save-handler.ts:101-103`). The chat mask has phone and card detectors (`packages/core/src/security/pii.ts:180-212`). Finance has a recorded case of an amount misread as a phone number (`packages/host/src/finance-privacy.ts:88-90`). Figures read back from that copy cannot be trusted.
- **Finance needs its own figures text.** It reads bytes with its import reader (`readWorkbook`, `readDocument`, `packages/host/src/handlers/finance-import.ts:231`, `:210`). It redacts the Finance way, which puts amounts back (`guardFinanceInput`, `finance-privacy.ts:165`).

**Design: a figures file next to the desk copy.** It is computed at attach, sent back by the composer and checked again by the host at send. This is how the text already travels.

- **Attach** (`POST /api/v1/chat/documents`).
  - For a file the Finance reader takes (xlsx, xls, docx, pdf, pptx), the handler also calls a new host function, `readFinanceFigures(file)`.
  - For docx, pdf and pptx it reuses the tables the chat read already extracted, instead of converting the file a second time. The hosted app allows only 2 native conversions at once (`packages/host/src/file-extract/native-gate.ts:40`).
  - It keeps a figures file only when the reader found at least one numeric table and some task scores at least 0.2 in `scoreFinanceTaskFit` (`packages/core/src/finance/task-fit.ts:375-381`; the bar is auto's own, `packages/host/src/finance-tasks/auto.ts:62`). That check is pure code and cheap. A contract or a letter gets no figures file and no note that would nudge the model toward `finance_task`.
  - That function is the studio's multi-sheet read moved to the host:
    - it reads every sheet, in order;
    - each sheet keeps its `Sheet:` line;
    - whole sheets are left out once the text reaches 12,000 characters, and each one left out is named;
    - nothing is ever cut in half.
  - It is the logic in `readFinanceFileForAuto` (`apps/web/lib/finance-auto-io.ts:55-90`) and `joinSheetTexts` (`apps/web/lib/finance-auto-client.ts:295`). A balance sheet and a P&L, or a budget sheet and an actuals sheet, therefore arrive together, which ratios and budget need.
  - The answer gains `figures: { figuresText, proseText, sheetNames, skipped } | null` and `figuresSkipped`.
  - A figures failure never fails the attachment, the same rule as `originalSkipped` (`chat-documents.md` § 2a).
- **Send** (`POST /api/v1/chat/documents/save`).
  - The composer sends `figures` back, as it sends `text`.
  - The save handler checks it again: `guardFinanceInput`, the injection scan the import route runs (`finance-import.ts:133-137`) and the 12,000-character cap. It already re-cleans and re-masks the text it is sent (`save-handler.ts:101`).
  - It writes `uploads/~<person>/<name>.figures.json` beside the `.md` copy, through the same desk root, and only when the `.md` copy saved. The folder is the person's own (`canSeePath`, `packages/host/src/desk-files/private-uploads.ts:44`).
  - The notes gain one host line: `[Figures kept: <path>. To answer a question about these figures, call finance_task with this path as file.]` (`packages/host/src/chat-documents/notes.ts:75`). Its prefix joins `HOST_NOTE_PREFIXES` (`packages/core/src/chat-documents/markers.ts:17`) and `MODEL_ONLY_NOTE_PREFIXES` (`apps/web/lib/message-embeds.ts:110`), so a forged line is indented and the file card hides it.
- **Rejected: keep the workbook privately.** Desk files are text with a 2 MB limit, and an artifact is desk-visible (§ 8). That reopens SR-185.
- **Rejected: read the chat desk copy.** The chat mask may have changed amounts.
- **CSV is not covered in v1.** Chat sends a CSV as inline text only and makes no desk copy (`packages/core/src/chat-documents/formats.ts:9`, `:51-54`). CSV joins once the composer saves CSV through the same route.
- **An option, not in v1.** The worker will already have the turn's typed text and a host-side file-block split (§ 3, step 3). With those, the host could also take a pasted table or an inline CSV block straight from the person's own message, never from the model. That would cover CSV and pasting at little extra cost.

## 3. The tool

- **Where it lives.** Key `finance_task`, file `packages/host/src/workers/finance-task-tool.ts`, built with `defineTool` (`packages/core/src/tools/define-tool.ts:23-45`). It is registered beside `research_dossier` (`packages/host/src/register-tools.ts:43`).
- **Trust.** `user_content`, because it reads the person's own figures. The thread is then tainted for the egress guard (`packages/core/src/runtime/egress-guard.ts:161`). Research is `network` (`packages/host/src/workers/research-dossier-tool.ts:107`).

**Input** (zod, trimmed and bounded):

| Field | Rule |
|---|---|
| `request` | The person's question, 8 to 2000 characters. |
| `file` | The figures file's desk path, as the host note gives it. |
| `task` | `brief`, `ratios`, `budget`, `cashflow` or `appraisal`. Only when the person named one. |
| `answers` | `{ discountRatePercent?, openingCash? }`. Only values the person typed. |

**Steps.** As built, only step 4 runs inside `runWithWorkerProgress("finance_task", (emit, signal) => …)` (`packages/host/src/workers/worker-channel.ts:55`, called at `finance-task-tool.ts:216`). Steps 1 to 3 run before it and send no progress.

1. **Read the figures file, and check who wrote it.**
   - The path must match `uploads/~<this person>/*.figures.json`.
   - The newest version must have been written by the person, not by a tool. Every model-invoked tool writes to the desk as `agent` (`currentAgentAuthor`, `packages/host/src/file-roots.ts:9-16`). The save handler writes as `user` (`packages/host/src/chat-documents/desk-copy.ts:42`). The store records which (`author_kind`, `packages/host/src/desk-files/file-store.ts:99-102`, `:262-264`).
   - So a figures file the model wrote or edited with `write_file` or `edit_file`, whether on its own or steered by an injected document, is refused. The model cannot slip its own numbers in as the person's.
   - As built, the store read already existed: `listVersions` and `readVersion` (`packages/host/src/desk-files/file-store.ts:387`, `:407`). The test is in § 10.
   - Read with `createDeskRoot(tenant, { kind: "user", userId }).read(path)` (`packages/host/src/desk-files/store.ts:27`). If the file is missing or fails the check, return `needs_input` asking the person to attach the file again.
2. **Pick the task without the model.** Call `runFinanceAuto(tenant, { figuresText, proseText, sheetNames, prompt: request, locale, task? })` (`packages/host/src/finance-tasks/auto.ts:463`). It scores the five tasks, reads with code only, computes, and returns `fits`, `task`, `input`, a preview and `warnings`. No model, no cost, and it writes nothing.
   - **Auto gains an optional `task`.** Today auto returns the input for the first task it can read (`auto.ts:436-453`), so its `input` belongs to its own pick. Running a different task on that input would fail that task's schema. With `task` set, auto tries only that task's reader and returns that task's input, or says it cannot read the figures for that task.
3. **Decide in code what is missing.**
   - **Task.**
     - The person named a task, by asking or by picking a choice: auto runs with that `task`.
     - Otherwise, auto's own pick when `fits.confidence` is `high`. High means the top score reaches the bar and leads the runner-up by a set margin (`packages/core/src/finance/task-fit.ts:85-93`). It is reported only when auto could also read the figures for that task (`auto.ts:525`).
     - Otherwise, return `needs_input` with up to three ranked tasks as choices, in the person's language.
     - A task name is a closed choice, not a figure, so the model may pass it on.
     - How often confidence comes back `low` on real files is measured on the drive. If it is low on most files, the bar moves before release, not the ask.
   - **Discount rate.** Appraisal with auto's `default_discount_rate` warning (`auto.ts:365`) and no answer returns `needs_input`. As built, so does a rate auto found only in the model-written `request` (`rateUntrusted`, `finance-task-tool.ts:135-146`).
   - **An applied answer.** As built, `withAnswer` (`finance-task-tool.ts:148`) writes it into the task input and drops the warning it settles (`warningSettledBy`, `packages/host/src/workers/finance-task-asks.ts:151`).
   - **Opening cash.** Cash flow with no opening row and no answer returns `needs_input`. Today a missing opening row is a silent 0 (`packages/core/src/finance/cashflow/fold.ts:123`, `compute.ts:142-143`). Auto gains a warning, `no_opening_cash`.
   - **Everything else runs.** Unplaced rows, unpaired budget lines, low-confidence cash-flow rows and skipped sheets each become a note on the card (§ 6).
   - **Answer numbers.** A number in `answers` is accepted only if it appears in the person's own typed text this turn, with file blocks stripped. Otherwise the worker asks again. The model passes on a value the person stated; it never supplies one. This needs two pieces of plumbing:
     - the worker channel carries the turn's user text (`packages/host/src/runs.ts:481-492`);
     - the file-block split moves from `apps/web/lib/message-embeds.ts:143` (`splitUserFileBlocks`) into core, so the host can strip the inlined file.
4. **Run the task.** Call `generateFinanceBrief(tenant, { ...auto.input, task, prompt: request, locale }, emit, signal)` (`packages/host/src/finance-generate.ts:173`). The studio's guard, repair round, artifact save (`packages/host/src/finance-tasks/persist.ts:73-93`) and Knowledge Base card (`finance-tasks/runner.ts:369-381`) all run unchanged.
   - The gate and the run slot come from the chat run (`packages/host/src/handlers/runs.ts:47`, `:50`).
   - The worker does not call `streamJob`, which would take a second slot (`packages/host/src/job-stream.ts:43`).
5. **Return.** The model and the card read the same saved `tool_call` output (`runs.ts:600-619`). There is no new message part.

```ts
type FinanceTaskOutput =
  | {
      ok: true;
      artifact: { id: string | null; kind: "finance"; title: string };
      task: "brief" | "ratios" | "budget" | "cashflow" | "appraisal";
      /** Up to four, formatted by code from report.summary. */
      headline: { label: string; value: string; unit?: string }[];
      /** The guarded write-up's opening, cut to 1200 characters. It already passed the number guard. */
      summary: string;
      /** As built, decision 2b. Every KPI, then the report tables, whole rows, up to 3000 characters. */
      facts: string;
      checks: { passed: boolean; flagged: number; removed: number };
      notes: { code: string; message: string }[];
    }
  | { ok: false; reason: "needs_input"; ask: { field: string; question: string; choices?: string[] } }
  | { ok: false; reason: "failed" | "cancelled"; code: string; message: string };
```

`checks` follows the built Research shape, not the spec's (`research-dossier-tool.ts:21-34`).

## 4. Agent wiring

- **`CHAT_WORKERS` entry** (`packages/core/src/agents/virtual-agents.ts:81-85`, as built).
  - `perTurn: 2`, so one turn can cover two attached files, such as this year's budget and last year's. A `needs_input` returns before anything runs, and the rerun after the person answers happens in their next turn.
  - The sentence, as built (`:84`), says:
    - use it when a host note `[Figures kept: ...]` names a file and the owner asks about those figures, passing their question as `request` and that path as `file`;
    - when it asks for something, put the question to the owner and do not answer it;
    - never work out a figure yourself;
    - say what the card shows and any check that failed;
    - do not restate figures beyond the headline and the facts it returned.
- **`SPECIALTIES.finance.worker = "finance_task"`** (`virtual-agents.ts:158-162`, as built). This changes the Finance agent to `harness` (`:254`) and drops the studio note (`:215`). Its brief (`:161`) sends attached figures to `finance_task` and keeps `calculator` or `run_code` for a quick sum on numbers typed in the chat.
- **Bound to every agent and the default agent**, as Research is (`virtual-agents.ts:229`; `packages/host/src/virtual-agents.ts:161-170`).
- **Budget.** The per-tool cap is pinned in `packages/host/src/runs-budget.test.ts:122`, which gains `finance_task`.
- **Tool count.** Chat's 17 plus two workers is 19, under the core set's limit of 24 (`chat-computer-spec.md` § 5).

## 5. The card and the open view

- **Where it mounts.** `FinanceCards`, in `apps/web/components/chat-finance-card.tsx`, sits beside `DossierCards` (`apps/web/components/chat-turn.tsx:196-197`). It reads a new `readFinanceResult`, modelled on `apps/web/components/tool-rows/dossier-result.ts:47-71`.
- **The card.**
  - The line "Finance · <task>", the title and up to four headline figures.
  - One danger-tone line when `checks.flagged > 0` or there are notes.
  - Open.
- **Open.**
  - It loads the artifact and builds a `FinanceResult` from `meta.report`. Brief stores brief JSON instead. For brief, Open reads it with `readStoredFinanceBrief` (`packages/host/src/finance-artifact.ts:56`) and builds the report with `financeReportFromBrief`, as the studio panel does (`finance-result-panel.tsx:4`).
  - It renders the task's own result panel from `apps/web/components/finance-steps/registry.tsx`, with regeneration off (`FinanceResultPanelProps`, `apps/web/components/finance-steps/finance-result-panel.tsx:12-22`: `regeneratingIndex: null`, `disabled: true`, no models).
  - **To confirm in the build:**
    - The budget and cash-flow panels are confirmed to take only these props (`budget/result.tsx:137`, `cashflow/result.tsx:60`). Ratios, appraisal and brief are not read yet.
    - If a panel needs studio setup state, the lane splits that file first, as its own commit with no behaviour change (spec § 4, "Reuse rule").
  - **Fallback.** `meta.report` is dropped above 256 KB (`persist.ts:53-64`). Open then shows the markdown body, and Download still works, because export falls back the same way (`packages/host/src/handlers/finance-export.ts:63-87`).
- **Download.** xlsx and docx through `POST /api/v1/finance/export { artifactId, format }`. The export reads the stored report (`finance-export.ts:75-77`). pptx carries no task tables (`packages/host/src/renderers/pptx.ts:185-191`), so it is left out.
- **Where the five new metrics show in chat** (`3c217248`):
  - The equity multiplier, operating cycle, operating leverage, margin of safety and weighted miss reach the write-up's fact sheet, so the summary can name them.
  - In the open view: the three ratios are scorecard rows, and the weighted miss is a budget tile.
  - Margin of safety is in the xlsx and docx downloads. It is not on the cash-flow result screen, the same as in the studio.
- **Inherited, not fixed here.** The weighted-miss tiles print an unrounded number, a defect from `3c217248`. The open view reuses the studio panel, so it shows the same.
- **Labels and copy.**
  - Progress and display labels go in `apps/web/lib/tool-labels.ts` (`:27`, `:39`).
  - The key joins `NO_EMBED_TOOLS` (`apps/web/lib/message-embeds.ts:298`).
  - New copy goes in both `en` and `id` (`agents-locale.test.ts`).

## 6. What chat skips compared with the studio

In the studio, the person can confirm several things before the run:

- cash-flow rows read with under 0.8 confidence (`packages/core/src/finance/cashflow/types.ts:77`);
- budget pairs whose labels differ;
- buckets for unplaced ratio rows;
- the bands.

Chat runs on auto's code-only reading instead.

- **What the person sees.** The card shows one check line, and the open view lists every note. The person never gets an output that silently assumed something.
- **Corrections.** A correction typed in the thread, such as "treat rent as fixed", is not acted on in v1: chat has no override input. The agent says so and points to the studio. Overrides from chat are later work, with C3.

## 7. Decisions for Rizky

1. **Figures source on the hosted app.**
   - The figures file (§ 2) is **recommended**.
   - The alternatives are: keep the raw workbook privately (a new private store, reopening SR-185), or read the chat desk copy (amounts may be masked).
2. **What the agent can say after a run.** The chat reply is not number-guarded, and there is no `read_result`. A follow-up such as "why is DSCR low?" pushes the model to work out figures itself. The options:
   - (a) Instruct only.
   - (b) Put every computed KPI and the key table rows in the tool output, about 3,000 characters, so the model has the figures to quote.
   - (c) Build `read_result` now.
   - (d) Run the Finance number guard on the agent's reply in any turn that used `finance_task`, against the artifact's allowed numbers.
   - **Recommended:** (b) now, with (d) recorded as a register row for later. (d) cannot block text that has already streamed. It can only mark it, so it needs its own design.
   - **Accepted and built: (b).** The output carries `facts` (`factsOf`, `packages/host/src/workers/finance-task-facts.ts:82`). (d) is still open.
3. **Tool shape.**
   - **Recommended:** one `finance_task` tool, as Research is built.
   - The alternative is to build the spec's `run_worker` multiplexer first. Two workers do not crowd the tool list yet.
4. **What it may ask.**
   - **Recommended:** only three questions: the task when auto is unsure, the discount rate, and the opening cash. Everything else runs and shows as a check.
   - The alternative is to also ask about unpaired budget lines and low-confidence cash-flow rows, which costs more questions per run.

## 8. Risks and register rows

New rows for `docs/internal/security-register.md` when this is built:

- **A worker reads private figures.** Trust is `user_content`. After a run, `web_fetch` is refused in that thread. `research_dossier` still runs (plan risk 5, unruled).
- **The figures file.**
  - It sits in the person's own folder.
  - It is redacted the Finance way: amounts kept, identifiers masked. That is the same as a studio import.
  - Removing the chip before send leaves nothing, because the file is written at send.
- **A forged figures file.** The model can write desk files, so it could write one that looks like the person's figures. The worker accepts only a file whose newest version the person wrote (§ 3, step 1).
- **The result is desk-visible.**
  - Artifacts are filtered by desk only (`packages/host/src/artifacts.ts:152-175`), so every member of the desk sees a report made from one person's private attachment.
  - That is acceptable while a desk has one owner (the OPC).
  - `artifacts-visibility.test.ts:47` is titled "the maker" but never checks a second member. That is test drift to fix.
- **The Knowledge Base card.** Each run also writes a work card (`upsertWorkSource`, `packages/host/src/finance-tasks/runner.ts:369-381`). Whether that card is limited to the person or desk-wide was not checked in this pass. Check it before build. A Chat card is visible only to the thread's owner (`knowledge-visibility.ts`, `maps/knowledge-flows.md` § 7).
- **The unguarded reply.** See decision 2.
- **Time.**
  - The browser cuts a turn at 120 s on Fastest and 240 s otherwise (`packages/core/src/runtime/stream-watchdog.ts`, `apps/web/components/chat-composer.tsx:528`).
  - A Finance run is code plus one write-up and a repair round, so it should fit.
  - Measure it on the drive.

## 9. Change list (tester), one commit each

1. **No behaviour change.**
   - Export `readWorkbook`, `readDocument` and `documentSheets` from `finance-import.ts`.
   - Move `joinSheetTexts` to core.
   - Move `splitUserFileBlocks` to core.
   - The studio and the renderer import from the new places.
2. **The figures file.**
   - `readFinanceFigures`.
   - The attach answer, the save handler, the note line and its prefixes, and the composer round trip.
   - Auto's `no_opening_cash` warning and its optional `task`.
   - The desk store read of the newest version's author.
3. **The worker.**
   - The tool and its registration.
   - `CHAT_WORKERS`, `SPECIALTIES`, the Finance brief and the turn text on the worker channel.
   - The budget pin.
4. **The card and the open view.** Labels, `en` and `id`.
5. **Docs.**
   - Map pages: `chat-documents.md`, `finance-tasks.md`, `virtual-agents.md`, and a new [`finance-chat-worker.md`](maps/finance-chat-worker.md).
   - "Finance in Chat" items in `features/finance.md` (there is no `features/chat-workers.md`).
   - `unreleased.md`, and the register rows in § 8.

## 10. Tests

- **Tool, unit.**
  - Input to auto to the run.
  - `needs_input` for the task, the rate and the opening cash.
  - An answer number missing from the typed text is refused, including a number that appears only inside the attached file.
  - A figures file last written by a tool (`agent`) is refused, and so is a path outside the person's folder.
  - With `task` named, auto reads for that task. A task auto cannot read gives a clear refusal, not a schema error.
  - `cancelled` and `failed`.
- **Figures file.**
  - A two-sheet xlsx gives both sheets.
  - The save checks again (injection, cap).
  - The file lands in the person's folder and nobody else's.
  - A figures failure leaves the attachment working.
  - The same test passes on Personal and in server mode.
- **Router level.** A chat run goes through `dispatch`, with `collectJobAssistantRun` and `requireLive` mocked as in `packages/host/src/finance-tasks/runner.test.ts:21-36`.
  - It ends with the saved `tool_call` output and a `finance` artifact row.
  - Spec § 9's "stub-runtime run" cannot be copied as written: `runFinanceTask` answers 503 on the stub runtime (`finance-tasks/live.ts:47-57`).
- **Renderer.** The card and the open view from one fixture report per task; `en` and `id` parity.
- **Drive on `:3200`.** This needs Rizky to restart it after the host changes. Time each run.
  - Ratios from a workbook with a balance sheet and a P&L.
  - Budget from a two-sheet workbook.
  - Cash flow with no opening row: it asks.
  - Appraisal with no rate: it asks.

**Out of scope:**

- regenerating one section and inline edits (C3; no host route exists for the four non-brief tasks);
- `read_result` and `run_worker`;
- CSV;
- overriding auto's reading from chat;
- the 40-request eval of which worker gets chosen.
