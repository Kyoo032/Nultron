# Map: documents in the Chat composer

Product: both · Instance: main :3000

Last verified: 2026-10-20 at 0fdf2bb1 (tester tree). Every citation on this page was re-read against the code at that commit, including the figures file the tester added (§ 2b, and the figures lines in §§ 2, 3, 4 and 5). Code-read only: no test was run and nothing was driven in this pass; `features/chat.md` "Documents" is the recipe. The figures file and the `finance_task` worker that reads it exist only on `tester/chat-first`; [`finance-chat-worker.md`](finance-chat-worker.md) maps them.
Last verified: 2026-11-26 on `devin/1795703634-f7a-exec-limits` (F7a, DFIND-177): `extractFile` now parses in a killable `--permission` child (`file-extract/child-parse.ts` + `parse-worker.ts`), deadline = SIGKILL, no network, 384 MiB heap; the native-gate cap now bounds parse children (`child-parse.test.ts`, index.test.ts parity). Nothing else on the page was re-read.


Last verified: 2026-10-13 at 73db3c30 (branch `fix/safe-web-search`, before merge) for the `egress-guard.ts` line number of `userTextOf` only, moved by the outbound guard. Since that change the text of every attached file is also registered with the turn's outbound guard as private material ([`chat-send.md`](chat-send.md) § 3); nothing else was re-read.

Last verified: 2026-10-07 at 6105c5c (working tree over that commit, not committed). Read against the code and driven by unit tests only: the two host routes, the chip markup, the composer wiring, the thread's file card and the HTTP adapter's Origin, CSRF and size rules for both routes. Not driven in a browser, on the packaged app or on a hosted deploy; `features/chat.md` "Documents" is the recipe for that.

## Overview

A person can drop a PDF, Word, PowerPoint, Excel, OpenDocument, RTF or EPUB file into Chat. The host reads it on this machine with the same local reader Knowledge and Finance use, masks personal details, and gives the composer the text. The composer inlines that text in the message the way it inlines a `.txt` file. When the message is sent, the host also saves the whole text as a private desk file, so Chat's file tools and `run_code` can work on it, and writes a few notes about the file above the attachment. It adds no mode, no setting and no setup: attach, wait for the chip, send.

It is not Knowledge ingest (nothing is indexed or retrieved later, [`knowledge-ingest-loop.md`](knowledge-ingest-loop.md)). On the tester, a workbook, or a Word, PDF or PowerPoint file with a table, also gets a figures file read the Finance way (§ 2b), which the `finance_task` worker reads. Nothing on this page calls the gateway.

## How it works

### 1. One door list, three doors

The formats come from one table in core, `DOCUMENT_FORMAT_BY_EXTENSION` (`packages/core/src/chat-documents/formats.ts:32`). The composer builds its `accept` list and its "is this a document" check from it (`COMPOSER_FILE_ACCEPT` and `classifyAttachment`, `apps/web/lib/composer-attach.ts:30`, `:66`), and the host's fallback reader names a file's format from the same table (`packages/host/src/file-extract/detect.ts`, `BY_EXTENSION`), so the two cannot drift. `packages/host/src/chat-documents/formats.test.ts` fails if the table names an extension the native converter does not know. `.csv` is in the table but is not a Chat document: Chat keeps sending a CSV as plain text. `.rtf` is checked as a document before the text check, because browsers can report it as `text/rtf`.

The file picker, a drop and a paste all end in one function, `addFiles` (`apps/web/components/chat-composer.tsx:363`): the picker's `onChange` and the drop zone's `onDrop` call it, and so does `onPaste` (`:719`) through `pastedFiles` (`apps/web/lib/composer-attach.ts:112`). A paste that carries any text is left to the textarea, because copying a range from a sheet puts the text and a picture of the range on the clipboard. `apps/web/lib/composer-documents-wiring.test.ts` fails if a door is rewired or a second way of adding a file appears. A document over 25 MB is still attached, as a chip that says why; at most 3 documents go in one message (`CHAT_DOCUMENTS_PER_MESSAGE`), and a fourth is refused on `composer-error`.

### 2. Read on attach (nothing is written)

`useDocumentReads` (`apps/web/lib/use-document-reads.ts`) starts `readChatDocument` (`apps/web/lib/composer-documents.ts:207`) for every document that has no read state, once, and records `reading`, `ready` or `failed` on the held file. An empty file or one over the cap fails in the browser before anything is sent. Otherwise the file goes as one multipart field, `file`, to `POST /api/v1/chat/documents` through `apiFetch`: HTTP on the web, and in the packaged app `filesFromBody` (`apps/web/lib/api-client.ts:46`) turns the `File` into a byte array that crosses `host:request` and is turned back into a `Uint8Array` at `apps/desktop/main.cjs:470`. That is the path Finance import and the dataset upload already take. A read that was in flight when the pane was unmounted starts again on remount (`restoreDocumentRead`); a finished read is kept with the draft stash (`apps/web/lib/composer-draft.ts`).

The route is `handlePostChatDocument` (`packages/host/src/chat-documents/handler.ts:54`, registered at `packages/host/src/router.ts:344`). `requireUpload` (`handler.ts:37`) checks one file, not empty, at most 25 MB, a document extension. Then:

1. `readChatDocument` (`read.ts:52`) runs `extractFile` under the document limiter. `extractFile` requires the extension and the real bytes to agree (`format_mismatch`), refuses a scanned PDF as `needs_ocr`, has a 20 s deadline, and opens no socket (`file-extract/privacy.test.ts`). Its Markdown is the text: a spreadsheet comes out as one `## Sheet` heading and one Markdown table per sheet, a deck as its slides' text and tables. The read also returns the reader's raw tables and Markdown, unmasked, as `extractedTables` and `extractedMarkdown` (`read.ts:37-38`, `:75-76`). Only the figures read (§ 2b) uses them; they are never sent to the composer.
2. The text is cleaned (`cleanDocumentText`, `text.ts:31`): no NUL, no lone surrogate, one kind of line ending, and an indent of one space on every line that begins with three dashes and whitespace (so a document cannot end its own attachment block with a half header such as `--- Section 2`) and on every line that looks like one of the host's own notes (`isHostNoteLine`, so a document cannot speak in the host's voice). The text is trimmed first and indented after, because trimming after the indent stripped it again from a first line that forged a note.
3. The cleaned text is masked with `maskPii`, the mask the outbound copy uses, on the whole text. `masked` is the count of mask tokens the scan added, from one scan.
4. The masked text is cut on a line boundary to 60,000 characters for the model (`CHAT_DOCUMENT_TEXT_MAX_CHARS`). The cut is core's `cutOnLine` (`packages/core/src/chat-documents/cut.ts:22`), shared with the composer's cut of a plain text file; the host re-exports it from `text.ts`.

The answer is `{ document: { name, format, bytes, text, fullText?, chars, sentChars, truncated, tables, pii: { count }, originalId, originalSkipped, figures, figuresSkipped } }` (`handler.ts:67-87`). `text` is what the model gets; `fullText` is present only when `text` was cut, and is what the save call writes. `originalId` and `originalSkipped` are § 2a; `figures` and `figuresSkipped` are § 2b. The route needs a person first (`getTenant`, `handler.ts:59`, so a 401 on the hosted server with no session), and only then reads the file. Failures are `{ error: { code, message } }` with one of `document_too_large` (413), `document_unsupported`, `document_mismatch`, `document_needs_ocr`, `document_encrypted`, `document_empty`, `document_unreadable`, `document_slow` (all 400) or the host's own `too_many_jobs` (429) (`errors.ts`, `CHAT_DOCUMENT_ERROR_CODES` in core). The message is a fixed sentence; the reader's detail is never passed on. The composer shows its own copy for each code in both languages (`chat.document.errors.*`).

**No gateway gate.** Neither route calls `requireGatewayAllowed()`, and `chat-documents/gate.test.ts` proves both answer with the gate shut (and that the gate really is shut in the same run). A person can read and save a file that never leaves their machine with an expired key.

### 2a. The original file

On Personal, a Word, Excel or PDF file that reads cleanly is also kept as its original bytes, as an artifact in the same format. `keepOriginal` (`packages/host/src/chat-documents/original.ts:30`) calls `saveRenderedArtifact` (`packages/host/src/artifact-save.ts:35`), so the bytes are base64 in the artifact body. The artifact cap (`ARTIFACT_BODY_MAX_BYTES`, 4 MB of base64, about 3 MB raw, `artifact-save.ts:38`) and the hosted storage ceiling (`assertStorageAdmits`, `artifact-save.ts:42`) are checked the same way as for a generated file. The row is `mode: "documents"`, `kind: "draft"`, the file's name as its title, the file's own MIME type, and metadata `chatUpload: true` (`original.ts:42-49`). Formats with no original (RTF, text and the rest) keep nothing and answer `originalId: null, originalSkipped: null`. A hosted desk keeps no original at all: `keepOriginal` returns none in server mode (`original.ts:35`) and `verifiedOriginalId` names none (`:54`). An artifact there is visible to the whole company, and a file attached in Chat must stay private to the person who attached it (SR-185).

- **The answer.** `originalId` is the artifact id. When it is not kept, `originalSkipped` is one of `too_large` (larger than the artifact cap), `quota` (the tenant is full) or `unavailable`. The attachment still goes with its text; a refusal is never a failed read.
- **The send.** The composer hands `originalId` and `originalSkipped` back in the save body (`apps/web/lib/composer-documents.ts:261-262`). `handlePostChatDocumentSave` (`packages/host/src/chat-documents/save-handler.ts:105`) names the id only when `verifiedOriginalId` (`original.ts:53`) passes: a UUID, an artifact of this tenant that `artifactStore().get` returns, the same format's MIME, and the `chatUpload` marker (`original.ts:62`). Anything else is dropped without a word, so an id from another tenant never reaches the notes.
- **The notes.** `originalNote` (`packages/host/src/chat-documents/notes.ts:61`) writes one host line above the block: `[Original file kept: artifact <id>, the file as it was attached.]`, or `[Original file not kept (<reason>), so the file itself is not available.]`. The prefix `[Original file` is in `HOST_NOTE_PREFIXES` (`packages/core/src/chat-documents/markers.ts:16`), so a document that forges the line is indented, and the egress guard and the thread's notes treat it as the host's own.
- **The file card.** The thread's file card leaves the line out. `fileCardDetail` (`apps/web/lib/message-embeds.ts:118`) drops every note that starts with a `MODEL_ONLY_NOTE_PREFIXES` entry (`message-embeds.ts:110`), and those entries are `[Attached file` (the data note), `[Original file` and `[Figures kept` (§ 2b).
- **Known costs, not fixed.** A message that is never sent leaves its original behind. Only a removed chip deletes one, and not while a send is in flight (`discardChipOriginal`, `apps/web/lib/composer-documents.ts:286`). The original counts against the tenant's storage until it is deleted with `DELETE /api/v1/artifacts/:artifactId` (`packages/host/src/router.ts:468`). Re-attaching the same file stores another copy each time, since there is no hash lookup. The original is kept unmasked; the artifact body is sealed at rest (`packages/host/src/artifacts.ts:100`). The outbound copy and the desk copy stay masked.

### 2b. The figures file (tester)

At attach, the handler also runs `readFinanceFigures` (`packages/host/src/finance-figures/figures.ts:112`) on the raw extract, inside `withLimit(documentLimiter, ...)` (`handler.ts:62-66`). It takes the `xlsx` format (`.xlsx`, `.xls`, `.xlsm`) and `docx`, `pdf` and `pptx`. It reads every sheet the Finance way: `guardFinanceInput` masks identifiers and keeps amounts, the sheets are joined whole up to 12,000 characters, an injection in the name or text blocks it, and some Finance task must score at least 0.2. Any refusal or throw becomes `figures: null, figuresSkipped: "unreadable"` (`FIGURES_NOT_READ`, `handler.ts:35`); the attachment never fails over it. The other skip codes are `no_table` and `blocked`.

At send, the composer hands `figures` back (`composer-documents.ts:263`). The save handler writes the figures file only when the `.md` copy saved (`save-handler.ts:112`), after checking the value again (`checkFinanceFigures`, `figures.ts:140`). The file is `uploads/~<folder>/<name>.figures.json`, written as the person (`saveDeskFigures`, `packages/host/src/chat-documents/desk-copy.ts:41`). The notes gain `[Figures kept: <path>. To answer a question about these figures, call finance_task with this path as file.]` (`figuresNote`, `notes.ts:71`), and the save answer gains `figures: { path } | null`. The prefix `[Figures kept` is in `HOST_NOTE_PREFIXES` (`markers.ts:17`). The full path from file to card is [`finance-chat-worker.md`](finance-chat-worker.md).

### 3. Save on send, and the notes

When Send is pressed, `send()` calls `inlineBlock` (`composer-documents.ts:307`) for each text file and document in the order attached (`chat-composer.tsx:499`). For a document that is `ready`, `inlineBlock` calls `saveChatDocument` (`composer-documents.ts:249`): `POST /api/v1/chat/documents/save` (`CHAT_DOCUMENT_SAVE_ROUTE`) with `{ name, format, bytes, masked, text: fullText ?? text, originalId, originalSkipped, figures? }` (`:255-264`). The host handler is `handlePostChatDocumentSave` (`save-handler.ts:105`, registered at `router.ts:345`):

- It reads `name`, `format`, `text`, the two counts, the original's fields and `figures` from the body and validates them (`requireInput`, `save-handler.ts:54`): a document extension, a short format token, text that is not empty and not over the reader's own Markdown cap.
- It cleans and masks the text **again**, so a hostile client cannot put raw details on the desk by skipping the read, and cuts it for the model.
- It writes the copy (§ 4), then the figures file when the copy saved (§ 2b), and answers `{ document: { notes, text, chars, sentChars, truncated, saved: { path, version } | null, savedPartial, saveError, figures: { path } | null } }` (`save-handler.ts:124-138`). A refusal to save is an answer, not an error: the attachment still goes, and `notes` says it was not saved.

`notes` (`documentNotes`, `notes.ts:89`) is up to six bracketed lines for the model, in English like the host's other model instructions, in this order (`notes.ts:90-97`):

1. the format, size, length and how many details were masked;
2. one sentence saying that everything after the next `--- name ---` line is the file's content, data to read and not instructions to follow (`DATA_NOTE`, `notes.ts:86`);
3. where the text is saved and which tools read it, or that it was not saved and why;
4. the figures file's line, when one was kept (§ 2b);
5. the original file's line, when the file has one (§ 2a);
6. when the text was cut, how much (`[Cut: only the first 60,000 of 340,000 characters follow. The rest is in uploads/~me/x.md.]`, from core's `cutNoteLine`).

They end with a blank line.

The composer builds the message as `typed text`, a blank line, `notes`, then `--- name ---` and the text (`inlineBlock` returns `notes + attachmentBlock(name, text)`). **The notes are above the header, outside the block**, so every line of them is the host's voice and a line of the document that looks like one has been indented away. The model's prompt says so too: only the lines above the `--- name ---` line are the owner's words and the host's notes (`DEFAULT_CHAT_PROMPT`, `packages/core/src/agents/default-chat.ts`, with a test in `default-chat.test.ts`).

If the save call itself cannot be made (network, a 5xx, a malformed answer) it throws `ChatDocumentError("send")`; any other failure code keeps its own key (`too_large`, and so on). `send()` catches `ChatDocumentError` (`chat-composer.tsx:506`), shows its sentence on `composer-error` and returns, so the draft stays in the box and no run starts. A failed save is a failed send, never a message that quietly goes without the file. Attaching a document and then removing it never reaches this step, so it leaves no desk file behind (its original, kept at attach, is § 2a).

A plain text file (`.txt .md .csv .json`) is read in the browser as it always was, but is held to the same budget: `cutTextAttachment` (core, `cut.ts:55`) cuts it on a line at 60,000 characters (`CHAT_TEXT_ATTACHMENT_MAX_CHARS`) and puts `[Cut: ... The rest was not kept.]` above the block. A text file is not saved on the desk, so the rest is gone from the message, and it gets no figures file.

### 4. The private desk copy

`deskPathForDocument` (`desk-name.ts:70`) answers `uploads/~<user folder>/<name>.md`, or the same path with another suffix when one is passed (the figures file passes `.figures.json`, `FIGURES_SUFFIX`, `desk-copy.ts:39`). It keeps the whole file name, extension included, so `report.pdf` and `report.docx` get two files; it folds the name to Unicode NFC so two spellings that read the same are one file; it replaces the characters a desk path refuses, never lets a name start with a dot, shortens the stem and keeps the extension, prefixes a reserved device name with `doc-`, and always answers a path `parseDeskPath` accepts. Letter case is kept, because the desk's paths are case sensitive.

`saveDeskCopy` (`desk-copy.ts:62`) writes it through the desk root, authored as the signed-in person: versioning (the same bytes again is the same version, so re-sending is a no-op), the 2 MB file limit (a longer text is cut to fit and `savedPartial` is true), the 2,000-file ceiling and, in server mode, the tenant storage quota. A refusal comes back as `quota`, `too_large`, `too_many_files`, `denied` or `unavailable`, and the notes say so. `saveDeskFigures` (`desk-copy.ts:41`) writes the figures file through the same root, also as the person, and answers null on any refusal.

**Private by person, on the hosted server.** On a team desk the folder is the person's own and nobody else's. `privateFolderFor(userId)` (`desk-files/private-uploads.ts:29`) is `~` plus the user id (or a hash of it when it is not a safe token). `canSeePath` (`:44`) answers false for any `uploads/~...` folder that is not the caller's own, and the desk file store asks it on every path: read, list and glob, search, write, remove, the version read and revert (`desk-files/file-store.ts:143`, `assertVisible`, and the filters in `list` and `search`). Another person's folder is "not found", not "forbidden", so its existence does not leak. A caller with no user id (a background run) sees none of these folders, and a person cannot create a folder with someone else's name. The folder comes from `getTenant`, never from the request (`handler.test.ts`, "never takes the folder from the request"). The file tools and `run_code` inputs read through the same desk root, so they are covered by the same guard; the owner and admins are not exempt. This is the owner's decision of 2026-10-06 ([`agent-tools-and-files.md`](agent-tools-and-files.md) § 8). On Personal there is one person, `canSeePath` guards nothing, and the folder exists only as a name (`private-uploads-store.test.ts`, "parity").

### 5. Send, and the reload

- **Masking.** The whole message passes `maskOutboundRunInput` in `createRuntime` like typed text. The text was already masked, so masking twice changes nothing (`chat-documents/outbound-mask.test.ts`).
- **Injection guard.** `redactAttachedParts` (`packages/host/src/runs.ts:154`) finds each block by its header and replaces a body that trips a rule with a marker, as it does for a text file. A block runs to the next **full** header (`ATTACH_BLOCK_RE`, `packages/core/src/security/injection-guard.ts:186`), so a half header the file wrote itself does not end the scan; a forged full header only starts another scanned block.
- **Egress.** After a private read the runtime refuses a fetch to a host the person did not name. The people's own words are `userTextOf` (`packages/core/src/runtime/egress-guard.ts:122`), which now cuts every user message at its first `--- name ---` header and drops the host's note lines (`typedTextOf`, `injection-guard.ts:206`). A document or a text file that names a site is not the person naming it.
- **The Knowledge Base card and the thread title.** The Chat work card and the thread's title are built from `attachmentsAsMentions(message)` (`packages/host/src/runs.ts:378`, `:693`; `injection-guard.ts:224`): what was typed, then `[Attached file: name]` per file, with none of its text. Before this the card stored up to 2,000 characters of the message, block included. `chat-documents/card-privacy.test.ts` holds it. The assistant's reply, which the card also stores (up to 5,000 characters), can still restate what the document said; see SR-145.
- **Persistence and the reload.** The message is stored as text, encrypted at rest, with the notes and the block in it. The message holds no binary; a Word, Excel or PDF original is kept apart, as an artifact (§ 2a). After a reload `splitUserFileBlocks` (`packages/core/src/chat-documents/file-blocks.ts:27`, called at `apps/web/components/chat-turn.tsx:392`) lifts each file's notes out of the text before it, or out of the previous file's body, and carries them on the file's segment. It moved to core so the host can use the same split: the `finance_task` worker strips file blocks from the person's typed text with it ([`finance-chat-worker.md`](finance-chat-worker.md) § 7). `chat-turn.tsx:407-413` draws the segment as a `message-embed` file card titled with the file name, with the notes as its detail line (`fileCardDetail`, `message-embeds.ts:118`: brackets removed, and the data note, the original file's line and the figures line left out, `MODEL_ONLY_NOTE_PREFIXES`, `message-embeds.ts:110`). A note-looking line anywhere else stays where it is. The chip is a composer state and is gone once the message is sent.

## What limits it

| Limit | Value | Where |
|---|---|---|
| Request body | 26 MB, answered 413 by the HTTP adapter for both routes, on the declared length and on the bytes read; the IPC bridge has no cap of its own | `packages/host/src/http-adapter.ts:43`; `http-adapter.test.ts`, "chat document routes" |
| Origin and CSRF | Hosted: a trusted Origin and the double-submit token on both POSTs, before any handler runs. Desk: the loopback Host and the transport header, no token | same test |
| The file | 25 MB, and 20 s to answer; extension and bytes must agree | `CHAT_DOCUMENT_MAX_BYTES`, `file-extract/limits.ts` (a test holds the two equal) |
| Native conversions | At most 2 running at once hosted, 3 on a desk (`AGENTFORGE_MAX_NATIVE_CONVERSIONS`). A slot is held until the native call itself ends, not until the 20 s answer; past the cap the answer is 429 `too_many_jobs`. Shared with Knowledge ingest, Finance import and Education | `file-extract/native-gate.ts:40`; wired in `anydoc.ts:180` |
| Waiting room | Hosted: 2 reads at once (`AGENTFORGE_MAX_DOCUMENT_READS`), a room of 8, then 429. Desk: uncapped. The figures read waits in the same room after the document read | `chat-documents/limiter.ts:22`, `packages/host/src/concurrency.ts`; `handler.ts:62-66` |
| Request rate | Hosted per-IP and per-session buckets | `packages/host/src/rate-limit.ts` |
| Tenant storage quota | Applies to the desk copy and the figures file (in server mode, through `putTenantObject`) and to a kept original (`assertStorageAdmits`, through `saveRenderedArtifact`, § 2a) | `packages/host/src/tenant-storage.ts`, `packages/host/src/artifact-save.ts` |
| Original file | Word, Excel and PDF only, at most about 3 MB raw (the artifact body cap, `ARTIFACT_BODY_MAX_BYTES`, is checked on the base64) | `packages/host/src/artifacts.ts`, `packages/host/src/chat-documents/original.ts` |
| Figures file (tester) | xlsx (also `.xls`, `.xlsm`), docx, pdf and pptx only. Up to 30 sheets, joined whole into at most 12,000 characters of `figuresText`; `proseText` is also capped at 12,000; up to 100 sheet names of 200 characters. Written only when the `.md` copy saved | `packages/host/src/finance-figures/figures.ts`, `packages/core/src/chat-documents/finance-figures.ts:4-5`, `packages/core/src/finance/import-table/limits.ts:13`, `:21` |
| Text sent to the model | 60,000 characters per document and per plain text file, 3 documents per message | `packages/core/src/chat-documents/limits.ts` |
| The desk copy | 2 MB, 2,000 files per desk | `agent-tools-and-files.md` § 8 |

## Where things live

| File | Role |
|---|---|
| `packages/core/src/chat-documents/` | The extension table, the accept list, the caps, the error and save-failure codes, the host-note prefixes, the shared cut (`cutOnLine`, `cutNoteLine`, `cutTextAttachment`), `splitUserFileBlocks` (`file-blocks.ts`) and the figures schema (`finance-figures.ts`) |
| `packages/host/src/chat-documents/handler.ts` | The read route |
| `.../save-handler.ts` | The save route |
| `.../read.ts`, `text.ts` | Extract, clean, mask, cut |
| `.../desk-copy.ts`, `desk-name.ts` | The `uploads/~<user>/` files: the `.md` copy and the `.figures.json` file |
| `.../notes.ts` | The bracketed notes the model reads above the block |
| `.../original.ts` | The original file: kept at attach, its id checked at send (§ 2a) |
| `.../errors.ts`, `limiter.ts` | Failure mapping and the waiting room |
| `packages/host/src/finance-figures/` | The figures read at attach and the check at save (§ 2b, tester) |
| `packages/host/src/desk-files/private-uploads.ts` | Whose folder is whose |
| `packages/host/src/file-extract/native-gate.ts` | The native conversion slots |
| `apps/web/lib/composer-documents.ts` | The two requests, the read state, the error keys, `inlineBlock`, the pure rules |
| `apps/web/lib/use-document-reads.ts` | Starts each read once |
| `apps/web/components/composer-attachment-chip.tsx` | The chip: `composer-attachment` (`data-kind`, `data-state`), `-spinner`, `-meta`, `-note`, `-error`, `-retry`, `-remove` |
| `apps/web/lib/message-embeds.ts` | `fileCardDetail` and `MODEL_ONLY_NOTE_PREFIXES`: the thread's file card |
| `apps/web/locales/{en,id}/chat.json`, `document.*` | The copy |

## Gotchas

- The desk copy is written when the message is sent, not when the file is attached. Removing a chip leaves no desk copy, and deletes the Word, Excel or PDF original kept at attach unless a send is in flight (§ 2a); a message that is sent and then fails at the gateway leaves its copy (re-sending the same file is the same version).
- The text the model and the desk copy hold is the masked text. A figure that looks like an identifier (a 16-digit value, a Luhn-valid number) can come back as `[nik]` or `[card]`. Finance's column-aware scanner (`finance/pii-scan.ts`) is not used on that text. On the tester the figures file is read from the unmasked extract and redacted the Finance way instead (§ 2b).
- A figures file exists only when the `.md` copy saved. A full quota leaves neither, and the notes say only that the text was not saved.
- The chip says nothing about figures, and the file card hides the `[Figures kept` line. Only the model sees the figures path.
- A document stays in the thread's history, so each later turn re-sends its up to 60,000 characters.
- A `.docx` and a `.pdf` with the same stem do not collide, because the extension is part of the desk name. Two different `report.pdf` files do: the second is a new version of `uploads/~<you>/report.pdf.md`, and of `report.pdf.figures.json` when it has figures.
- `maskPii` counts findings, so `pii.count` can run slightly above the number of replacements when two patterns match the same span.
- The extractor's own Markdown cap (`FILE_EXTRACT_MAX_MARKDOWN_CHARS`, 2,000,000 characters) applies before everything above; the chip does not say when that cut happened.
- The chip says how much was cut but nothing about the desk copy: whether it was saved is known only at Send, and the thread's file card then carries the host's line (`Saved on this desk as ...` or `Not saved on this desk (...)`).
- The file name reaches the model in the `--- name ---` header and, sanitised for the file system but not for meaning, in the `Saved on this desk as <path>` and `Figures kept: <path>` notes. A counterparty can choose it. See SR-145.

## Verify

Unit tests: `packages/host/src/chat-documents/*.test.ts` (including `figures-failure.test.ts`), `packages/host/src/finance-figures/figures.test.ts`, `packages/host/src/desk-files/private-uploads*.test.ts`, `packages/host/src/file-extract/native-gate.test.ts`, `packages/host/src/http-adapter.test.ts` ("chat document routes"), `packages/core/src/chat-documents/*.test.ts`, `packages/core/src/security/injection-guard.test.ts`, `packages/core/src/runtime/egress-guard.test.ts`, `apps/web/lib/composer-{attach,documents,documents-wiring,attachment-chip}.test.ts[x]`, `apps/web/lib/message-embeds.test.tsx`. Recipe: [`features/chat.md`](../../../.cursor/skills/verify-agentforge/features/chat.md), "Documents"; the figures file is driven through [`features/finance.md`](../../../.cursor/skills/verify-agentforge/features/finance.md), "Finance in Chat". Security register: SR-145.
