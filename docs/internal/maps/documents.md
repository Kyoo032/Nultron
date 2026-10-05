# Map: Documents job

Last verified: 2026-10-03 at 0b61a29, with uncommitted changes in the working tree (the mode-harness lane: desk files as sources through one picker shared with Presentation, the checks and one repair round, a repair call that fails keeping the first draft, cancel and budget reaching the model call). Every citation on this page was re-read against that tree. The generate, check and regenerate flows were read in code and in their unit tests, not driven in a browser by this pass.

## Overview

Documents is a **job**, not an editor: a topic in the prompt bar becomes a JSON draft, the draft renders as an HTML preview of headed sections, and the user downloads a `.docx`. It is the simplest of the job modes. It has no SSE, no tools (`tools: []` in `documentsHarnessSpec`, `packages/core/src/harness/modes/documents.ts:9`) and no streaming progress. Four posts serve it: generate, regenerate, docx and a source check (`packages/host/src/router.ts:353-356`). The check, `POST /api/v1/documents/check`, marks sentences the source does not support through `checkDraftAgainstSource` (`packages/core/src/documents/source-check.ts:51`) and calls no model. Its button is `documents-check` (`apps/web/components/documents-studio.tsx:256`).

Two things set it apart from Chat. First, **the draft lives in renderer state**, not in a thread: `DocumentsStudio` holds one `draft` object and every action reads or replaces it, so a reload loses the document unless a live generate happened to save an artifact. Second, **source material is the mode's real feature**. The model may use an optional block of source as its only facts. That block is assembled on the host from up to three inputs: pasted text, a saved artifact or a Research handoff (all three end up in `sourceText`), and up to five **desk files** the person picks (`sourceFiles`).

Since 2026-10-03 a generate does not finish when the model answers. It finishes when the draft passes two pure checks, with one repair round if it does not (`runChecked`, `packages/host/src/harness/run-checked.ts:71`). A draft that still fails is saved and shown with a note, never refused. A repair call that fails, or answers with nothing or with something unreadable, costs the person nothing: the first readable draft is kept (§ 3b).

What it is not: a Word editor, a streaming mode, or a `/runs/*` consumer. It never touches the chat run orchestrator.

## How it works

### 1. Mounting: the pane is never unmounted

`/documents` has a `<Route path="/documents" element={null} />` in `apps/web/src/App.tsx:390`, and the comment at `:388` says why. The real component is mounted by `WorkModeKeepAlive` (`apps/web/components/work-mode-keep-alive.tsx:50`), which maps `"/documents"` to `DocumentsStudio` (`:23`) and keeps **every visited** work-mode pane in the DOM through `WorkModePanes` (`:67`). It hides the inactive ones with `hidden={!active}` and `className="hidden"` together (`:87`). All panes are re-keyed when the desk changes (`nextDeskKey`, `:60-64`).

The consequence bites tests. After one visit to `/documents`, `documents-studio` still has count 1 on `/chat` and `/research`, with `isVisible() === false`, and `documents-prompt` keeps whatever was typed. Assert visibility, not count, when you mean "this mode is not showing".

### 2. Composing a request

`DocumentsStudio` (`apps/web/components/documents-studio.tsx:51`) holds twelve pieces of state (`:58-75`): `prompt`, `sourceText`, `sourceTitle`, `draft`, a single `busy` discriminator (`"generate" | "download" | "regen" | "check" | null`), `regenIndex`, `error`, `landed` (a counter that mounts the confetti when a draft lands, `:425`), `sourceCheck` (the answer of `documents-check`), `deskSources` (the picked desk file paths), `deskRefresh` (a counter that asks the picker to re-read the desk) and `checks` (what the host's checks still found, `null` when they all passed). The generate bar is one `<form data-testid="documents-studio-prompt-bar">` (`:346-419`) holding, in order:

| Control | Where | Note |
|---|---|---|
| `SourceMaterialField` | `:353-360`, component at `apps/web/components/source-material-field.tsx:20` | `testIdPrefix="documents"` gives `documents-source`, `-source-toggle`, `-source-title`, `-source-clear`, `-source-text` |
| `DeskSourcePicker` | `:361-367`, component at `apps/web/components/desk-source-picker.tsx:135` | `desk-sources` and its children, see below. Renders nothing while the desk has no files and none is picked. The same component sits in Presentation's More ([`presentations.md`](presentations.md) § 2) |
| `ModelSelect` | `:368-375` | `testId="documents-studio-model"`, a real `<select>` with `className="select-field w-full"` |
| `EnhancePromptButton` | `:377-384` | `testId="documents-enhance"`. With the topic field and the submit button it sits in one `PROMPT_ROW` (`:376`, see below) |
| the topic field | `:385-394` | `data-testid="documents-prompt"`, an **`<input type="text">`** with `className={PROMPT_INPUT}` |
| `MascotSlot` | `:395-397` | Shown beside the button only while `busy === "generate"`; decorative |
| submit | `:398-410` | `data-testid="documents-generate"`, disabled while busy, when the prompt is blank or when `needsKey` (`:405`); `className` starts with `PROMPT_SUBMIT` (`:400`) |
| needs-key note | `:411-417` | `documents-needs-key`, with a Settings link on the hosted build (`hostedKeyBlock`) |

**The row answers to its own width.** `PROMPT_ROW`, `PROMPT_INPUT` and `PROMPT_SUBMIT` come from `apps/web/lib/prompt-row.ts` (imported at `documents-studio.tsx:24`; Research, Images, Videos, Music and Data use the same constants). `PROMPT_ROW` (`prompt-row.ts:17`) makes the row a size container. At 40rem of row width or less `documents-generate` takes its own line below the prompt (`PROMPT_SUBMIT`, `:23`), and at 26rem or less `documents-enhance` keeps its icon, `title` and accessible name while its visible word (`.enhance-btn-label`) becomes `sr-only`. Wider than 40rem the row is one line.

`useJobModel("documents")` (`apps/web/lib/use-job-model.ts:91`) reads `GET /api/v1/models` once and `GET /api/v1/settings` through the shared `readSettings`. `jobModelAnswer` (`:66`) resolves the mode's list through `modelsForMode`, because the host sends the chat catalogue once and not a copy per mode. The desk's `documentGenModel` setting only **seeds** the pick (`SETTINGS_KEY`, `:20`). The hook never writes it back. A change in the picker sets in-memory state and `pinned` (`pickModel`, `:120`), and the pick travels in the request as `model` and `modelPinned` (`modelPickBody`, `apps/web/lib/model-choice.ts:50`).

**Source material.** The box is collapsed until `documents-source-toggle` is pressed, or until `value.length > 0` opens it on its own (`source-material-field.tsx:21-22`). Beside it sits `ArtifactPicker` (`apps/web/components/artifact-picker.tsx:35`) with `testId="documents-source-picker"`, which derives `documents-source-picker-toggle` (`:92`), `documents-source-picker-panel` (`:99`) and `documents-source-picker-item` (`:116`). Opening it calls `listArtifacts(mode)` with no mode for **every** mode (`source-material-field.tsx:46-55`, `artifact-picker.tsx:54`), so a Research dossier, a Finance brief and a Legal memo are all pickable. Picking one calls `getArtifact(id)` (`:75`) and drops the whole `body` into `sourceText` (`source-material-field.tsx:50-54`). The web cap `SOURCE_TEXT_MAX_CHARS = 120_000` (`source-material-field.tsx:8`) mirrors the host's (`packages/host/src/job-source.ts:4`). The field only colours the counter red past it (`:87-93`). It does not block.

**Desk files.** `DeskSourcePicker` lists the desk's files through `createFilesApi().list()` (`desk-source-picker.tsx:162`, `apps/web/lib/files-api.ts:141`) and renders nothing until the desk has one or a pick is left to remove (`:186`). `desk-sources-toggle` opens `desk-sources-list` (`DeskSourceList`, `:83`), a checkbox per file (`desk-sources-option`, with `data-path`). There is no panel testid. `desk-sources-hint` always shows, "Up to 5 files", and turns into the "most that fit" sentence at five picks (`:211-215`). A pick shows as a removable `desk-sources-chip` (`desk-sources-remove`) inside `desk-sources-chips` (`DeskSourceChips`, `:41`) that stays visible with the list closed. The sixth pick is disabled, not hidden (`MAX_DESK_SOURCE_FILES = 5`, `apps/web/lib/documents-desk-sources.ts:12`). The picker reads the desk on mount, each time the list is opened (`:198-203`) and each time `refreshKey` changes (`:182-184`). The Documents form bumps `refreshKey` on every focus (`onFocusCapture` bumps `deskRefresh`, `documents-studio.tsx:350`). A read within 4 s of the last one is skipped (`REFRESH_MIN_MS`, `desk-source-picker.tsx:18`). A failed read keeps what the form already shows (`:165-168`). `pruneDeskSources` (`documents-desk-sources.ts:42`) drops a picked path that is no longer on the desk (`desk-source-picker.tsx:171-177`). `deskSourcesOverLimit` (`documents-desk-sources.ts:51`) shows `desk-sources-over` when the picked file bytes plus the pasted characters pass 120k. Bytes stand in for characters there, so the hint only warns early. The request carries the paths, never file text: `sourceFilesBody` (`:62`) adds `sourceFiles` only when something is picked. The picker's strings are `files.deskSources.*` in `apps/web/locales/{en,id}/files.json`.

**The handoff.** Research's action row calls `requestModeHandoff({ target: "documents", sourceText: markdown, prompt: suggestedHandoffPrompt(...), artifactId, title })` and then `router.push(href)` (`apps/web/components/artifact-actions.tsx:63-72`, button `${testIdPrefix}-make-document` at `:100`). `mode-handoff.ts` is deliberately renderer-only: a module-level `pending` map plus a `window` CustomEvent, no router state and no storage (`apps/web/lib/mode-handoff.ts:1-5`, `pending` at `:44`, `requestModeHandoff` at `:47`). `DocumentsStudio` subscribes on mount (`documents-studio.tsx:90-99`). `subscribeModeHandoff` delivers at once if something is already queued and then on the event (`mode-handoff.ts:70-89`), and `takePendingHandoff` **consumes** it (`:56-63`). The suggested prompt is catalogue copy in both locales (`common.modeHandoff.document`, `apps/web/locales/en/common.json:77`), for example `Write a memo from "<title>". Use only the source material and cite its sources.`

### 3. Generate: `POST /api/v1/documents`

`onGenerate` (`documents-studio.tsx:101-134`) trims the prompt, bails if empty, busy or `needsKey` (`:104`), and posts `{ prompt, model, modelPinned?, sourceText?, sourceFiles? }` through `apiFetch` (`:110-120`). A non-OK response becomes `error` through `errorMessage` (`:32-45`), which prefers the hosted `gateway_blocked` sentence, then `payload.error.message`, then the localized `documents.errors.generate`. On a failure `draft` and `checks` are cleared (`:128-129`), so a failed generate also wipes whatever was on screen.

Host side: `router.ts:353` calls `handlePostDocuments` (`packages/host/src/handlers/jobs.ts:185`), which runs `getTenant`, then `requireGatewayAllowedFor(tenant)` before anything else, then `generateDocumentDraft(tenant, body, request.abortSignal)`. `request.abortSignal` is the client disconnect (`packages/host/src/types.ts:55`, set at `packages/host/src/http-adapter.ts:694`).

`generateDocumentDraft` (`packages/host/src/document-generate.ts:228`) in order:

1. `readPrompt` (`:79`) turns a non-string or blank `prompt` into a 400.
2. `requireLiveDocumentRuntime` (`:154`) runs `resolveRuntimeMode` on `hasLiveProvider(settings)` and `AGENTFORGE_RUNTIME`. In `stub` it throws `ApiError("runtime_stub", gatewayRequiredMessage("documents", locale), 503)`. **This is the gate every keyless drive hits**, and it is why the error copy names Settings.
3. `assembleDeskSource` (`packages/host/src/desk-sources.ts:175`) builds the source text, see § 3a.
4. `resolveDocumentModel` (`:166`) takes the body `model`, else `settings.documentGenModel`, else the mode default (`defaults.finance` for a finance job, else `defaults.documents`), resolved against the live catalog by `resolveChatModel`. The default ladder is `["hy3", "deepseek-v4-1-flash", "deepseek-v4-flash"]` (`packages/core/src/models/mode-defaults.ts:65`). Finance's (`:70`) and Market's (`:72`) are the same list, so all three land on `hy3`, which the gateway lists and the probe of 2026-09-30 took at every level, and on `deepseek-v4-1-flash` on a gateway without it ([`model-policy.md`](model-policy.md) § 7). `readModelPinned` (`packages/host/src/job-regen.ts:49`) tells the fallback whether the person picked the model: a picked model is never swapped, a seeded default can be.
5. `runChecked` (`document-generate.ts:248`) runs the draft call and the checks, see § 3b. If no attempt ever read as a draft, the held attempt's own `invalid_document` 502 is thrown here (`:291-293`).
6. `buildChecksReport` (`:294`) summarizes the last verdicts, then `persistDraft` (`:177`) saves a `mode: "documents", kind: "draft"` markdown artifact. It is wrapped in try/catch and never fails the job. The artifact `meta` carries `question`, `model` (the model that **answered**, `final.run.model`, which differs from the requested one after a fallback), `finance`, `sourceFiles` (the desk paths, when any) and `checks` (the report, only when a check still fails or a repair was spent, `:298-305`).
7. If that saved, `upsertWorkSource(artifactWorkCard({ type: "Documents", ... }))` files a knowledge work card (`:306-311`, `packages/host/src/work-cards.ts:171`, `packages/host/src/knowledge-ingest.ts:20`).
8. The return is the plain draft when every check passed, else `{ ...draft, checks: report }` (`:312`, type `DocumentDraftResult`, `:200`).

There is no `finance` toggle in the Documents UI. `isFinanceJob` (`:98`) reads a `job: "finance"` body field that only the Finance path sets. It selects `FINANCE_SYSTEM` (`:47`), the finance model default and **no checks and no repair** (`:284-285`).

#### 3a. Assembling the source

`assembleDeskSource` (`desk-sources.ts:175`) is shared with Presentation and Open Slide (`presentation-generate.ts`, `open-slide-generate.ts`) and with the check route. It calls `readSourceText` (`packages/host/src/job-source.ts:38`) for the pasted text: trimmed, capped at 120k with `SOURCE_TRUNCATED_MARKER` appended (`:15-20`), then run through `assertSafeSourceText`, which calls `scanInjection` and throws `injection_blocked` 400 unless the desk set `injectionGuardBypass` (`:23-35`, threaded from `document-generate.ts:236`).

Then `readSourceFilePaths` (`desk-sources.ts:73`) parses the optional `sourceFiles` field. Absent means none. A non-list, a non-string item or a list over `MAX_SOURCE_FILES = 5` (`:25`) is a 400 `invalid_request`. Each item goes through `parseDeskPath`, repeats are dropped, and a path the desk would refuse is a 400 that names it. A body with no `sourceFiles` never touches the file store (`:182-184`).

With paths, it builds a desk root for the caller (`createDeskRoot(tenant, { kind: "user", userId: tenant.userId })`, `:185`, `packages/host/src/desk-files/store.ts:27`) and `readDeskSourceFiles` (`:139`) reads them in the order given. The budget is `SOURCE_TEXT_MAX_CHARS - pasted.length` (`:189`), so pasted text takes its share first. Each file sits under a `=== Desk file: <path> ===` header (`deskFileHeader`, `:28`) that counts against the budget. A file the budget cuts keeps its start and ends with the pasted-text marker (`bodyWithin`, `:124`). A file the budget never reaches is named with `[omitted: the source limit was reached before this file]` and not read (`:150-154`). An empty file says `[this file is empty]`. Every file passes the same injection guard as pasted text (`guardFile`, `:112`), so one flagged file blocks the request with its path in the message. A refused read becomes a 400 `source_file_not_found` or the desk's own refusal code with the mapped status (`refusal`, `:102`; `REFUSAL_STATUS`, `:37`).

The pasted text, the file blocks and nothing else are joined with a blank line into one string (`:192`). That string is what `withSourceMaterial` appends to the user prompt inside `<<<` and `>>>` fences (`job-source.ts:54-59`) and what `withSourceRule` turns into the "use only that material for facts" system sentence (`:7-8`, `:61-63`).

#### 3b. The draft call, the checks and the repair round

`runChecked` (`packages/host/src/harness/run-checked.ts:71`) is the generic stop gate: `produce` makes the output, every check looks at it, and a failure goes back to `produce` as an `ERROR` / `WHY` / `FIX` note (`formatRepairNote`, `:35`) for at most `repairRounds` more tries. Documents sets `repairRounds` from `harnessSpecFor("documents").repairRounds` (`document-generate.ts:285`), which is **1** (`documents.ts:14`). A check that throws counts as a failure, and its message is not passed on (`runOne`, `run-checked.ts:48`).

`produce` (`document-generate.ts:249-283`) keeps two variables outside the loop: `held`, the last reply that read as a draft or else the last reply there was (`:246`), and `lastText`, the raw text a repair quotes back (`:247`). It does this per call:

1. `collectAssistantRun` (`:129`) makes one draft call through `collectJobAssistantRun` (`job-regen.ts:252`) with `jobMode: "documents"`, the system prompt `withSourceRule(documentJobSystemPrompt(finance), sourceText)` and the user prompt `withSourceMaterial(prompt, sourceText)`. On a repair, `withRepairRound` (`:113`) appends the failed reply (cut at 30,000 characters, `REPAIR_PREVIOUS_MAX_CHARS`) and the note to the same prompt. `DOCUMENT_SYSTEM` (`:62`) demands bare JSON, 5 to 8 sections (max 12), finished prose, and bans TBD and lorem filler. `withOutputLanguage` stamps the desk locale on it (`documentJobSystemPrompt`, `:102`). The note itself is fixed English.
2. A call that throws ends in the `catch` (`:262-270`). `throwIfJobAborted(abortSignal)` (`:264`) rethrows a cancel as the job's 499. Any other failure, with a draft already held, logs `document_repair_failed` and returns `held`, so the person keeps the first draft and the checks run on it again. Only the first call can fail the request this way.
3. `throwIfJobAborted(abortSignal)` (`:272`) stops a cancelled request before it is saved.
4. An empty reply returns `held`, or throws `ApiError("generation_failed", ..., 502)` if there is none (`:273-278`). An empty first reply gets no repair.
5. `readAttempt` (`:213`) reads the reply as a draft through `parseDocumentDraft` (`packages/host/src/document-outline.ts:18`). A reply with no JSON object at all fails in the shared outline reader (`extractJsonObject`, `packages/host/src/presentation-outline.ts:101`) as `invalid_outline`, worded for a presentation, so `readAttempt` rewrites it to `invalid_document` 502. `held` becomes the new attempt when it read as a draft or when nothing held read as one (`:281`). A repair that comes back unreadable therefore replaces `held` only if there was no draft to lose.

When nothing ever read as a draft, `generateDocumentDraft` throws the held attempt's own failure (`:291-293`): the first reply's `invalid_document` if the repair call failed or came back empty, the repair reply's if it answered with something unreadable. Both are 502 and nothing is saved.

Three unit tests pin these branches: `keeps the draft it has when the repair comes back unreadable or empty` (`packages/host/src/document-generate.test.ts:493`), `... when the repair call itself fails` (`:507`) and `answers the unreadable first reply's own 502 ...` (`:525`).

Because `jobMode` is set, `applyJobThinking` adds the mode's job knob from the model policy (`jobThinkingExtras`, `packages/core/src/models/job-thinking.ts:30`), the knob Chat deliberately does not use (see [`chat-send.md`](chat-send.md#4-runtime--probe-stream-coerce) and [`model-policy.md`](model-policy.md)).

The checks (`documentChecks`, `packages/host/src/documents-checks.ts:252`) are pure and call no model. **`structure`** (`structureCheck`, `:168`) always runs. It fails when the reply was not a draft, when the draft has more than `MAX_DOCUMENT_SECTIONS = 12` sections (`:17`), when the brief lists N required sections and the draft has fewer, when a heading is blank, or when a body is empty, shorter than `MIN_SECTION_BODY_WORDS = 4` words (`:23`) or holds placeholder text (`lorem ipsum`, `replace this paragraph`, a bare `TBD` that neither the brief nor the source contains, `hasFiller`, `:119`). `requiredSectionCount` (`:75`) finds N by counting the numbered items after a "Required sections:", "Required blocks:", "Bagian wajib:" or "Blok wajib:" marker (`REQUIRED_MARKER`, `:64`), following the numbers 1, 2, 3 in order so a brief pasted into the one-line prompt box with its line breaks lost still counts. All six built-in template cards use that shape (`packages/core/src/templates/library.ts:238-371`). **`grounding`** (`groundingCheck`, `:222`) runs only when the request had source text (`documentChecks` returns it only then, `:253`). It reuses `checkDraftAgainstSource` and flags a section when at least `MIN_UNSUPPORTED_SENTENCES = 2` of its checked sentences are unsupported and those are at least `MIN_UNSUPPORTED_SHARE = 0.75` of them (`findUngroundedSections`, `:200`; thresholds `:37-38`). The comment above them records why the rule is slack: the overlap test cannot tell advice from invention, so only a section that is almost all unsupported is flagged.

When a round ends with failures left, `buildChecksReport` (`:277`) turns the last verdicts into `{ passed, rounds, failures: [{ check, error, sections }] }`, where `sections` are the zero-based sections a grounding failure is about.

#### 3c. What the person sees

The client splits the response with `splitDraftResponse` (`apps/web/lib/documents-desk-sources.ts:107`) into the draft and a `checks` view that `readChecks` (`:85`) validates. `landDraft` stores both (`documents-studio.tsx:83-88`). `DocumentChecksNote` (`apps/web/components/document-checks-note.tsx:10`) renders `documents-checks-note` (with `data-kind` set to `grounding` or `structure`) between the source-check panel and the example gallery (`documents-studio.tsx:322`). `checksNote` (`documents-desk-sources.ts:121`) picks the note: a grounding failure wins because it names sections to act on, and `documents-checks-sections` lists their headings (once each, even if two sections share one). Otherwise a structure failure gives the generic note. Nothing renders when every check passed. The note says the draft is saved, and for grounding it points at the `documents-check` button. The note clears on a starter, a regenerate or a failed generate (`:80`, `:164`, `:129`).

A pass after a repair adds nothing to the response, so the person never sees that a repair was spent. Only the artifact `meta.checks` records it (`document-generate.ts:304`). No Documents code reads `meta.checks` back, and nothing could: the studio never reopens a saved draft. `SourceMaterialField` loads a picked artifact's `body` into the source box as text and nothing else (`apps/web/components/source-material-field.tsx:50-54`), so a saved draft comes back as source material, with no sections and no note. Research does read its own `meta.checks` (`apps/web/components/research-studio.tsx:124`); Documents has no such reader.

#### 3d. Cancel and budget

`generateDocumentDraft` passes `abortSignal` into every draft call (`collectAssistantRun`'s `signal`, `:150`), and `collectJobAssistantRun` checks it before each model call and after a failed one (`job-regen.ts:255`, `:274`). The signal then reaches the runtime as `signal` on `execute` (`job-regen.ts:210`), where `linkCallerAbort` aborts the request in flight (`packages/core/src/runtime/ai-sdk-runtime.ts:146`, used at `:675`). A cancelled job is the job's own 499 `aborted` (`throwIfJobAborted`, `packages/host/src/job-stream.ts:19`), not the signal's raw reason, and it is thrown past the model fallback so no stand-in retries it. A cancel that lands during a repair call is still that 499 and not a kept draft: the `catch` in `produce` checks the signal before it falls back to `held` (`document-generate.ts:264`, test `still cancels with 499 when the person leaves during the repair call`, `document-generate.test.ts:534`). Each run also takes the mode spec's budget: `runJobAssistantOnce` looks up the spec from `jobMode` and passes `spec.budget` to `execute` (`job-regen.ts:184`, `:207`). For Documents the budget is `DEFAULT_RUN_BUDGET` (`packages/core/src/harness/defaults.ts`, 6 steps and 60 tool calls) and the mode binds no tools, so it bounds nothing today.

### 4. Preview

`DocumentPreview` (`apps/web/components/document-preview.tsx:18`) renders `documents-preview` (`:30`), the title, and one `documents-section` per entry (`:38`). Each section gets a `documents-regen` toggle (`:48`, suppressed when no `onRegenerate` prop is passed) and its body through `FormattedText` (`:54`), the same markdown renderer Chat's `message-output` uses. Only one panel is open at a time: `openIndex` is local to the preview (`:25`, `:45`).

**Starters** are the keyless path. `documents-starter` buttons (`documents-studio.tsx:326-344`) come from `documentStarters()` (`apps/web/lib/job-starters.ts:415`), which builds two fully localized drafts from locale keys: `status-memo` with 5 sections and `one-pager` with 6. Clicking one runs `showStarter(starter.draft)` (`documents-studio.tsx:77`; it sets the draft and clears `sourceCheck` and `checks`) and clears the error (`:335`). No network call, no model, no artifact.

**Template cards** are a different thing. `ExampleGallery mode="documents"` (`:324`, component at `apps/web/components/example-gallery.tsx:12`) shows `example-gallery` / `example-card` / `example-result` from the 6 Documents entries in `packages/core/src/templates/library.ts`. `onSelect` only does `setPrompt(entry.prompt)`. A card never produces a draft.

### 5. Regenerate one section: `POST /api/v1/documents/regenerate`

`JobRegenPanel` (`apps/web/components/job-regen-panel.tsx`, mounted at `document-preview.tsx:56-65` with `testIdPrefix="documents"`) is shared with Finance, Market and Presentation, so every testid is derived: `documents-regen-panel` (`:118`), `-regen-prompt` (`:135`), `-regen-model` (`:143`, via `ModelSelect`), `-regen-file` (`:156`, an `sr-only` file input), `-regen-attach` (`:186`) and `-regen-submit` (`:202`). The Cancel button at `:190-197` has **no testid**.

`onRegenerate` (`documents-studio.tsx:136-171`) posts the **whole current draft** plus `sectionIndex`, the studio `prompt`, the panel `instruction`, the panel model (falling back to the studio model, `regenModelPick`), uploaded `attachments`, `sourceText` and the picked `sourceFiles` (`:147-156`). The response replaces the entire draft and clears `checks` (`:162-164`), because the flags named sections of the draft that was just changed.

`regenerateDocumentSection` (`document-generate.ts:334`) re-validates that draft with `parseDocumentDraftBody` (400 on a bad shape, `document-outline.ts:70`) and range-checks `sectionIndex` (`readSectionIndex`, `:323`). It re-runs the same runtime gate and model resolution, assembles the source the same way (`assembleDeskSource`, `:353-355`), and builds a prompt that carries the original topic, the document title, the **other** section headings as context, and the current heading and body to rewrite (`:356-370`). `SECTION_SYSTEM` (`:315`) asks for `{heading, body}` only. `mergeDocumentSection` (`document-outline.ts:62`) returns a new draft with that one index replaced, immutably, via `map`. The call takes the request's `abortSignal` (`:383`). **It runs no checks and no repair**, so a rewrite that fails is simply an error and the draft on screen is untouched.

**It does not persist.** Unlike `generateDocumentDraft`, this function returns the merged draft and never calls `persistDraft` or `upsertWorkSource`, so the saved artifact and the knowledge work card keep the pre-rewrite text. See Gotchas.

### 6. Download: `POST /api/v1/documents/docx`

`onDownload` (`documents-studio.tsx:173-209`) posts the draft as the bare body, reads the response as a `Blob`, takes the filename from `Content-Disposition` (`:195-197`), and clicks a synthetic `<a download>` (`:198-203`). In the packaged app `apiFetch` has already written the bytes through the native save dialog, so it returns before that (`:189-193`).

`handlePostDocumentsDocx` (`packages/host/src/handlers/jobs.ts:207`) is the odd one out: **no `getTenant`, no `requireGatewayAllowedFor`**. It parses the body with `parseDocumentDraftBody` (400 on a bad shape) and returns a `type: "bytes"` result with the OOXML content type and a filename.

`buildDocumentDocx` (`packages/host/src/document-docx.ts:31`) uses the `docx` npm package directly: a `HeadingLevel.TITLE` run in Calibri 24pt `#0D2137`, then per section a `HEADING_1` run in 14pt `#1565C0` and the body split on blank lines into spaced paragraphs. `safeFilename` (`:5`) strips non-word characters, collapses whitespace to `-`, truncates at 60 characters and falls back to `document.docx`. The document `creator` is `resolvedProductName()` (`:52`), so packaged brands stamp their own name.

This is **not** `packages/core/src/docx/*`. That toolkit reads, diffs and validates `.docx` for Edit and Legal. The Documents job has its own small writer in the host.

### 7. Check against the source: `POST /api/v1/documents/check`

`onCheck` (`documents-studio.tsx:211-236`) posts `{ draft, sourceText, sourceFiles? }`. `handlePostDocumentsCheck` (`packages/host/src/handlers/documents-check.ts:9`) parses the draft, runs `getTenant`, assembles the source with `assembleDeskSource` and `injectionGuardBypass: true` (no model reads this text, so the guard protects nothing here), and returns `checkDraftAgainstSource(draft, source.text)`. It has **no gateway gate**, so it works on a stub desk and on a closed gate. The panel `documents-source-check` lists `documents-source-supported` and `documents-source-unsupported` rows (`documents-studio.tsx:294-320`), or `documents-source-check-empty` when there is no source. The generate-time `grounding` check and this button share one overlap function, so a section the note flags will show unsupported sentences here.

### 8. Enhance

`EnhancePromptButton` (`apps/web/components/enhance-prompt-button.tsx`) posts `{ text, surface: "documents", model }` to `/api/v1/prompts/enhance` (`:85`) and applies the result to `prompt`. It is the **only Documents control that works without a gateway key** on a desk: off server mode a stub runtime answers with canned text before the gate (`packages/host/src/handlers/enhance-prompt.ts:49-51`), and the hosted server never stubs, so there it is gated like the rest. Its testid flips from `documents-enhance` to `documents-enhance-revert` after it applies (`:136`).

### Failure modes

| Failure | Where | What the client gets |
|---|---|---|
| Gate closed | `requireGatewayAllowedFor`, `packages/host/src/handlers/jobs.ts:189` (generate) and `:200` (regenerate) | HTTP 403 `gateway_blocked` on generate and regenerate. **`/documents/docx` and `/documents/check` have no gate** |
| No gateway key (stub) | `requireLiveDocumentRuntime`, `packages/host/src/document-generate.ts:154` | HTTP **503** `runtime_stub`, message naming Settings, rendered in `documents-error` |
| Blank or missing `prompt` | `readPrompt`, `:79` | HTTP 400 `invalid_request`. Unreachable from the UI, because `documents-generate` is disabled on a blank prompt (`documents-studio.tsx:405`) |
| `sourceText` not a string | `readSourceText`, `packages/host/src/job-source.ts:46-48` | HTTP 400 `invalid_request` |
| `sourceFiles` not a list of strings, or over five | `readSourceFilePaths`, `packages/host/src/desk-sources.ts:81-86` | HTTP 400 `invalid_request` |
| A source file is not a desk path | `readSourceFilePaths`, `:90-93` | HTTP 400, the desk's refusal code, naming the path |
| A source file is not on the desk | `refusal`, `desk-sources.ts:102` | HTTP 400 `source_file_not_found`. Other desk refusals keep their code with the status in `REFUSAL_STATUS` (`:37`), for example 413 `too_large` and 503 `root_unavailable` |
| Pasted text or a file trips the injection guard | `assertSafeSourceText`, `job-source.ts:23-35`; `guardFile`, `desk-sources.ts:112` | HTTP 400 `injection_blocked`, naming the rule and the Settings bypass (and the file path for a file) |
| Source over 120k | `capSourceText`, `job-source.ts:15-20`; `bodyWithin`, `desk-sources.ts:124` | No error. Pasted text is truncated with `[source material truncated at cap]`, a file is cut the same way or left unread and named |
| Model returns nothing | `document-generate.ts:273-278`, `:385-387` | HTTP 502 `generation_failed` for an empty first reply or an empty section rewrite. An empty repair reply keeps the first draft |
| The repair call throws (gateway 502, fallback spent, socket error) | `produce`'s `catch`, `document-generate.ts:262-270` | No error when a draft is held: it is kept, `document_repair_failed` is logged, the response carries its failing `checks`. With nothing held, the first reply's `invalid_document` 502 |
| Model returns non-JSON or a bad shape | `parseDocumentDraft` / `parseDocumentSection`, `document-outline.ts:18`, `:40`; `readAttempt`, `document-generate.ts:213` | HTTP **502** `invalid_document` only when no attempt, first or repair, read as a draft. A section rewrite has no repair, so it is 502 at once |
| A check still fails after the repair | `buildChecksReport`, `documents-checks.ts:277` | No error. The draft is saved, the response carries `checks`, and `documents-checks-note` shows |
| `sectionIndex` out of range | `readSectionIndex`, `document-generate.ts:323`; `mergeDocumentSection`, `document-outline.ts:62` | HTTP 400 `invalid_request` |
| Draft posted to `/docx` or `/check` fails the schema | `parseDocumentDraftBody`, `document-outline.ts:70` | HTTP 400 `invalid_request` |
| The person cancels | `throwIfJobAborted`, `job-stream.ts:19`; `document-generate.ts:264`, `:272`, `:287` | HTTP 499 `aborted`. The in-flight model request is aborted and nothing is saved. A cancel during a repair call is this, not a kept draft |
| Artifact store rejects the draft | `persistDraft`, `document-generate.ts:177` | Nothing. It is caught, logged as `document_draft_not_saved`, the job still succeeds and the work card is skipped |
| Any generate failure | `documents-studio.tsx:127-130` | `draft` and `checks` are set to `null`, so the preview on screen is destroyed too |

## Where things live

| File | Role |
|---|---|
| `apps/web/components/documents-studio.tsx` | The whole mode: state, four fetches, error row, check panel, checks note, starters, generate bar |
| `apps/web/components/document-preview.tsx` | `documents-preview` / `-section` / `-regen`; mounts the shared regen panel |
| `apps/web/components/desk-source-picker.tsx` | The desk-file picker, shared with Presentation: `desk-sources*`. `documents-desk-sources.tsx` is gone |
| `apps/web/lib/documents-desk-sources.ts` | Pure rules the picker uses (`toggleDeskSource`, `pruneDeskSources`, `deskSourcesOverLimit`), `sourceFilesBody`, and `splitDraftResponse` / `checksNote` for the checks view |
| `apps/web/components/document-checks-note.tsx` | `documents-checks-note`: what the checks still found after the repair |
| `apps/web/components/job-regen-panel.tsx` | Shared section-rewrite composer; all `*-regen-*` testids derive from `testIdPrefix` |
| `apps/web/components/source-material-field.tsx` | The `sourceText` box and its 120k counter |
| `apps/web/components/artifact-picker.tsx` | "Use a saved artifact..." dropdown; `<testId>-toggle` / `-panel` / `-item` |
| `apps/web/lib/mode-handoff.ts` | Renderer-only Research to Documents bus (module `pending` plus CustomEvent) |
| `apps/web/components/artifact-actions.tsx` | The "Make a document" button that fires the handoff |
| `apps/web/components/work-mode-keep-alive.tsx` | Why `/documents` has a `null` route and why hidden panes stay in the DOM |
| `apps/web/lib/job-starters.ts` | `documentStarters()`, the two keyless drafts |
| `apps/web/lib/document-outline.ts` | Renderer-side mirror of the draft schema (types only) |
| `apps/web/lib/use-job-model.ts` | Job-mode model list and seed (`documentGenModel`) |
| `packages/core/src/templates/library.ts` | The 6 Documents example cards |
| `packages/core/src/models/mode-defaults.ts` | The `hy3`, `deepseek-v4-1-flash`, `deepseek-v4-flash` default ladder shared with Finance and Market |
| `packages/core/src/harness/modes/documents.ts` | The mode's declared harness: pipeline, no tools, budget, `repairRounds: 1` |
| `packages/core/src/documents/source-check.ts` | `checkDraftAgainstSource`, the overlap function the check route and the grounding check share |
| `packages/host/src/router.ts:353-356` | The four route registrations |
| `packages/host/src/handlers/jobs.ts:185-221` | Generate, regenerate and docx handlers; the docx one has no gate |
| `packages/host/src/handlers/documents-check.ts` | The ungated source-check handler |
| `packages/host/src/document-generate.ts` | System prompts, runtime gate, model resolution, generate with checks, regenerate, artifact persist |
| `packages/host/src/documents-checks.ts` | The `structure` and `grounding` checks and the report the response and artifact carry |
| `packages/host/src/harness/run-checked.ts` | The generic check-and-repair loop |
| `packages/host/src/desk-sources.ts` | `assembleDeskSource`: pasted text plus up to five desk files under one ceiling and one guard |
| `packages/host/src/document-outline.ts` | zod schema, JSON parsing, immutable section merge |
| `packages/host/src/document-docx.ts` | `buildDocumentDocx`, the only DOCX writer this mode uses |
| `packages/host/src/job-source.ts` | `sourceText` read, cap, injection guard, prompt and system composition |
| `packages/host/src/job-regen.ts` | `collectJobAssistantRun`, the abort and budget hand-off, and the regen instruction and attachment readers |
| `packages/host/src/work-cards.ts` | `artifactWorkCard` / `documentDraftMarkdown` for the knowledge ingest card |

## Gotchas

- **Regenerate never updates the saved artifact.** `generateDocumentDraft` (`packages/host/src/document-generate.ts:228`) persists a `documents/draft` artifact and a knowledge work card (`:298-311`), but `regenerateDocumentSection` (`:334`) ends at `return mergeDocumentSection(...)` (`:388`) with no persist call. Rewrite a section and the artifact the picker offers, and the text the Knowledge Base indexed, are the *pre-rewrite* version. The DOCX the user downloads is built from the in-memory draft, so it will not match either. This is a finding, not design.
- **The check note exists only in the generate response.** The report is saved in `meta.checks` (`document-generate.ts:304`), but nothing in `apps/web` reads it back, and the studio cannot reopen a saved draft to show it on: `SourceMaterialField` (`apps/web/components/source-material-field.tsx:20`) takes a picked artifact's `body` as source text only (`onPick`, `:50-54`). A draft that passed after a repair shows nothing at all. The note goes away with the draft on a reload.
- **A kept draft after a failed repair looks like any other flagged draft.** When the repair call throws or answers with something unreadable, the first draft goes out with its failing `checks` and `documents-checks-note` shows. Nothing on screen says a repair was tried and failed. The host log has `document_repair_failed` (`document-generate.ts:268`), and `meta.checks.rounds` is 1.
- **`/api/v1/documents/docx` has neither a tenant nor a gate** (`packages/host/src/handlers/jobs.ts:207`). That is what makes the starter to download path work in stub, which is exactly what `features/documents.md` asks you to prove. But a desk whose gateway gate is closed can still produce `.docx` files, unlike every other job-mode download. `/documents/check` is ungated too, but it does look up the tenant (`documents-check.ts:16`), because it can read desk files.
- **A failed generate destroys the preview.** The `catch` of `onGenerate` (`apps/web/components/documents-studio.tsx:101`, catch at `:127-130`) does `setDraft(null)` and `setChecks(null)` before setting the error. A user who loaded a starter, then typed a topic and pressed Generate without a key, loses the starter draft and gets an error. The `catch` of `onRegenerate` (`:136`, catch at `:165-167`) does *not* clear the draft, so the two paths disagree.
- **`needsSettingsHint` is a no-op.** `documents-studio.tsx:47-49` tests a regex and returns `message` on both branches. The live behaviour comes from the separate condition at `:281`, which appends a Settings `<Link>` only when the message mentions a gateway **and does not already mention "settings"**. The `runtime_stub` copy always says "Settings", so on this desk that link never renders. It is a dead branch and an unclickable hint.
- **`documents-prompt` is an `<input type="text">`** (`:385-394`), yet template cards prefill it with a 1,300-character multi-paragraph brief. The DOM strips newlines from an input's value, so the brief arrives as one run-on line ("...bukan kerangka.Peran: kepala staf..."). The same applies to `research-prompt`, `images-studio-prompt`, `videos-studio-prompt` and `data-prompt`. `presentations-prompt` is a `<textarea>` now. That is why `requiredSectionCount` counts numbers and not lines (`documents-checks.ts:75`).
- **A picked desk file is read when the request is sent, not when it is picked.** A file deleted in between makes the request a 400 `source_file_not_found`. The picker prunes a path that is gone on the next desk read (`pruneDeskSources`), but the read is throttled to once per 4 s and runs on mount, on open and on form focus, so a request sent right after a delete can still fail.
- **The picker's testids are not Documents-prefixed.** `desk-sources`, `desk-sources-chip` and the rest are shared with Presentation, and both panes stay mounted once visited, so a bare `getByTestId("desk-sources")` can match two elements. Scope it to `documents-studio`. The hint and the over-limit line are `desk-sources-hint` and `desk-sources-over`.
- **Hidden keep-alive panes keep their testids.** `work-mode-keep-alive.tsx:87` hides inactive panes with `hidden` and `className="hidden"`, so `documents-studio` still has count 1 while you are on `/chat`. Any "mode X is not visible" assertion must check visibility, not count.
- **The artifact picker is not scoped to Documents.** `SourceMaterialField` mounts `ArtifactPicker` with no `mode` prop (`source-material-field.tsx:46-55`), so `listArtifacts()` returns every mode's artifacts. That is intentional, because a Research dossier is the main thing you want here, but the picker's contents depend on unrelated modes' history.
- **The handoff is consumed once and does not survive a reload.** `takePendingHandoff` deletes the entry (`mode-handoff.ts:56-63`) and the whole bus is a module-level variable (`:44`). If the user reloads between "Make a document" and the pane mounting, the source material is gone. The file header states this as a deliberate tradeoff (`:1-5`): panes stay mounted, so no router state or storage was needed.
- **The 120k cap truncates without an error.** `capSourceText` appends `[source material truncated at cap]` and returns (`job-source.ts:15-20`). The only signal is the field's red counter and `desk-sources-over`. A desk file is cut or left unread the same quiet way, so a long pasted block can starve every file (`desk-sources.ts:150-154`).
- **Schema failures are 502s, not 400s.** `parseDocumentDraft` and `parseDocumentSection` throw `invalid_document` at 502 (`document-outline.ts:20`, `:27`, `:32`), while `parseDocumentDraftBody`, the one that reads a *caller-supplied* draft, throws `invalid_request` at 400 (`:74`). Same zod schema, different blame.
- **The model setting is shared, and the bar does not write it.** `apps/web/lib/use-job-model.ts:20-29` maps `documents`, `finance`, `market`, `legal` and `meeting` all onto `documentGenModel`, so they all seed from one saved field. The Documents picker never writes it (no `apps/web` code posts `documentGenModel`; the host accepts it at `packages/host/src/handlers/settings.ts:314`), so a pick made here changes nothing for Finance.
- **Documents offers the whole chat catalogue.** `documents` is one of `CHAT_CATALOG_MODES` (`packages/core/src/models/mode-catalog.ts:22`), and the host sends that list once, not per mode (`packages/host/src/selectable-models.ts:245-250`). There is no Documents-specific catalog.

## Verify

`.cursor/skills/verify-agentforge/features/documents.md` covers the sub-features `documents-rail`, `documents-shell`, `documents-starter`, `documents-studio-model`, `documents-enhance`, `documents-regen`, `documents-source`, `documents-desk-files` (a recipe name; the testids are `desk-sources*`), `documents-check`, `documents-checks-note` and `documents-download`. The Documents slice of `.cursor/skills/verify-agentforge/features/templates.md` covers `example-gallery` / `example-card` / `example-result` / `example-prefills-prompt`.

DOM testids that prove it:

| testid | Source |
|---|---|
| `mode-documents` | `apps/web/components/app-rail.tsx:321` (built from the template `mode-${mode.href.slice(1)}` in the job-modes `map`) |
| `documents-studio` | `apps/web/components/documents-studio.tsx:242` |
| `documents-check`, `documents-download` | `documents-studio.tsx:256`, `:265` |
| `documents-error` | `documents-studio.tsx:278` |
| `documents-source-check`, `documents-source-supported` / `-unsupported`, `documents-source-check-empty` | `documents-studio.tsx:297`, `:304`, `:315` |
| `documents-starter`, `documents-studio-prompt-bar`, `documents-prompt`, `documents-generate`, `documents-needs-key` | `documents-studio.tsx:337`, `:351`, `:392`, `:407`, `:412` |
| `documents-studio-empty` | `apps/web/components/studio-empty-desk.tsx`, whose root carries `${mode}-studio-empty`; mounted at `documents-studio.tsx:421` |
| `documents-studio-model` | `documents-studio.tsx:373` via `apps/web/components/model-select.tsx:64` |
| `documents-enhance` / `documents-enhance-revert` | `documents-studio.tsx:382` via `apps/web/components/enhance-prompt-button.tsx:136` |
| `documents-preview`, `documents-section`, `documents-regen` | `apps/web/components/document-preview.tsx:30`, `:38`, `:48` |
| `documents-regen-panel`, `-regen-prompt`, `-regen-model`, `-regen-file`, `-regen-attach`, `-regen-submit` | `apps/web/components/job-regen-panel.tsx:118`, `:135`, `:143`, `:156`, `:186`, `:202` |
| `documents-source`, `-source-toggle`, `-source-title`, `-source-clear`, `-source-text` | `apps/web/components/source-material-field.tsx:28`, `:36`, `:41`, `:65`, `:84` |
| `documents-source-picker`, `-source-picker-toggle`, `-source-picker-panel`, `-source-picker-item` | `source-material-field.tsx:48` via `apps/web/components/artifact-picker.tsx:85`, `:92`, `:99`, `:116` |
| `desk-sources`, `desk-sources-toggle`, `desk-sources-hint`, `desk-sources-over` | `apps/web/components/desk-source-picker.tsx:193`, `:207`, `:211`, `:231` |
| `desk-sources-list`, `desk-sources-option` (with `data-path`) | `desk-source-picker.tsx:88`, `:106` |
| `desk-sources-chips`, `desk-sources-chip`, `desk-sources-remove` | `desk-source-picker.tsx:49`, `:56`, `:65` |
| `documents-checks-note` (with `data-kind`), `documents-checks-sections` | `apps/web/components/document-checks-note.tsx:28`, `:33` |
| `example-gallery`, `example-card`, `example-result` | `apps/web/components/example-gallery.tsx:19`, `:29`, `:50` |
| `research-actions-make-document` | `apps/web/components/artifact-actions.tsx:100` (prefix-derived), the handoff entry point |

Keyless proof stops at: starters (2), 5 and 6 sections, regen panel, regen **503**, DOCX **200** (real ZIP), generate **503**, enhance **200**, and the check route (**200** with `documents-source-check`). The desk-file picker needs a file on the desk, which a keyless drive can create. A live draft, a repair round and the checks note need doctor `runtime: "ai"`. The check logic itself is pinned by `packages/host/src/documents-checks.test.ts` and `packages/host/src/desk-sources.test.ts`; the picker by `apps/web/lib/desk-source-picker.test.tsx` (it also asserts the two old components and their testids are gone and that both studios mount the picker once), `apps/web/lib/documents-desk-sources.test.ts` and `apps/web/lib/documents-desk-sources-render.test.tsx`. The repair branches (a repair that is unreadable, empty or throws) are pinned by `packages/host/src/document-generate.test.ts:493-532`.

## Why

**Why `/documents` renders through a `null` route.** `[Direct]` the comment at `apps/web/src/App.tsx:388`: "Work modes render via WorkModeKeepAlive; null here avoids double-mount." `[Direct]` the header comment on `apps/web/components/work-mode-keep-alive.tsx:40-48` gives the motive: keep visited panes mounted "so in-flight UI/SSE state survives rail switches", and it records that the active pane is one scrollport, so every mode except Chat and Edit scrolls the pane and Documents grows rather than adding a second bar. Confidence: high.

**Why the handoff is a module variable and a window event rather than router state or storage.** `[Direct]` the file header at `apps/web/lib/mode-handoff.ts:1-5`: "Modes stay mounted (WorkModeKeepAlive), so a module-level pending payload plus a window event is enough: no router state, no storage." The cost, a reload loses the payload, follows from the mechanism. `[Inferred]` nothing records that it was weighed. Confidence: high for the decision, medium for it having been weighed.

**Why source material carries an injection guard at all.** `[Direct]` the comment at `packages/host/src/job-source.ts:22`: "Same guard chat applies to attachments; source material goes straight into the prompt so it must pass too." `[Supported]` the bypass is the same desk-level `injectionGuardBypass` switch the chat attachment path reads, threaded in at `packages/host/src/document-generate.ts:236` and `:354`. A desk file passes the same guard, with its path in the message (`desk-sources.ts:112`). Confidence: high.

**Why a draft that fails its checks ships flagged instead of failing.** `[Direct]` `packages/core/src/harness/modes/documents.ts:4-8`: "a failure gets one repair round and then ships flagged". `[Direct]` the plan line "Done is a check that passes, never the model's word. A failed check comes back to the model as a repair note." (`docs/internal/mode-harness-tools-plan.md:5`). `[Inferred]` the flag-and-ship half protects the person's time: the grounding rule is deliberately slack (`documents-checks.ts:25-36`) because the overlap test cannot tell advice from invention, so a hard refusal would reject drafts a person would accept. Confidence: medium.

**Why a repair call that fails keeps the first draft.** `[Direct]` the comment above `held` in `packages/host/src/document-generate.ts:242-245`: "A repair that fails, comes back empty or comes back unreadable must not cost them that draft; only the first call may fail the request, as in Research and Meeting." `[Supported]` Meeting does the same for its minutes (`meeting/run.ts:303-311`, [`meeting-minutes.md`](meeting-minutes.md) § 5). `[Inferred]` the person has already waited for one full draft, and a second model call that fails says nothing about the first. Confidence: high for the rule, medium for the reason.

**Why Documents and Finance resolve to the same model.** `[Direct]` `packages/core/src/models/mode-defaults.ts:65`, `:70` and `:72` declare the same preference ladder for Documents, Finance and Market: `hy3`, `deepseek-v4-1-flash`, `deepseek-v4-flash`. `[Supported]` `docs/product-modes.md` describes the Documents default as "a cheap writing default (`hy3`, which is live and was probed on 2026-09-30, else `deepseek-v4-1-flash`, then `deepseek-v4-flash`)". `[Supported]` `features/documents.md` records the operational consequence, the quiet drafting phase and the 240 s / 180 s watchdog floors, and [`chat-send.md`](chat-send.md#why) records why `QUIET_REASONING_FAMILY` had to be widened for exactly this model. Confidence: high.
