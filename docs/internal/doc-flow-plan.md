# Add files, get answers: Legal, Finance and Meeting

Rizky asked for this on 2026-10-05: "Let the client add the docs, then extract the information, and that's it. The AI needs better harness judges."

The plan covers Legal, Finance and Meeting in one pass. Legal accepts Word and PDF. The design was read against GitHub `main` at 996bce4 on branch `feat/doc-flow-2026-10-05` (worktree `C:\Users\rizky\agentforge-docflow`). No code is written yet: owner decisions come first (see the end).

## What the code does today

- **`runChecked` is the seam to build on.** It is the generic stop gate (`packages/host/src/harness/run-checked.ts:71-86`). Checks use `CheckVerdict` / `OutputCheck` (`packages/core/src/harness/spec.ts:32-45`). A failed check becomes an ERROR / WHY / FIX note (`run-checked.ts:35-41`). Meeting, Research, Documents and Presentation already use it; Finance and Legal run their own loops.
- **Checks are duplicated across modes:**
  - quote normalisation: docx `normalizeForSearch` (`packages/core/src/docx/text.ts:70-90`, private);
  - Meeting `dateSaid` (`packages/core/src/meeting/ground.ts:36`) and `figureSaid` (`ground.ts:31`);
  - Documents `sourceHasNumber` (`packages/core/src/documents/source-check.ts:28`);
  - `findDateTimeMentions`, which lives in host (`packages/host/src/meeting/minutes-checks.ts:171-338`);
  - the Finance number guard (`packages/core/src/finance/number-guard.ts:114-184`), already reused by Legal verify (`packages/core/src/legal/verify.ts:11`).
- **Legal is .docx only, enforced in three places:**
  - the client (`apps/web/lib/legal-client.ts:17-21`, `:327-338`; `legal-studio.tsx:71-78`);
  - the host sniff (`packages/host/src/legal/store-files.ts:162-177`);
  - the stored path (`store-files.ts:61-63`) and the docx parse (`store.ts:194`).
- **Legal needs both party names before the first upload:** `apps/web/lib/legal-view.ts:104-116`, `legal-studio.tsx:134-137`, `packages/host/src/legal/input.ts:26,40-51`.
- **Finance:**
  - `/finance` with no task shows a chooser (`finance-studio.tsx:62`, `finance-studio-view.tsx:127-133`).
  - Import is free and not gated (`handlers/finance-import.ts:287-316`).
  - Parse is gated (`handlers/finance.ts:48-52`).
  - The brief parse can make two model calls (`finance-parse-figures.ts:155,172`). Ratios (`parse-ratios.ts:159`) and budget (`parse-budget.ts:168`) can call the model too.
  - One narrative can fan out into many calls (`runner.ts:251`, `finance-section-repair.ts:73,113`, `direction.ts:102-108`).
- **Meeting:**
  - It needs a create form first (`meeting-studio.tsx:691-724`).
  - It always translates (`meeting-studio.tsx:596`).
  - The host already reads a `translate` flag (`meeting/run.ts:461`).

## 1. Shared judges (lane L0)

New folder `packages/core/src/harness/judges/`, exported as subpath `"./judges"` in `packages/core/package.json`. Every function is pure and makes no model call.

| File | Exports |
|---|---|
| `normalise.ts` | `normaliseForMatch(text, {foldCase?}) → {value, offsets}`, generalised from `docx/text.ts:70-90` |
| `quote.ts` | `matchQuote(quote, sources:{id,text}[], preferId?)` → `{sourceId,start,end,mode}` or `null` (`mode` is exact, normalised, case-folded or elided); `windowAround`; `QUOTE_MIN_CHARS = 12` |
| `numbers.ts` | re-exports `extractNumbers`, `matchesAllowed`, `isFreeNumber`; adds `amountsIn(text, locale)` and `numbersTraced(claim, evidence, locale)`. Reuses `expandMagnitudes`, `stated-facts.ts:45-58` and `maskXrefs`, so "§7.2" is not read as 7.2 |
| `dates.ts` | `findDateTimeMentions`, moved from host `minutes-checks.ts:171-338`; `isoDateOf`; `datesTraced`; `durationMonths` (en and id units) |
| `conflicts.ts` | `findConflicts(facts, kindOf, locale)` → `{key,kind,values[]}[]`, with amount tolerance via `matchesAllowed` |
| `coverage.ts` | `coverageGaps(required, items)` |
| `scope.ts` | `scopeHits(text, sources)`: advice phrases (en: `you/the client should|must|ought to`, `we (recommend|advise|suggest)`; id: `sebaiknya`, `disarankan`, `kami sarankan`, `Anda (harus|perlu|sebaiknya)`), and statute citations (`UU No.`, `Pasal … KUHPerdata`, `U.S.C.`) that appear in no source |
| `verdict.ts` | `ItemJudgement`, `judgeCheck(id, judge, words) → OutputCheck`, `outcomeOf → verified | unverified | not-in-sources`, `summarizeVerdicts` (ids and pass/fail only, never text) |

**Normalisation order:**
1. NFKC.
2. Drop `<!-- page N -->` markers.
3. Drop markdown `**`/`__`, backslash escapes and leading bullets; table pipes become spaces.
4. Remove soft hyphens and zero-width characters.
5. Join hyphenated line breaks when the next line starts lower case.
6. Unify quote marks, dashes and ellipses.
7. Collapse whitespace.

**Matching:** exact first, then normalised, then case-folded. A quote with `...` is split into parts of at least 12 characters, which must appear in order within 600 characters.

**Plug-in to `runChecked`:** its options do not change. A mode builds its checks with `judgeCheck`, captures the failing item ids in `onRound` for a targeted repair, then judges once more after the last round to give each item a status.

**Tests:** normalise, quote, numbers (`Rp 1.500.000.000`, `USD 5,000,000`, `§7.2`), dates (`14 Agustus 2026`, `pukul 15.00`, ISO), conflicts, scope (en and id, plus sentences that must not be flagged), verdict.

## 2. Legal

### PDF intake (L1)

- `store-files.ts`:
  - sniff `%PDF-`;
  - `parseLegalFileOrThrow` sends .docx to the docx reader and .pdf to `extractFile` (`packages/host/src/file-extract`);
  - a scan is refused locally as `needs_ocr` (`ApiError` 400);
  - `docFile(dir,id,ext)` stores `files/S1.pdf`;
  - `buildDocCard` takes a `mime`, and old records default to docx.
- New `packages/core/src/docx/plain-document.ts`: `documentFromPlainText(text) → DocxDocument`. Paragraphs come from blank lines and page markers; clause numbers from `detectNumber` (`docx/paragraph-analysis.ts:39`). Page numbers go in a sidecar `parsed/<id>.pages.json`. `splitClauses`, `findQuote` and the review pipeline then work unchanged.
- A PDF draft gets no redline; the run emits `redlineNeedsWord` (`legal/run.ts:481`). The diff runs only between files of the same format.
- The full review returns 400 `parties_required` when no side is set, before any model call (`legal-generate.ts:155-157`).

### Extraction (L1)

- **Route:** `POST /legal/matters/:matterId/extract/stream`, gated. `packages/host/src/legal/extract.ts` exports `generateLegalExtract`.
- **Phases:**
  1. `reading`: code only.
  2. `extracting`: one model call.
  3. `checking`: the judges.
  4. At most one targeted repair.
  5. `saving`: writes `extract.json` in the matter folder, so the delete cascade covers it.
- **Prompt:** `packages/core/src/legal/extract-prompt.ts` (`LEGAL_EXTRACT_SYSTEM`), with `legalUserFacingLanguageInstruction(locale)`.
  - Documents arrive as anchored lines `[S1 ¶12]`.
  - Quotes are exact, contiguous, 8–400 characters, with no ellipsis.
  - A field that is not stated is returned as `status:"missing"`.
  - A fact is stated once per file that states it.
  - Each red flag has `against` and a quote.
  - No advice, no outside law, no numbers that are not in the documents.
- **Large matters:** above roughly 180k characters, code picks passages instead (definitions plus keyword windows in en and id). `scorePassage` (`core/legal/clause-reading.ts:70-80`) is generalised into an exported `passagesForQuery`. Files read this way are marked `partialDocs`.
- **Contract** in `packages/core/src/legal/facts.ts`, delivered first:
  - `LEGAL_FACT_FIELDS`: parties, effective-date, term, payment, liability, termination, governing-law, plus notable.
  - The model response has these fields:
    - `documentType`;
    - `parties[{name,role,quote,docId}]`;
    - `files[{docId,role,reason}]`;
    - `side{party,confidence,quote}|null`;
    - `facts[{field,label,value,status,quote,docId,anchor}]`;
    - `redFlags[{title,why,severity,against,quote,docId,anchor}]`.
  - The stored `LegalExtractRecord` adds:
    - a per-item status: verified, unverified or not-in-documents;
    - `clauseId`, `page`;
    - `conflicts[]`, `coverage[]`;
    - `checks`;
    - `partialDocs`;
    - `side{party|null,ask,candidates[]}`.
- **File roles to `DocRole`, in code through `setRoles`:**
  - A single draft becomes `counterparty-draft`.
  - With a draft and a counter-draft, the counter-draft becomes `counterparty-draft` and the draft becomes `prior-turn`.
  - Signed becomes `executed`. Reference becomes `context`.
- **Checks** (`host/legal/extract-checks.ts`): `legal-shape`, `legal-quotes`, `legal-values`, `legal-coverage`, `legal-scope`. Conflicts are reported by code, not repaired.
- **Side resolution** (`resolveLegalSide`), code only:
  1. A side already on the matter wins.
  2. With at most one party, there is no question.
  3. A high-confidence model pick counts only if its quote verifies and the name matches a detected party.
  4. Otherwise, the desk's last side, if it matches.
  5. Otherwise ask once: up to 4 names, plus "Neither / just reading". The answer is a free PATCH.

### Ask about the documents (L1)

- **Route:** `POST /legal/matters/:id/ask/stream`, gated. `host/legal/ask.ts` makes one call with the question and the top 12 code-chosen passages.
- **Answer:** `{answer, citations[{docId,quote}], notInDocuments}`.
- **Checks:** `legal-answer-cited`, `legal-quotes`, `legal-values`, `legal-scope`; at most one repair. With no verified citation, the answer becomes "not in the documents".
- **Storage:** `asks.json` (capped at 50), read through `GET /legal/matters/:id/asks`. `GET /legal/matters/:id/extract` returns the latest extract.

### Host input

- The create schema accepts an empty `side`.
- New `extractBodySchema` and `askBodySchema` (question of 1–1000 characters, passed through `assertSafeSourceText`).
- Record schemas for the extract and the asks.
- Copy in `output-copy.ts`:
  - `unsupportedFile` becomes "Only Word (.docx) and PDF files…".
  - New phase names: `reading`, `extracting`, `checking`, `answering`.
  - New strings: `needsOcr`, `redlineNeedsWord`, `partiesRequired`.

### UI (L2)

- `legal-studio` takes `data-screen` = new, reading, facts, running or result.
- **Screen, top to bottom:**
  1. One drop zone.
  2. Files, with detected role chips.
  3. Progress.
  4. The side question, if it is needed.
  5. The facts card.
  6. Conflicts.
  7. Red flags.
  8. The ask box.
- **On drop:** `ensureMatter()` (titled after the first file), upload, then `extractJob.run`. That run is skipped under `needsKey`. A stub desk shows the `runtime_stub` frame. Each later drop batch re-extracts once.
- **New components:** `legal-facts-card`, `legal-red-flags`, `legal-ask-box`, `legal-side-question`, `legal-more`.
- **Changed:**
  - `legal-file-list`: no party gate; takes PDF.
  - `legal-matter-panel`: the file list moves out.
  - `legal-client`: `LEGAL_ACCEPT` adds `.pdf`; `isLegalReadableFile`; extract and ask clients with zod; `LEGAL_DOCX_ONLY_MESSAGE` is deleted.
  - `legal-view`: `canUpload` no longer needs parties; `canRunReview`.
- **Under `legal-more`:**
  - the matter panel and all its fields;
  - the matter map and the plan;
  - both model pickers;
  - previous matters;
  - the role cycle;
  - the full review `legal-run`, with memo, redline and deviation report.
- **Testids:**
  - Kept:
    - `legal-shell`, `legal-studio`, `legal-reopen`, `legal-error`, `legal-needs-key`;
    - `legal-file-input`, `legal-drop-zone`, `legal-file-list`, `legal-file-row`, `legal-file-remove-<docId>`;
    - every running and result id.
  - Moved under `legal-more`:
    - `legal-matter-panel` and its fields;
    - `legal-matter-map(-row)`, `legal-plan`;
    - `legal-studio-model`, `legal-studio-verifier-model`;
    - `legal-previous(-row)`, `legal-open-<id>`;
    - `legal-file-role-<docId>`, `legal-run`.
  - Removed: `legal-upload-hint`.
  - New:
    - Shell, reading and side question: `legal-more`, `legal-reading` (with `-round`, `-phase` and `-sources`), `legal-extract-cancel`, `legal-extract-again`, `legal-detected-type`, `legal-file-detected-role-<docId>`, `legal-side-question`, `legal-side-pick-<n>`, `legal-side-pick-none`.
    - Facts: `legal-facts`, `legal-fact-<field>` (`data-status`), `legal-fact-value-<field>`, `legal-fact-quote-<field>`, `legal-fact-source-<field>`, `legal-notable-row`.
    - Conflicts, flags and checks: `legal-conflicts`, `legal-conflict-row`, `legal-flags`, `legal-flag-row` (`data-severity`, `data-against`, `data-status`), `legal-flag-quote`, `legal-checks-note`.
    - Ask: `legal-ask`, `legal-ask-input`, `legal-ask-submit`, `legal-ask-cancel`, `legal-answer-list`, `legal-answer` (`data-status`), `legal-answer-quote`, `legal-redline-needs-word`.
- **Locale keys** (`legal`, en and id):
  - New:
    - `drop.title`, `drop.hint`;
    - `errors.wordOrPdfOnly`, `errors.needsOcr`, `errors.partiesRequired`;
    - `reading.title`;
    - `facts.title`, `facts.fields.*`, `facts.status.{verified,unverified,notInDocuments}`, `facts.source`, `facts.partial`;
    - `conflicts.title`, `conflicts.row`;
    - `flags.title`, `flags.against.{you,them,both,unknown}`;
    - `side.question`, `side.none`;
    - `intakeRole.*`;
    - `ask.*`;
    - `checks.note`;
    - `more.{summary,fullReview,redlineNeedsWord}`;
    - `detected.type`.
  - Deleted: `errors.docxOnly`.
- **Paid:**
  - Drop, upload and read are free.
  - Extraction is 1 call, plus at most 1 repair.
  - The side question is free.
  - Each question asked is 1 call, plus at most 1 repair.
  - The full review runs only on a press.
- **Tests:**
  - core: `facts`, `extract-prompt`, `plain-document`.
  - host:
    - extract (verified, unverified, not-in-documents, conflict, side asked, one repair);
    - extract-checks, ask;
    - store (a PDF fixture; a scan gives `needs_ocr`);
    - run (a PDF draft gives no redline);
    - the legal handlers (create without parties; review refused without them).
  - web: legal-client, legal-view, narrow layout, locale catalog, the facts and ask renders (both locales).

## 3. Finance (the model never produces an amount)

- **Task fit (L4a):** `packages/core/src/finance/task-fit.ts` exports `scoreFinanceTaskFit({figuresText, proseText, sheetNames})`. It is code only:
  - appraisal: `appraisalGridFromText` or `discountRateFromText` plus an outlay;
  - budget: `readBudgetScenario` finds a budget and an actual;
  - cashflow: at least 3 monthly periods plus in/out rows or an opening balance;
  - ratios: `classifyRatioRows` places balance-sheet and P&L rows;
  - brief: the fallback.
  - Confidence is high when the top score is at least 0.7 and leads by at least 0.2.
- **Auto route:** `POST /api/v1/finance/auto`, not gated, like import (`host/finance-tasks/auto.ts`).
  1. Redact.
  2. Score.
  3. In fit order, run the parse with `assists:false`, which skips every model assist.
  4. Build `defaultTaskInput`.
  5. Pass `inputSchema.safeParse`.
  6. Check there is enough to work with: cashflow at least 2 periods, budget at least 1 pair, appraisal an outlay plus 2 flows, ratios at least 1 ratio, brief at least 1 revenue line.
  7. Run `compute`, then `buildReport(computed, EMPTY_PROSE)`. That is a free preview of the KPIs and charts.
  - Response: `{fits, task, input, preview, rowsUsed, unplaced, warnings, pii}`.
- **Paid narrative:** the existing `/finance/stream`.
  - New `call-budget.ts` threads one shared extra call through `askForReading`, `repairUnverifiedSections`, `holdReadingDirection` and the brief path. When the budget is spent, the deterministic fallback runs instead.
  - `compute` stays the only producer of figures, and the guard still runs.
  - New judge: `scopeHits` in `guardNarration` (`narrate.ts:124`). Advice gets the same single rewrite, then the sentence is dropped. This enforces in code the appraisal "no buy/sell/fund directive" rule, which today is in the prompt only (`task-rules.ts:69,72`).
- **UI (L4b):**
  - `/finance` with no task renders `finance-auto.tsx` instead of the chooser.
  - Flow:
    1. Drop.
    2. Import.
    3. `/finance/auto`.
    4. Preview, plus "Looks like: …".
    5. At high confidence, `/finance/stream` runs on its own; otherwise a "Write it up" button.
    6. The task's existing result and export.
  - Under `finance-more`: the chooser, switch-task chips, "Check the rows" (it seeds the draft key and opens `?task=`), the model and the question.
  - `?task=` pages and the rail submenu stay.
  - Testids:
    - New:
      - `finance-auto`, `finance-auto-input`, `finance-auto-drop`, `finance-auto-error`, `finance-auto-sheet`;
      - `finance-auto-fit` (`data-task`, `data-confidence`), `finance-auto-preview`, `finance-auto-rows`, `finance-auto-progress`;
      - `finance-auto-write`, `finance-auto-cancel`, `finance-auto-result`, `finance-auto-switch-<task>`, `finance-auto-check-rows`;
      - `finance-auto-model`, `finance-auto-pii`, `finance-auto-warnings`, `finance-more`.
    - Moved into More: `finance-guide-choices`, `finance-guide-<id>`.
  - Locale keys: `auto.*` and `more`.
- **Paid:**
  - Import, detect, parse, compute and preview are free.
  - The narrative is 1 call, plus at most 1 shared extra call.
  - Switching task, or "Read my numbers" on prose, costs only on a press.
- **Tests:**
  - task-fit, using synthetic shapes rather than `eval/`;
  - auto (`collectJobAssistantRun` mocked to throw);
  - call-budget;
  - the narrate advice guard;
  - finance-gate (`/auto` is not gated);
  - the auto client and render;
  - locale.

## 4. Meeting

- **Host and core (L3a):**
  - Decisions and actions gain `quote` (default `""`) and `evidence?: verified|unverified`, which only code sets.
  - The prompt asks for the exact words where something was agreed or taken on.
  - `meeting/evidence.ts` exports `judgeMinutesEvidence`. The quote must match the transcript; the owner must appear within ±240 characters of it; `due` must be traced in that window.
  - The new check `minutes-evidence` uses the date helpers from `@agentforge/core/judges`.
  - Items still failing after the repair are marked unverified, not dropped.
  - `agree.ts` requires identical quotes, and the translation keeps `quote` verbatim.
  - `translateStoredMinutes`, behind `POST /meetings/:id/translate/stream` (gated, 1 call).
  - `POST /meetings/:id/transcript/file`, not gated, takes:
    - .txt and .md as UTF-8;
    - .vtt and .srt through `transcriptFromCaptions`;
    - .docx and .pdf through `extractFile`;
    - capped at `TRANSCRIPT_MAX_CHARS`.
- **UI (L3b):**
  - `meeting-drop` holds `meeting-file`, which also accepts transcripts.
  - On drop:
    1. Create a meeting titled after the file stem, in the remembered spoken language or the desk locale.
    2. Upload.
    3. `run/stream` or `minutes/stream` with `translate:false`.
  - The result opens on Minutes, showing quotes and unverified markers.
  - `meeting-translate` makes 1 call.
  - Under `meeting-more`:
    - the create form;
    - language, model;
    - the recorder;
    - paste;
    - the remembered "always translate" setting.
  - Testids:
    - New: `meeting-drop`, `meeting-more`, `meeting-translate`, `meeting-translate-default`, `meeting-minutes-evidence` (`data-status`), `meeting-evidence-unverified`.
    - `meeting-checks-list` gains `data-check="evidence"`.
  - Locale keys:
    - `drop.*`, `more`;
    - `translate`, `translateDefault`;
    - `evidence.*`, `checks.kinds.evidence`;
    - `errors.transcriptFile`.
- **Paid:**
  - Transcription costs as it does today.
  - Minutes are 1 call, plus at most 1 repair.
  - Translation costs only on request.
  - Transcript files are free.

## 5. Across all three

- **Personal and hosted:** the flows are the same. Hosted `needsKey` stops only the automatic paid run. PDF on the packed Personal app depends on anydoc or the pdfjs fallback, which is unproven on an installer.
- **New by-id routes:** add all six to `BY_ID_ROUTES` (`packages/host/src/tenancy-harness.test.ts:146`; the assertion is at `:1027-1034`).
- **Harness catalog:** each mode keeps five skills (`mode-skills.test.ts:6-11`).
  - Legal: open-matter, extract-facts, answer-from-documents, review-playbook, deliver-set.
  - Meeting: guard-names becomes quote-the-transcript.
- **Docs to refresh:**
  - Maps: legal-matter-run, finance-parse-and-generate, finance-tasks, meeting-minutes, by-id-routes-and-tenancy-harness.
  - A new map page, harness-judges; then the maps README and the map count in AGENTS.md.
  - Verify recipes: features legal, finance, meeting.
  - `product-modes.md`, `unreleased.md`, the decisions TSV.
  - A "checked" row in the security register for the plain-JSON `extract.json` and `asks.json`. They are like `matter.json`, so this is not new exposure.

## 6. Lanes (no two lanes touch the same file)

| Lane | Scope | Depends on | Days |
|---|---|---|---|
| L0 Judges | `core/harness/judges/*`, `core/package.json` | — | 1.5–2 |
| W Wiring | `host/router.ts`, stub handlers `legal-extract`, `finance-auto`, `meeting-extra` (501 after the tenancy lookup), the tenancy-harness and finance-gate tests | — | 0.5 |
| L1 Legal engine | core legal (facts, extract-prompt, clause-reading, output-copy, schemas), `plain-document`; host legal (store, store-files, records, input, run, extract, extract-checks, ask, generate), handlers | L0, W; `facts.ts` on day 1 | 4–5 |
| L2 Legal UI | `apps/web` legal components, lib, locales, map, recipe | `facts.ts` | 3–4 |
| L3a Meeting engine | core and host meeting, `handlers/meeting-extra` | L0, W | 1.5–2 |
| L3b Meeting UI | `apps/web` meeting components, lib, locales, map, recipe | the L3a schema | 2 |
| L4a Finance engine | `core/finance/task-fit`; host finance-tasks (auto, call-budget, reading, direction, narrate, runner, parse-ratios, parse-budget); section-repair, generate, parse-figures; `handlers/finance-auto` | L0, W | 2.5–3 |
| L4b Finance UI | `finance-auto.tsx`, `finance-studio(-view)`, `finance-auto-client`, locales, maps, recipe | the L4a shape | 2 |
| L6 Integration | `core/harness/modes/{legal,meeting}`, mode-skills test, judges map, maps README, AGENTS.md, unreleased, TSV, register; `ci:local`; live drives | all | 1–1.5 |

**Order:**
1. L0 and W.
2. L1, L3a and L4a.
3. L2, L3b and L4b.
4. L6.

That is about 7–9 working days with 3–4 workers, or 20–25 lane-days in total.

## 7a. Owner answers (Rizky, 2026-10-05). These override the defaults above.

1. **No automatic paid run.** On drop, only the free steps run: upload, local read, the Finance code-only preview, and the Legal file list. The paid step waits for a **Run** button in every mode: Legal extract, Finance write-up, Meeting transcribe or minutes. The button carries a one-line note that it uses the key.
2. **Meeting translation is opt-in:** a `meeting-translate` button, plus a remembered "always translate" setting under More.
3. **Legal reads every file, in full.** Code never picks passages.
   - If the text is too long for one call, split it into several calls, one per file or per chunk, then merge. The result must say what was read; nothing is silently left out.
   - **The user can edit the extracted facts afterwards and add comments:**
     - each fact and red flag can be edited inline;
     - an edited value is marked "edited by you" and keeps the original quote beside it;
     - each item takes a comment thread.
   - Edits and comments are saved in the matter folder (`extract-edits.json`, inside the delete cascade), are free, and survive a re-extract: an edited field is not overwritten. They feed the later full review as user-confirmed facts.
4. **Start now.**
5. **Prompt first (Rizky, 2026-10-05).** Every mode opens on one prompt box with an optional file drop, and no form up front. Examples:
   - Legal: "What should I watch out for in this contract?" plus the files.
   - Finance: "How long does my cash last?" plus the sheet.
   - Meeting: "Minutes and who does what" plus the recording.

   The prompt travels in the Run body as optional `prompt`. It steers the extraction or narrative, never the judges, and with no prompt each mode runs its default. Values the user adds later sit under More, are never required up front, and can be added at any time. Every result is editable under that mode's rules:
   - Legal: edit a fact or flag and comment on it.
   - Finance: regenerate one section; the figures stay computed.
   - Meeting: edit or regenerate an item.

   A regeneration keeps the user's edits.

## 7. Owner decisions (as first posed)

1. Run a paid call automatically on drop, in all three modes. The recommendation is yes, with a one-line note; skip it without a key or on stub; for Finance only at high confidence.
2. "One call per upload" means one generation plus at most one repair or retry, only when a check fails.
3. Finance auto-run skips "confirm every line item before any number is used" (`finance-import.ts:1-4`). The mitigation is the code-only read, showing the rows, and "Check the rows". The confidence threshold and the low-confidence behaviour also need a call.
4. Finance assists are skipped on the auto path, so unplaced brief labels stay "other".
5. Legal PDF limits: no redline from a PDF; diffs only between files of the same format; clause splitting depends on the PDF's numbering.
6. Large Legal matters: code picks passages (one call, may be partial), or the run makes one call per file.
7. A matter no longer needs parties to be created. This relaxes the 0.15.0 finding-2 gate; the full review still requires parties.
8. Meeting translation becomes opt-in (today it promises both languages), and the recorder moves under More.
9. Advice detection: false positives would cost a repair, so the patterns are conservative.
10. Keep or drop the rail's Finance task submenu (default: keep).
11. The Legal role mapping above.
