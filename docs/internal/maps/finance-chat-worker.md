# Map: the `finance_task` chat worker

Product: both · Instance: tester :3200

Last verified: 2026-10-20 at 0fdf2bb1. Every citation on this page was read against the code at that commit. Code-read only: no test was run and nothing was driven in this pass. The recipe is [`features/finance.md`](../../../.cursor/skills/verify-agentforge/features/finance.md), "Finance in Chat".

## Overview

A person attaches a spreadsheet, or a Word, PDF or PowerPoint file with a table, in any agent's chat and asks about the figures. The host keeps a Finance-redacted figures file beside the chat's desk copy, and the agent calls `finance_task`. That tool runs the same Finance task engine the studio uses and answers a card under the reply, with Open and Download. It is tester code only (`tester/chat-first`). It adds no mode, rail entry, task or host route.

The model never supplies a figure. Code reads the file, picks the task, computes every number and checks the write-up. The model passes on the person's question, the file path, and a task name or an answer number only when the person typed it. The design and its decisions are in [`../finance-chat-worker-design.md`](../finance-chat-worker-design.md).

## How it works

### 1. Attach: the figures are read beside the chat text

`handlePostChatDocument` (`packages/host/src/chat-documents/handler.ts:54`) reads the file with `readChatDocument` (`packages/host/src/chat-documents/read.ts:52`). That read now also returns the reader's raw tables and Markdown, `extractedTables` and `extractedMarkdown` (`read.ts:37-38`, set at `:75-76`). These are the extract before the chat mask. The chat mask can turn an amount into `[phone]` or `[card]`, so the figures are never read back from the masked text.

The handler then calls `readFinanceFigures` (`packages/host/src/finance-figures/figures.ts:112`) inside `withLimit(documentLimiter, ...)` (`handler.ts:62-66`). The figures read waits in the same queue as the document read, so on the hosted server it counts toward the 2 reads at once (`packages/host/src/chat-documents/limiter.ts:22`). A refusal from that queue, or any throw, becomes `FIGURES_NOT_READ` (`handler.ts:35`), which is `figures: null, skipped: "unreadable"`. A figures failure never fails the attachment.

`readFinanceFigures` takes two kinds of file:

- **A workbook.** The format `xlsx`, which covers `.xlsx`, `.xls` and `.xlsm` (`DOCUMENT_FORMAT_BY_EXTENSION`, `packages/core/src/chat-documents/formats.ts:44-46`). `workbookSheets` (`packages/host/src/finance-figures/read-file.ts:93`) reads every sheet. A `.xlsm` name is read as `.xlsx` (`workbookFile`, `figures.ts:67`). The prose text is empty.
- **A document.** `docx`, `pdf` and `pptx` (`DOCUMENT_FORMATS`, `figures.ts:29`). `documentSheets` (`read-file.ts:48`) turns the extracted tables into sheets, and `documentProse` (`read-file.ts:89`) keeps the prose. A document with no table is skipped as `no_table`.

Every other format answers `figures: null, skipped: null`. That includes ods, odt, rtf and epub.

`joinSheets` (`figures.ts:43`) passes each sheet, up to 30 (`FINANCE_IMPORT_MAX_SHEETS`), through `guardFinanceInput({ sheet })` (`packages/host/src/finance-privacy.ts:143`). That guard is Finance's own redaction: it masks identifiers and puts masked amounts back. A failure on the first sheet throws. A failure on a later sheet names that sheet as skipped. `joinSheetTexts` (`packages/core/src/finance/import-table/join-sheets.ts:20`) joins whole sheets, each under its `Sheet:` line, up to 12,000 characters (`FINANCE_FIGURES_TEXT_MAX`, `packages/core/src/finance/import-table/limits.ts:21`). A sheet past the cap is left out whole and named in `skipped`.

`judged` (`figures.ts:98`) then decides:

| Check | Answer when it fails |
|---|---|
| The joined figures text is not empty | `no_table` |
| `financeTextBlocked` (`packages/host/src/finance-figures/injection.ts:3`) finds no injection in the file name or the text | `blocked` |
| Some task scores at least 0.2 in `scoreFinanceTaskFit` (`fitsSomeTask`, `figures.ts:88`; the bar is `FINANCE_AUTO_TRY_MIN_SCORE`, `packages/host/src/finance-tasks/auto.ts:66`) | `no_table` |
| The result passes `chatFinanceFiguresSchema` (`packages/core/src/chat-documents/finance-figures.ts:12`) | `unreadable` |

The attach answer carries `figures: { figuresText, proseText, sheetNames, skipped } | null` and `figuresSkipped` (`handler.ts:84-85`). The composer keeps `figures` only when it passes the same schema (`figuresOf`, `apps/web/lib/composer-documents.ts:161`) and `figuresSkipped` only when it is a known code (`:185`). The chip shows nothing about figures.

### 2. Send: the figures file is written beside the desk copy

`saveChatDocument` (`apps/web/lib/composer-documents.ts:249`) sends `figures` back in the save body when the read had them (`:263`). `handlePostChatDocumentSave` (`packages/host/src/chat-documents/save-handler.ts:105`) writes the `.md` desk copy first. It writes the figures file only when that copy saved (`copy.ok ? await keptFigures(...)`, `:112`).

`keptFigures` (`save-handler.ts:100`) calls `checkFinanceFigures` (`figures.ts:140`). That function checks the sent value against the schema, runs `guardFinanceInput` again on `figuresText` and `proseText`, runs `financeTextBlocked` again, and checks the schema once more. Anything that fails is dropped without a word: no figures file and no figures note.

`saveDeskFigures` (`packages/host/src/chat-documents/desk-copy.ts:41`) writes the checked value as JSON through the desk root, authored as the person (`kind: "user"`). The path is `deskPathForDocument(name, userId, FIGURES_SUFFIX)` (`packages/host/src/chat-documents/desk-name.ts:70`), with `FIGURES_SUFFIX` `.figures.json` (`desk-copy.ts:39`). So `budget.xlsx` gives `uploads/~<folder>/budget.xlsx.figures.json`, next to `uploads/~<folder>/budget.xlsx.md`. The folder is the person's own private one ([`chat-documents.md`](chat-documents.md) § 4). A refused write returns null. The save answer gains `figures: { path } | null` (`save-handler.ts:136`).

### 3. The note

`figuresNote` (`packages/host/src/chat-documents/notes.ts:71`) writes one host line:

```
[Figures kept: uploads/~<folder>/budget.xlsx.figures.json. To answer a question about these figures, call finance_task with this path as file.]
```

`documentNotes` (`notes.ts:89-97`) puts it fourth: the size line, the data line, the saved line, the figures line, the original-file line, then the cut line. The prefix `[Figures kept` is in `HOST_NOTE_PREFIXES` (`packages/core/src/chat-documents/markers.ts:17`). A document that writes that line itself is indented by `cleanDocumentText`, and the egress guard does not read the line as the person's words. The thread's file card hides it, because it is in `MODEL_ONLY_NOTE_PREFIXES` (`apps/web/lib/message-embeds.ts:110`).

### 4. The tool call

`financeTaskTool` (`packages/host/src/workers/finance-task-tool.ts:271`) is registered in `ensureToolsRegistered` beside `research_dossier` (`packages/host/src/register-tools.ts:45`). Its trust is `user_content` (`finance-task-tool.ts:276`), so a run marks the thread as having read private material for the egress guard.

Every agent binds it. `FULL_CHAT_TOOLS` (`packages/core/src/agents/virtual-agents.ts:104`) is Chat's tools plus `GENERALIST_WORKER_TOOLS` (`:89`), the keys of `CHAT_WORKERS` (`:74`). The default agent gets it at run time through `withGeneralistWorkers` (`packages/host/src/virtual-agents.ts:161`, called at `packages/host/src/runs.ts:518`). The prompt sentence is `CHAT_WORKERS.finance_task.sentence` (`virtual-agents.ts:81-85`). The Finance agent's own brief names it too (`SPECIALTIES.finance`, `:158-162`), and its `worker` key makes its conversation `harness` (`:254`) and drops the studio note (`:215`).

The input schema (`finance-task-tool.ts:41-66`):

| Field | Rule |
|---|---|
| `request` | The person's question, trimmed, 8 to 2,000 characters |
| `file` | The path from the `[Figures kept: ...]` note, up to 512 characters |
| `task` | Optional. One of `brief`, `ratios`, `budget`, `cashflow`, `appraisal`. Only when the person named or picked one |
| `answers` | Optional, strict. `discountRatePercent` and `openingCash`, finite numbers |

The budget allows 2 calls a turn (`perTurn: 2`, `virtual-agents.ts:82`). `FULL_CHAT_BUDGET` (`:118`) puts it in `perTool`, and `packages/host/src/runs-budget.test.ts:122-127` pins `finance_task: 2`.

### 5. The provenance check

`runFinanceTaskWorker` (`finance-task-tool.ts:239`) answers `cancelled` at once when the run's signal is already aborted (`:244-246`). Then `readOwnFigures` (`:113`) reads the file. It returns null, which becomes a `needs_input` ask for `file` (`:250-252`), in each of these cases:

- `ownFolderPath` (`:102`) refuses the path. The path must parse as a desk path, start with `uploads/<privateFolderFor(userId)>/`, end with `.figures.json`, and have exactly 3 segments. A path in another person's folder, one that climbs out, or one in a subfolder fails.
- The newest version, from `listVersions` (`packages/host/src/desk-files/file-store.ts:387`), was not written by this person. `authorKind` must be `user` and `authorId` this person's id (`finance-task-tool.ts:121`). Every model-invoked tool writes as `agent`, so a figures file the model wrote or edited with `write_file` or `edit_file` is refused.
- The file is missing (`FileRootError`), not JSON (`SyntaxError`), or fails `chatFinanceFiguresSchema` (`:125-131`).

The read uses the store's existing `readVersion` (`file-store.ts:407`) for that newest version. Any other error is thrown and ends as `failed` (`:254-260`).

### 6. Auto picks the task, in code

`reviewFigures` (`finance-task-tool.ts:174`) calls `runFinanceAuto` (`packages/host/src/finance-tasks/auto.ts:487`) in process, with no HTTP call. It sends `figuresText`, `proseText`, `sheetNames`, `prompt: request`, the run's locale, and `task` only when the model passed one (`finance-task-tool.ts:183-190`). Auto scores the five tasks, reads the figures with code only, and returns `fits`, `task`, `input` and `warnings`. It calls no model and writes nothing. [`finance-tasks.md`](finance-tasks.md) § 11 covers the forced `task`, `no_opening_cash` and what `high` confidence means.

### 7. The ask rules

The rules are `DECISION_RULES` (`packages/host/src/workers/finance-task-asks.ts:111-130`). `decide` (`:132`) runs them in order and stops at the first that answers. The file check in § 5 runs before them. In order:

| # | When | Answer |
|---|---|---|
| 1 | The figures file failed § 5 | `needs_input`, field `file`: attach the spreadsheet again |
| 2 | No task named, and `fits.confidence` is not `high` | `needs_input`, field `task`, with the top 3 of auto's ranked list as `choices`, whatever their scores (`askFor`, `:46`, `TASK_CHOICES_MAX`, `:13`) |
| 3 | Auto could not read the figures (`input` is null) | `failed`, code `figures_not_read`, message from auto's warnings |
| 4 | Appraisal or cash flow, no answer given, and the value is missing: auto warned `default_discount_rate` or `no_opening_cash`, or the appraisal's rate came only from the model-written `request` | `needs_input`, field `discountRatePercent` or `openingCash` |
| 5 | An answer was given, but the number is not in the person's typed text | `needs_input` for the same field again |

Rule 4's second case is `rateUntrusted` (`finance-task-tool.ts:135-146`). Auto reads the rate from the prompt, the figures and the prose together (`auto.ts:382`), and the prompt is the model's `request`. When the rate auto used did not come from the figures or prose text (`discountRateFromText`, `packages/core/src/finance/appraisal/grid.ts:198`) and the person did not type it, the worker asks.

Rule 5 needs the person's own words. The run puts the turn's user text on the worker channel (`userText`, `packages/host/src/workers/worker-channel.ts:15`, set at `packages/host/src/runs.ts:493`). `typedSegments` (`finance-task-asks.ts:55`) keeps only the text segments of `splitUserFileBlocks` (`packages/core/src/chat-documents/file-blocks.ts:27`), so a number inside an attached file never counts. `typedNumberMatches` (`finance-task-asks.ts:69`) compares through `extractNumbers` (`packages/core/src/finance/number-guard.ts:114`), so `12%`, `12.5` and `Rp 50.000.000` match, including a token's alternate reading.

The questions are in English and Indonesian (`QUESTIONS`, `finance-task-asks.ts:16`). The model is told to put the question to the person and not to answer it.

### 8. The run

`withAnswer` (`finance-task-tool.ts:148`) writes an applied answer into `input.params` and records which warning it settles (`warningSettledBy`, `finance-task-asks.ts:151`). Then `runWithWorkerProgress` (`worker-channel.ts:55`) wraps `generateFinanceBrief` (`packages/host/src/finance-generate.ts:173`) with `{ ...input, task, prompt: request, locale }` (`finance-task-tool.ts:216-218`). The file read and auto run outside that wrapper, so they send no progress.

`generateFinanceBrief` runs the brief path or, for the other four tasks, the generic runner ([`finance-tasks.md`](finance-tasks.md) § 5). The guard, the repair round, the artifact save and the Knowledge Base work card all run as in the studio. The worker sends no `model`, so `resolveModel` (`packages/host/src/finance-tasks/live.ts:59`) picks `settings.documentGenModel`, else the Finance mode default. It is never the chat's tier model. `requireLive` (`live.ts:47`) answers `runtime_stub` 503 on a stub desk, which the worker returns as `failed`.

The gateway gate and the hosted run slot come from the chat run (`packages/host/src/handlers/runs.ts:47`, `:50`). The worker does not call `streamJob`, so it takes no second slot. Each `job.phase`, `job.step` and `job.round` reaches the screen as `tool.progress` (`runs.ts:481-495`). While the run works, the last event is sent again every 20 s for at most 8 minutes (`WORKER_HEARTBEAT_MS`, `WORKER_MAX_MS`, `worker-channel.ts:29`, `:36`).

### 9. The output

The tool answers one of three shapes (`FinanceTaskWorkerResult`, `finance-task-tool.ts:72-84`):

- `{ ok: true, artifact, task, headline, summary, facts, checks, notes }`;
- `{ ok: false, reason: "needs_input", ask: { field, question, choices? } }`;
- `{ ok: false, reason: "failed" | "cancelled", code, message }`.

On success:

- `headline` is up to 4 KPIs from `report.summary`, rounded to 2 decimals (`headlineOf`, `packages/host/src/workers/finance-task-facts.ts:26`).
- `summary` is the first note's body, which already passed the number guard, cut to 1,200 characters (`finance-task-tool.ts:227`).
- `facts` is decision 2(b). `factsOf` (`finance-task-facts.ts:82`) writes a "Key figures" table of every KPI, then each report table except the calculation table, with the inputs table last (`orderedTables`, `:51`). Whole rows only, up to 3,000 characters (`FACTS_MAX`, `:11`). It stops at the first block or row that does not fit. These are computed figures, so the model may quote them in its reply. The reply itself is not number-guarded.
- `checks.passed` is true only when the guard flagged and removed nothing (`finance-task-tool.ts:229`).
- `notes` is auto's warnings, less the one an applied answer settled, plus the run's own warnings as `run_warning` (`:230-235`).

The model and the card read the same saved `tool_call` output. There is no new message part.

### 10. The card, Open and Download

`FinanceCards` (`apps/web/components/chat-finance-card.tsx:269`) is drawn under the answer after `DossierCards` (`apps/web/components/chat-turn.tsx:200`). It reads each completed `finance_task` call with `readFinanceResult` (`apps/web/components/tool-rows/finance-result.ts:53`), which needs `ok: true`, a known task and an artifact title. `finance_task` is in `NO_EMBED_TOOLS` (`apps/web/lib/message-embeds.ts:211`), so the result is never also drawn as a job card. Its row label and activity word are in `apps/web/lib/tool-labels.ts:29`, `:42`. The copy is `agents.finance.*`, in `en` and `id`.

The card shows "Finance · <task>", the title, one check line (`checkProblems`, `chat-finance-card.tsx:44`) and up to 4 headline figures. The check line is in the danger tone when the guard flagged or removed something or there are notes. With an artifact id it has Open and Download Excel and Word. With none it shows `chat-finance-not-saved` instead.

Open loads the artifact (`getArtifact`) and builds a view with `financeOpenView` (`apps/web/lib/finance-open-view.ts:43`):

- `meta.report` gives the task's own result panel;
- `meta.brief` gives the brief panel;
- otherwise the Markdown body is shown (`chat-finance-text`). That is the case when the report was over 256 KB and was not stored (`FINANCE_META_MAX_BYTES`, `packages/host/src/finance-artifact.ts:20`; `persist.ts:59`).

`OpenView` (`chat-finance-card.tsx:80-97`) mounts `financeStepsFor(task).Result`, or `FinanceResultPanel`, with `regeneratingIndex={null}`, `disabled` and no models. The notes are listed above it (`chat-finance-notes`). Download calls `downloadFinanceExport` (`apps/web/lib/finance-export.ts:145`), which posts `POST /api/v1/finance/export { artifactId, format, task }`. PowerPoint is left out.

### What chat skips compared with the studio

- No confirm step. The studio lets the person confirm low-confidence cash-flow rows, budget pairs, buckets for unplaced ratio rows and the bands. Chat runs on auto's code-only reading and lists what it assumed as notes.
- No correction. A correction typed in the thread, such as "treat rent as fixed", has no input to go into. The agent points to the studio.
- No model pick. The run uses the Finance model (§ 8).
- No section regeneration and no inline edits. The open view's panel is disabled.
- No PowerPoint download.
- No CSV and no pasted table. A CSV goes as plain text and gets no desk copy, so no figures file.
- No ods or odt. The figures read takes xlsx, docx, pdf and pptx only.
- No press before the paid step. In the studio the write-up runs only on "Write it up". In chat the person's message is the request, and the model decides to call the tool.

## Where things live

| File | Role |
|---|---|
| `packages/host/src/finance-figures/figures.ts` | `readFinanceFigures` at attach and `checkFinanceFigures` at save |
| `packages/host/src/finance-figures/read-file.ts` | The workbook and document readers the studio import route also uses |
| `packages/host/src/finance-figures/injection.ts` | `financeTextBlocked`, shared with `finance-import.ts` |
| `packages/core/src/chat-documents/finance-figures.ts` | `chatFinanceFiguresSchema`, the skip codes and the name caps |
| `packages/host/src/chat-documents/handler.ts`, `save-handler.ts`, `desk-copy.ts`, `notes.ts` | The attach answer, the save, the figures file and its note |
| `packages/host/src/workers/finance-task-tool.ts` | The tool: schema, provenance check, auto, run, output |
| `packages/host/src/workers/finance-task-asks.ts` | The ask rules, the questions and the typed-number check |
| `packages/host/src/workers/finance-task-facts.ts` | `headlineOf` and `factsOf` |
| `packages/host/src/workers/worker-channel.ts` | Progress, cancel and `userText` from the chat run |
| `packages/host/src/finance-tasks/auto.ts` | `runFinanceAuto`, the code-only reading |
| `packages/core/src/agents/virtual-agents.ts` | `CHAT_WORKERS.finance_task` and `SPECIALTIES.finance.worker` |
| `apps/web/components/chat-finance-card.tsx` | The card, Open and Download |
| `apps/web/components/tool-rows/finance-result.ts` | Reads the tool output into the card model |
| `apps/web/lib/finance-open-view.ts` | The artifact into a result panel, a brief or Markdown |

## Touches / Do not touch

Owned here, tester code only: `packages/host/src/workers/finance-task-*.ts`, `packages/host/src/finance-figures/**`, `packages/core/src/chat-documents/finance-figures.ts`, `apps/web/lib/finance-open-view.ts`.

Described here, but under another page in `lanes.json`: `apps/web/components/chat-finance-card.tsx` and `apps/web/components/tool-rows/finance-result.ts` (the chat renderer, [`chat-send.md`](chat-send.md)). A change to them refreshes both pages.

Belongs to another page:

- The chat attach and save routes and the private folder: [`chat-documents.md`](chat-documents.md).
- `runFinanceAuto`, the task modules and the runner: [`finance-tasks.md`](finance-tasks.md).
- The Finance import route and `generateFinanceBrief`: [`finance-parse-and-generate.md`](finance-parse-and-generate.md).
- The agent registry, the worker channel and the harness panel: [`virtual-agents.md`](virtual-agents.md).
- `message-embeds.ts` and `tool-labels.ts` are shared files with a `Lanes:` line in `lanes.json`.

## Gotchas

- **A figures file exists only when the `.md` copy saved.** A full quota or a desk at its file ceiling leaves no figures file and no figures note, so the agent has nothing to pass to the tool.
- **The figures note is hidden from the person.** The file card leaves out `[Figures kept` (`message-embeds.ts:110`). Only the model sees the path. To check that a figures file exists, list `uploads/~<folder>/` or read the saved message.
- **Re-attaching the same file adds a version.** The second save writes a new version of the same `.figures.json`, authored by the person. A model write after that makes the file unusable for the worker until the person attaches it again.
- **A model-written `request` that trips the injection guard fails the run.** `runFinanceAuto` checks the prompt with `assertSafeSourceText` (`auto.ts:194`), and the worker returns that `ApiError` as `failed`.
- **The task choices are not filtered by score.** Rule 2 offers the top 3 of all five ranked tasks, so a choice can have no evidence at all.
- **A task the person named cannot fall back.** With a forced task, auto tries only that task. If it cannot read the figures for it, the worker answers `figures_not_read` with auto's warning text.
- **The Finance model, not the chat's tier.** A Fastest chat still runs the Finance write-up on `settings.documentGenModel` or the Finance default (§ 8). That can be the slowest part of the turn.
- **The browser watchdog.** The composer arms `armStreamWatchdog` with the tier's limits (`apps/web/components/chat-composer.tsx:528`). On Fastest `tierStreamLimits` (`apps/web/lib/chat-tier-pref.ts:229`) leaves the defaults, a 120 s first-byte limit and 60 s idle (`STREAM_TTFB_MS`, `STREAM_IDLE_MS`, `packages/core/src/runtime/stream-watchdog.ts:5`, `:7`). The other tiers use 240 s and 180 s. Time a Finance turn on Fastest when you drive it.
- **The "Kas keluar" row of an Indonesian cash book is read as an inflow by auto.** Reported on the tester; not traced in this pass. The cash-flow classifier's outflow patterns are in `packages/core/src/finance/cashflow/classify.ts:22` and `packages/core/src/finance/cashflow/periods.ts:56`.
- **The reply is not number-guarded.** The `facts` field gives the model computed figures to quote. A figure the model writes outside them is not checked. Decision 2(d) in the design, a guard on the reply, is not built.
- **The result is desk-visible.** The artifact and its Knowledge Base work card are filtered by desk, not by person. That is acceptable while a desk has one owner.

## Verify

Recipe: [`features/finance.md`](../../../.cursor/skills/verify-agentforge/features/finance.md), the "Finance in Chat" items in each section. It drives `:3200` only.

DOM testids: `chat-finance-cards`, `chat-finance-card` (`data-artifact-id`, `data-open`), `chat-finance-title`, `chat-finance-checks` (`data-failed="true"` when something was flagged), `chat-finance-headline`, `chat-finance-figure`, `chat-finance-open`, `chat-finance-download-xlsx`, `chat-finance-download-docx`, `chat-finance-download-error`, `chat-finance-not-saved`, `chat-finance-view`, `chat-finance-notes`, `chat-finance-note`, `chat-finance-loading`, `chat-finance-error`, `chat-finance-text` (`apps/web/components/chat-finance-card.tsx`).

Unit tests:

- `packages/host/src/workers/finance-task-tool.test.ts`: a good ratios run with facts, every provenance refusal, each ask, a rate written only by the model, a rate only inside a file block, the opening cash, cancel and registration.
- `packages/host/src/workers/finance-task-facts.test.ts`: the headline and the facts cap.
- `packages/host/src/finance-figures/figures.test.ts` and `packages/host/src/chat-documents/figures-failure.test.ts`: the attach read, the save check, and a figures failure that leaves the attachment working.
- `packages/core/src/chat-documents/finance-figures.test.ts` and `file-blocks.test.ts`.
- `packages/host/src/runs-budget.test.ts`: the `finance_task: 2` cap.
- `apps/web/lib/chat-finance-card.test.tsx` and `apps/web/lib/finance-result.test.ts`: the card and the result reader.

## Why

**Why a separate figures file and not the chat desk copy.** `[Direct]` [`../finance-chat-worker-design.md`](../finance-chat-worker-design.md) § 2: the desk copy is chat-masked Markdown, and the chat mask can change an amount. The hosted app keeps no original bytes for a chat upload (SR-185). Confidence: high.

**Why the newest version must be the person's.** `[Direct]` the design, § 3 step 1: the model can write desk files, so it could write a file that looks like the person's figures. The store already records the author kind of each version. Confidence: high.

**Why the tool returns `facts`.** `[Direct]` the design, § 7 decision 2, accepted as (b): without computed figures in the output, a follow-up such as "why is DSCR low?" pushes the model to work a figure out itself. Confidence: high.
