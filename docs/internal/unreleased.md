# Unreleased changes (after the 0.16.0 cut)

**Purpose:** what is on `main` or on a cut branch but not inside a published installer. **0.16.0 is cut and packed, not published** (2026-10-06, branch `chore/release-0.16.0`; Windows from `4dd33fa`, mac from `e7a17c2`). It is the first installer under the Nultron name. Until it ships, the installer in the wild is **v0.15.1** (`DPSBuddy Setup 0.15.1.exe`, published 2026-09-28 04:54 UTC from `43c1de3`). The ship list and the pack table are [`0.16.0-changelog.md`](0.16.0-changelog.md).

This file was started over at the 0.16.0 cut. The 0.15.1 cut never started it over, so the log it held ran from after 0.15.0 to 2026-10-05; that whole log is summarised in [`0.16.0-changelog.md`](0.16.0-changelog.md), and its full text is readable from git at `de95267` (`git show de95267:docs/internal/unreleased.md`). The pre-0.14.27 findings lists are readable at `e2e477e`.

Convention unchanged: at the next bump everything listed here folds into `<version>-changelog.md` and this file starts over. Nothing counts as shipped until it is staged, packed, installed, and driven on the packaged app. Append-only.

## Where each published artifact came from

| Release | Source | Published (UTC) | Record |
|---|---|---|---|
| v0.15.1 | `43c1de3`, worktree `agentforge-pack-0.15.1`; Docker Linux `--arch all` for mac | 2026-09-28 04:54, 7 assets on [`Kyoo032/Nultron`](https://github.com/Kyoo032/Nultron/releases/tag/v0.15.1) | [`0.15.1-changelog.md`](0.15.1-changelog.md) § Pack + publish |
| v0.15.0 | `88bb803`, worktree `agentforge-pack-0.15.0`; Docker Linux `--arch all` for mac | 2026-09-23 11:25, 7 assets on `Kyoo032/DPSBuddy` (now redirects to `Kyoo032/Nultron`) | [`0.15.0-changelog.md`](0.15.0-changelog.md) § Pack + publish |
| v0.14.27 | Windows `05e97a5`, mac `6da52d7` | 2026-09-18 01:47 | [`0.14.27-changelog.md`](0.14.27-changelog.md) |

0.16.0 rows are added here when it is published; until then its pack table lives only in [`0.16.0-changelog.md`](0.16.0-changelog.md). mac is **preview** for every release above: no dmg since 0.14.26 has been opened on Mac hardware.

## Still open, carried over at the 0.16.0 cut

Nothing below is closed by 0.16.0. Carried forward from the old file's "Still open after the 0.14.27 cut" list and its 2026-10-05 findings, as they stood at `de95267`.

### From before 0.15.0

- [ ] **Packaged bundled-anydoc load.** No packed app has been shown to *load* `anydoc.<platform>.node` from `app.asar.unpacked`. Proof owed: `doctor --desktop` plus `GET /api/v1/components` reporting `anydoc` `ready` with `source: "bundled"`.
- [ ] **Any macOS run of the component installer's download route.** Never done.
- [ ] **The onboarding component panel** (`component-setup`) has never been seen on the packaged app.
- [ ] **Legal:** one live matter run against the gateway (`features/legal.md` steps 4 to 8), and the Word / Excel round-trip of the redline and deviation report.
- [ ] **Packaged Windows drive of Start over + the gateway gate** (`doctor --desktop`, `host-status.json` `hasOpenai: false` after sign-out).
- [ ] **The manual Windows smoke list** from `apps/desktop/platform/windows/AGENTS.md`: Ctrl+V and right-click Paste on the onboarding key field, composer clipboard round-trip, the rail-footer update panel, Start over → reset → "Keep my data", model-output links opening the default browser, the model picker on a narrow pane.
- [ ] **Packaged CSP console check** on a packed build (the static half is proven; the runtime half is not).
- [ ] **mac launch smoke on hardware.** Owed for every build since 0.14.26.
- [ ] **ffmpeg is still a manual install** on both platforms (`ffmpeg-setup-notice`). It is the next component-manifest entry.
- [ ] **The unfixed findings** from the 2026-09-17 mapping pass, the knowledge-flow pass and the 2026-09-15 harness pass. Read the lists at `e2e477e`; the harness pass is also P7–P15 in [`blockers-2026-09-15.md`](blockers-2026-09-15.md).
- [ ] **Chat card titles.** A Chat thread's title is never regenerated after turn 1 (`threads.ts` `setThreadTitleFromParts`).
- [ ] **Housekeeping on the owner's desk:** 72 stub Videos rows in the dev `data/agentforge.sqlite`, 36 with no file (shown as "File missing" since 2026-09-29).

### Findings from the verify-skill maintenance pass, 2026-10-05 (product bugs)

Copied as they stood at `de95267`; the evidence is under `.cursor/skills/verify-agentforge/evidence/<feature>/2026-10-05-maintain/`. The first two were fixed on the 0.16.0 cut branch (`f193ab2`, `a0683bd`; see [`0.16.0-changelog.md`](0.16.0-changelog.md), "Fixes made on the cut branch"). The rest are still open.

- [x] **Fixed at the 0.16.0 cut (`f193ab2`).** **A non-`ok` gate verdict never heals (both products, highest impact).** `needsGatewayRefresh` re-checks in the background only an `ok` verdict past its TTL (`packages/host/src/gateway-gate.ts:559-567`). An `unreachable` or `error` verdict stays on disk, and once `lastOkAt` is older than the 7-day grace, `deriveGatewayGate` closes the desk (`:327-330`) until a manual Re-check.
- [x] **Fixed at the 0.16.0 cut (`a0683bd`).** **Settings Save with a blank key field forgets the key (Personal and webdev).** The form posts `openaiApiKey` on every save (`apps/web/components/settings-page.tsx:284-289`); off server mode a blank is forwarded (`packages/host/src/handlers/settings.ts:226-234`) and `mergeSecrets` deletes the key (`packages/core/src/secrets.ts:137-139`). Traced in source; not driven.
- [ ] **Finance loses 1 px of scroll per rail detour.** Cause not found.
- [ ] **Finance shows a vague error, or none, on a closed gate** (`packages/host/src/handlers/finance.ts:52`). Matters on hosted "Add it later".
- [ ] **Empty box above the key form after a component install** (`apps/web/components/onboarding-screen.tsx:293`, `apps/web/lib/use-component-setup.ts:126`). Appears only where a real download runs, such as a packed mac build.
- [ ] **Model label casing.** `gpt-oss-120b` shows as "GPT Oss 120B" (`packages/core/src/models/curation.ts:28`).
- [ ] **Portal: "we already sent a code" after a send that failed** (`apps/portal/src/otp/send.ts:119-122`). Enterprise only.
- [ ] **Portal: a mail outage holds every send for about 8 s before the 503.** Enterprise only.
- [ ] **Pilot rehearsal: Mailpit does not come back after a Docker restart** (`webapp-deploy/compose.local.yml:82`). Rehearsal stack only.
- [ ] **Dead locale key** `auth.account.tenant` (`apps/web/locales/en/auth.json:34`).

## Log

Append below, newest first.

## Chat takes documents, 2026-10-06 (both products; in the tree on `feat/chat-accepts-documents`, not committed, not packed, not driven in a browser; review fixes 2026-10-07)

- **Gap.** The composer's file input accepted images, video and `.txt .md .csv .json` only (`COMPOSER_FILE_ACCEPT`, `apps/web/lib/composer-attach.ts`). A PDF, Word, PowerPoint or Excel file dropped into Chat was refused as an unsupported type, though the host already reads those formats locally for Knowledge and Finance.
- **What changed.** Chat now takes pdf, doc, docx, ppt, pptx, xls, xlsx, xlsm, odt, ods, odp, rtf and epub. The file is read on this machine the moment it is attached (`POST /api/v1/chat/documents`, no gateway call, so it works with the gate shut, and it writes nothing), shows as a chip with a spinner, then a ready or failed state with the reason and a remove button (`composer-attachment`, `data-kind="document"`, `data-state`). A scan, a password-protected file, an empty or damaged one, a wrong type and an over-size one each show their own sentence in English and Bahasa Indonesia. Up to 3 documents per message; 60,000 characters of each go to the model, cut on a line, and the model and the person are told by how much.
- **Saved when the message is sent.** Pressing Send calls `POST /api/v1/chat/documents/save`, which writes the whole masked text as a desk file, `uploads/~<user>/<file name>.md` (a spreadsheet is one Markdown table per sheet), and answers the host's notes and the text for the block. Chat's file tools and `run_code` can read the file. A document that is attached and then removed leaves nothing behind. If the save cannot be made the message does not go: `composer-error` says why and the draft stays. A refusal to write (storage quota, file limits) never fails the attachment: the notes say the text was not saved.
- **Notes above the block.** The host's bracketed lines (what the file is, that its content is data and not instructions, where it is saved, how much was cut) sit above the `--- name ---` header, outside the block, so a document cannot forge one from inside. A line in a document that looks like a note, or that begins with three dashes and whitespace, is indented one space. After a reload the thread's file card carries the same lines as its detail.
- **Private by person on a team desk (owner's decision, 2026-10-06).** On the hosted server the folder `uploads/~<user>/` is visible to that person only, the owner and admins included: every path through the desk file store, so the file tools, `run_code` inputs, list, search, the Files routes and the version routes, answers "not found" for another person's folder. Personal is one person per desk and is unchanged (a parity test holds it). The Chat Knowledge Base card and the thread title no longer carry attachment text: they use `[Attached file: name]`.
- **Review fixes (2026-10-07).** The egress guard now reads only what was typed above the first attachment header, so a counterparty's document or a plain text file that names a site is not the person naming it. A native conversion's slot is held until the native call ends, not until the 20 s answer, with a cap of 2 hosted and 3 on a desk and a 429 `too_many_jobs` past it; this also covers Knowledge ingest, Finance import and Education. The injection guard's block runs to the next full header, so a file cannot end its own scan with a half header. A plain text file is held to the same 60,000 characters as a document, with a `[Cut: ...]` note.
- **One list of formats.** The extension table moved to core (`packages/core/src/chat-documents`) and the host's fallback reader now reads it from there (`file-extract/detect.ts`), so the composer's accept list and the reader cannot drift. All three doors (picker, drop, paste) end in one `addFiles`; paste is new, and a paste that carries text is left as text. The composer placeholder now says "document" instead of "text file" in both languages.
- **Files.** New: `packages/core/src/chat-documents/` (with `cut.ts`), `packages/host/src/chat-documents/` (including `save-handler.ts`), `packages/host/src/desk-files/private-uploads.ts`, `packages/host/src/file-extract/native-gate.ts`, `apps/web/lib/{composer-documents,use-document-reads}.ts`, `apps/web/components/composer-attachment-chip.tsx`, `docs/internal/maps/chat-documents.md`. Edited: `router.ts` (two routes), `runs.ts` (the card and the title), `desk-files/file-store.ts` (the guard), `file-extract/{anydoc,index,detect}.ts`, the injection and egress guards and the default Chat prompt in core, `chat-composer.tsx`, `chat-turn.tsx`, `message-embeds.ts`, `composer-attach.ts`, `composer-draft.ts`, `locales/{en,id}/chat.json`, `packages/core/package.json` (one export), the Chat and locale recipes, the maps for Chat send, Knowledge and desk files, and the security register ([SR-145](security-register.md#sr-145)).
- **On Personal.** Nothing new is hidden or blocked. What differs from main: a plain text attachment over 60,000 characters is cut with a note (it had no cap); the Chat card and the thread title for a message with an attachment use `[Attached file: name]` instead of the file's first characters; a fourth native conversion at once answers 429 instead of starting; the injection guard scans past a half header; the composer placeholder says "document".
- **Findings, not fixed.** An attacker-chosen file name reaches the model in the header and in the `Saved on this desk as` note. The assistant's reply, which the Chat card stores, can still restate a document's content. A conversion that never ends still holds its native slot (the fix is a killable child process). All recorded in SR-145.
- **Proof.** Unit tests only (host `src/chat-documents`, `src/desk-files`, `src/file-extract`, `src/http-adapter.test.ts`; core `src/chat-documents`, `src/security`, `src/runtime`, `src/agents`; web `lib`). Not driven: a browser, the packaged app's IPC upload, a hosted deploy with two people on one desk.

## Hosted image: the ignore file dropped packages/core/src/data, 2026-10-06 (Enterprise image; fixed in the tree)

- **Bug.** `**/data` in `webapp-deploy/Dockerfile.dockerignore` (and its byte copy `webapp-deploy/.dockerignore`) keeps local data dirs out of the image, and also dropped the source folder `packages/core/src/data` (`ground.ts`, `cuts.ts`). An image built from `main` at `de95267` with `git archive` failed its own load check. Found while preparing the app.nultron-ai.xyz preview.
- **Fix.** Both files re-include `packages/core/src/data` and `packages/core/src/data/**`. `scripts/pilot-deploy.test.mjs` adds a test that every tracked `*/src/data` folder has its re-include (30 tests green).
- **Proof.** `nultron-web:979bd797bdf0`, built on the Tencent Lighthouse box from `git archive 979bd79`, completed with the load check (895 MB). Not yet run as the Enterprise app; the preview runs it in single-desk mode (security register SR-133).
