# Map: Meeting: recording → transcript → minutes → translation

Last verified: 2026-10-09 at 8ebc98aa for the `file:line` citations only (re-pointed to the symbols' current lines, nothing else re-read). Before that: 2026-10-07 (working tree on `5bec532`) for step 2 of the transcription path and the "No ffmpeg" bullet only: the `meeting/audio.ts` citations, the playlist and script refusal in `probeDuration`, the capped decode timeout and the packaged-app "Reinstall" wording; read against the code and `ffmpeg-input-safety-real.test.ts` and `audio-bundled.test.ts`, not driven. Everything else on this page is as of 2026-10-05, below. Before that: 2026-10-05 at the merge of `origin/main` (99922bb) into the Meeting harness branch (PR #129, head 9648700). Main carries the mode-harness lane (the minutes checks and their one repair round, their verdicts on the minutes record and on screen, a picked model held for the whole run, cancel and budget reaching the model call) and the 2026-10-02 delete cascade; the PR adds the name, date and figure guards on the settled sheet, the translation agreement check and the desk-language progress labels. Every citation into `packages/host/src/meeting/run.ts` and into `packages/core/src/meeting/{sheet,ground,agree,copy,guard,prompts}.ts` was re-read against the merged tree; citations into `records.ts`, `store.ts`, `transcribe.ts`, the meeting handlers, `meeting-studio.tsx` and `meeting-minutes-panel.tsx` are as main's 2026-10-03 pass left them (none of those files changed in the merge). The checks, the repair round, the guards and the translation check were read in code and in `meeting/run.test.ts`, `meeting/minutes-checks.test.ts` and `packages/core/src/meeting/skills.test.ts`, not driven: a run reaches the gateway and bills, and the `:3000` host needs a restart to load them. On 2026-09-28 stub webdev on `:3000` created a meeting, pasted a transcript, and `meeting-run` answered `runtime_stub` ("Meeting minutes need a live gateway") with no minutes panel, so the checks and guards stay behind that refusal (recipe: [`features/meeting.md`](../../../.cursor/skills/verify-agentforge/features/meeting.md)). The delete cascade has a recorded drive on `:3000` after a host restart (`features/meeting.md`, step 4). The pipeline itself was driven end to end on webdev on 2026-09-21 against the live gateway (upload, transcript, minutes, translation, both locale directions), before the checks existed: transcription ran on `gemini-3.5-flash` over the `chat_audio` wire, and the minutes and the translation on `gpt-5.6-sol`, the head of the list then (`gpt-6-sol` since 2026-09-30). See [What was driven](#what-was-driven-2026-09-21).

## Overview

Meeting is a **file job**, the same shape as Legal: a recording goes in, a transcript and two sets of minutes come out. A *meeting* is a folder on disk, not a database row, everything except the artifacts lives under `localDataDir()/meetings/<workspaceId>/<meetingId>/` (`packages/host/src/meeting/store-files.ts:1-11`). There is no migration; nothing in `packages/db` changed.

Five things to hold onto.

**1. Six of the nine routes never touch a model.** Meeting create, list, get, delete, recording upload and transcript paste are pure disk bookkeeping and work with no gateway key at all. Only the three `/stream` routes reach the gateway, and they are guarded twice, a 403 gate before the job starts (`packages/host/src/handlers/meetings.ts:140`, `:155`, `:175`) and a 503 `runtime_stub` check inside it (`requireLiveMeetingRuntime`, `packages/host/src/meeting/run.ts:79-88`). As with Legal, that 503 arrives as a single `job.error` frame inside a `200 text/event-stream`, not as an HTTP 503 (`packages/host/src/handlers/meetings.test.ts:233-254`).

**2. The transcription wire is chat completions, not `/audio/transcriptions`, and its payload differs per model family.** The gateway's `supported_endpoint_types` never advertises an audio or transcription type; ASR, omni and TTS ids expose `openai` only and carry their vendor's schema behind it (`docs/internal/gateway-model-selection.md:174`). Driving it on 2026-09-21 showed the shape is not one shape: the OpenAI audio family (`gpt-audio-mini`, `gpt-audio-1.5`) takes **bare base64** in `input_audio.data` and answers `400 invalid_value` to a data URI, while the DashScope-backed family (`qwen*-omni*`, `*livetranslate*`) takes a **`data:` URI** and answers `400 InvalidParameter`, "The provided URL does not appear to be valid", to bare base64. `transcriptionShapeFor` (`packages/core/src/meeting/asr-model.ts`) returns the wire, the encoding and whether to stream; `packages/host/src/meeting/transcribe-request.ts` builds the call from it and accumulates the SSE deltas when it streams. The multipart route is kept for a Whisper-style id on a gateway that does serve it; that is the wire `packages/host/src/edit/asr.ts` has always used.

**3. Translation is a second pass over the finished JSON, not a second reading of the transcript.** `translateMinutes` (`packages/host/src/meeting/run.ts:492`, called at `:467`) hands the model the minutes object and asks for the same shape in the other language, so the two languages cannot disagree about what was decided. `minutesAgree` (`packages/core/src/meeting/agree.ts:27`) then checks that the lists, owners, dates, provisional marks and figures still line up; a miss is asked once more, and a second miss is not saved (§ 6). This is on top of the repo's usual `withOutputLanguage` surface rule, which only decides what language a single call writes in.

**4. The minutes are done when four checks pass, then the code settles the sheet; the translation gets no checks, only the agreement test.** Since 2026-10-03 the minutes call runs through `runChecked` with one repair round (`writeMinutes`, `packages/host/src/meeting/run.ts:288`): the answer must be the minutes JSON, every action item needs a task and an owner the transcript names, no decision or action quotes a date or time the transcript never says, and the summary is not empty. Minutes that still fail are kept, and their verdicts travel with them: in the artifact `meta` and as `checks` on the minutes record, where the studio reads them and shows `meeting-checks-note` above the minutes. Only minutes that never parse are an error. The code then has the last word, with no further model call: `guardMinutesNames` for names, then `guardMinutesGrounding` clears a date and stamps a figure the transcript never said (§ 5).

**5. A model the person picked is held for the whole run.** The studio sends the pick as `model` plus `modelPinned`, the two minutes routes read that as `modelExplicit`, and the minutes call, its repair and the translation all pass it on. The job model fallback then never swaps the model, and a gateway outage on it is the run's error (§ 5).

## How it works

### 1. Reaching the surface

`mode-meeting` on the left rail is built from the product mode's href (`packages/core/src/agents/product-modes.ts:12`, `href: "/meeting"`), so there is no literal `data-testid="mode-meeting"` to grep, the rail composes it (`apps/web/components/app-rail.tsx:321`, in the job-modes `map` at `:312-325`). `/meeting` itself is `<Route path="/meeting" element={null} />` (`apps/web/src/App.tsx:402`); the studio mounts through `WorkModeKeepAlive` (`apps/web/components/work-mode-keep-alive.tsx:35`), not through the route element.

`MeetingStudio` (`apps/web/components/meeting-studio.tsx:279`) renders `meeting-studio`. On mount it fires one GET, `/api/v1/meetings`, which returns both the list and a **capability** block (`packages/host/src/handlers/meetings.ts:37-41`), whether this desk has a recogniser and whether ffmpeg is installed. That is what lets the studio say "paste the transcript instead" *before* the owner uploads 25 MB and finds out.

### 2. Intake, a meeting is created explicitly

Unlike Legal, there is a create form: title plus the language spoken (the form is `meeting-new`, `apps/web/components/meeting-more.tsx:53`, its button `meeting-create`, `:82`). It posts through `requestMeeting` (`apps/web/lib/meeting-request.ts:76`, called at `apps/web/components/meeting-studio.tsx:170`), which the pasted-transcript save shares (`meeting-studio.tsx:275`): `res.ok` is read before the body, an error body is read with a `catch`, and a dead network is a message rather than a throw, the order SR-45 set for the recording upload. Both used to read `res.json()` first with no `catch`, so an html error page or an offline laptop threw and the owner saw nothing. `handlePostMeetings` (`packages/host/src/handlers/meetings.ts:51`) writes `meeting.json` through `meetingStore()`. The `locale` chosen here is the language the minutes are written in *first*; the translation is the other one (`otherLocale`, `packages/host/src/meeting/run.ts:80`).

### 3. Upload, audio or video, 25 MB, sniffed on mime

`handlePostMeetingRecording` (`packages/host/src/handlers/meetings.ts:92`) takes the usual `request.files` field `"file"`. Caps in `assertRecordingCaps` (`packages/host/src/meeting/store-files.ts:270-280`):

- empty file → 400
- over `MEETING_RECORDING_MAX_BYTES` (25 MB) → 413
- a mime outside `MEETING_AUDIO_TYPES` ∪ `MEETING_VIDEO_TYPES` → 400 `unsupported_content_type`

**Why 25 MB and not more:** the HTTP adapter refuses any request body over `MAX_BODY_BYTES` = 26 MB (`packages/host/src/http-adapter.ts:43`). A larger cap in the store would only turn a clear 413 into a confusing transport failure. Roughly an hour of speech-grade mono audio fits; a longer meeting goes in as a pasted transcript.

Bytes land at `recording/source.<ext>`, extension from the mime with the filename as a fallback (`extensionFor`, `store-files.ts:260-268`). `recordingFile()` re-checks that a stored relative path still resolves inside the meeting directory before anything reads it back (`store-files.ts:96-103`).

**A meeting holds one recording, and since 2026-09-21 the disk agrees.** The filename comes from the mime type, so re-uploading a `.webm` over an `.mp3` used to write `source.weba` beside a `source.mp3` that nothing would ever remove again, a tenant's audio outside the record and outside quota accounting ([`../security-register.md`](../security-register.md) SR-13). `addRecording` (`store.ts:185-215`) now writes the new bytes **first**, then calls `removeStaleRecordings` (`store-files.ts:149-192`) to delete every other `source.<ext>` in that meeting's `recording/`, then `removeDerivedAudio` (`:194-212`) to drop the `audio/` chunks, which are a cache of the recording that was just replaced. Write-then-clean, not clean-then-write: a failed write must leave the tenant with the recording they already had, not with neither. The cleanup is bounded to that one directory (every candidate goes back through `recordingFile()`), to names matching `/^source\.[a-z0-9]{1,5}$/`, and to `entry.isFile()` from `readdirSync(..., { withFileTypes: true })`, a symlink answers `isSymbolicLink()` and is skipped, so nothing can be unlinked through one, and a directory can never turn this into a recursive delete. ENOENT is the outcome asked for, not an error. Deleting a meeting still removes the whole directory (`store.ts:170-183`), and since 2026-10-02 the meeting's artifacts first (§ 7).

Note this path deliberately does **not** reuse `saveMedia` (`packages/host/src/media.ts:67`), which refuses audio unless a caller passes it in `allow` (`DEFAULT_UPLOAD_KINDS` is image and video, `:52`), nor `saveEditFile` (`packages/host/src/handlers/edit.ts:79`), which accepts it but belongs to Edit.

### 4. Transcribe, ffmpeg, then one gateway call per chunk

`transcribeMeeting` (`packages/host/src/meeting/run.ts:159-208`):

1. `resolveMeetingAsr()` first, so a desk with no recogniser is refused before ffmpeg burns CPU (`run.ts:170-179`).
2. `extractMeetingAudio` (`packages/host/src/meeting/audio.ts:69`) first asks `probeDuration` (`:51`) for the length, and that probe refuses a container that is a playlist or a script (`assertAcceptableContainer`, `:59`; `400 unsupported_media`, `mediaFormatRefused`, so ffmpeg is never asked to read it; SR-135), then decodes to mono 16 kHz 64 kbps mp3 and **segments at `CHUNK_SECONDS` = 600** (`:25`), about 4.8 MB a chunk, which every transcription route accepts in one request base64-inflated. `MAX_CHUNKS` = 36 (`:27`) caps a pathological file at six hours. The decode's timeout comes from the declared length (`timeoutForMedia`, `:41`, over `mediaTimeoutMs` in `edit/ffmpeg/input-safety.ts`): a length is believed only up to those six hours, and a hosted server stops the step at one hour. Like every ffmpeg run it carries `-protocol_whitelist file,crypto,data` (`runFfmpeg`). This is its own recipe rather than Edit's `extractAudio` because that one resolves paths against Edit's project allowlist (`editAllowlist`, `packages/host/src/edit/ffmpeg/paths.ts:63`) and cannot read the meeting store; the ffmpeg runner and the path guard are the shared ones.
3. `transcribeAndMeter` (`run.ts:215-251`) hands the chunks to `transcribeChunks` (`packages/host/src/meeting/transcribe.ts:172`), with the run's abort signal (`run.ts:227`), which posts each chunk in order, emitting a `job.step` per chunk, and meters the audio (see below).
4. The chunks are deleted in a `finally` (`run.ts:203-207`), they are a cache of a recording that is still on disk. Since 2026-09-23 the extraction itself sits inside that `try` (`:183-187`), so an ffmpeg that fails after writing some chunks, or a cancel that lands the moment it finishes, still leaves nothing behind.

An empty chunk is logged and skipped, but an empty *transcript* is a hard `transcription_empty` (`run.ts:199-201`). That is deliberately unlike `transcribeAudioChunks` (`packages/host/src/edit/asr.ts:71`), which drops a failed chunk silently and returns whatever is left.

**What is metered.** A whole transcription records `audio.durationSeconds` before the transcript is judged, because the gateway has already charged for the audio (`run.ts:244-249`). A run that fails part-way records the seconds of the chunks that did answer, up to the offset of the first chunk that did not, and then rethrows (`:234-243`); before 2026-09-23 a chunk-3 failure recorded nothing for chunks 1 and 2, which the gateway had billed.

### 5. Minutes: strict JSON, four checks, then the code guards

`generateMinutes` (`packages/host/src/meeting/run.ts:424`) refuses a transcript that is empty or missing (`:437-443`), resolves the model (`resolveMeetingModel`, `:90`, called at `:444`), emits the `minuting` phase (`:448`) and calls `writeMinutes` (`:288`, called at `:449`). The system prompt is `MEETING_MINUTES_SYSTEM` (`packages/core/src/meeting/prompts.ts:16`) wrapped in `withOutputLanguage(..., "meeting", locale)` (`run.ts:307`). Each call goes through `collectJobAssistantRun` (`packages/host/src/job-regen.ts:252`) with `jobMode: "meeting"`, `modelExplicit` and the run's abort signal (`run.ts:303-315`), so it inherits the repo's model-fallback and job-thinking knobs. The progress labels (writing, the repair step, checking names/dates/figures, saving, translating, translating again) come from one table that follows the desk language, `meetingPhaseLabel` (`packages/core/src/meeting/copy.ts:28`), not the language the minutes are written in. They are not new controls.

**A picked model is pinned.** `onRun` sends `modelPickBody(studioModelPick(model, modelPinned))` (`apps/web/components/meeting-studio.tsx:596`): `model` when the picker has one, `modelPinned: true` only after the person changed the picker (`apps/web/lib/model-choice.ts`). The minutes and run handlers read it with `readModelPinned` (`packages/host/src/handlers/meetings.ts:159`, `:179`; `packages/host/src/job-regen.ts:49`), which counts a pin only when a model id came with it. `generateMinutes` takes it as `options.modelExplicit` (`run.ts:431`) and hands it to `writeMinutes` (`:449-453`, used at `:306`) and to `translateMinutes` (`:467-481`, used at `:514`). Inside the job run, `pickNext` returns no stand-in when `modelExplicit` is true (`packages/host/src/job-model-fallback.ts:127-130`), so an outage on the picked model ends the run. A seeded default is not pinned and may still be rescued onto a stand-in. The artifact and the record name the model that answered. `packages/host/src/meeting/pinned-model.test.ts:140-204` pins both cases.

**The checks and the repair round.** `runChecked` (`packages/host/src/harness/run-checked.ts:71`) hands the model's draft to four pure checks (`buildMinutesChecks`, `packages/host/src/meeting/minutes-checks.ts:270`, in the order the repair note lists them) and, on a failure, calls the model once more with the failed answer and an `ERROR` / `WHY` / `FIX` note (`minutesRepairPrompt`, `:295`). `repairRounds` is `harnessSpecFor("meeting").repairRounds`, which is **1** (`run.ts:298`, `packages/core/src/harness/modes/meeting.ts:14`).

| Check id | Fails when | Source |
|---|---|---|
| `minutes-shape` | The answer did not parse as the minutes JSON (empty, not one JSON object, or it fails the schema). The note carries the schema's field paths | `minutesShapeCheck`, `minutes-checks.ts:116`; `parseMinutesDraft`, `:54` |
| `action-owners` | An action item has no task, no owner, or an owner the transcript never names (anything but `[needs owner]`). It uses the same generous name test as the guard | `actionOwnersCheck`, `:138`; `nameAppearsInTranscript`, `packages/core/src/meeting/guard.ts:27` |
| `quoted-dates` | A decision or an action item (task, due, first step) quotes a date or a clock time the transcript never says. English and Indonesian month names, ISO and numeric dates, 12 and 24 hour clocks | `quotedDatesCheck`, `:365`; `findDateTimeMentions`, `:263` |
| `summary-present` | The summary has no letter or digit while the transcript is longer than `TRIVIAL_TRANSCRIPT_WORDS` = 20 words | `summaryPresentCheck`, `:403`; `TRIVIAL_TRANSCRIPT_WORDS`, `:22` |

The comment at the top of the file states the design rule: every check is conservative and fires only on something a reader could prove wrong from the transcript alone, so a normal set of minutes never costs a second model call (`minutes-checks.ts:4-9`). Spelled-out numbers ("fourteenth") are not read as dates (`whatWasHeard`, `:320`), and a month name only counts in the minutes when it is capitalised, so the verbs "may" and "march" are not dates (`:208-209`).

Before the repair call the run emits a `job.step` on the `minuting` phase, "Fixing what the checks found in the minutes" (`onRound`, `run.ts:336-337`). That is a step label, not the `job.round` event Research uses, so `meeting-progress` shows no "Round n of m" line. The label is `meetingPhaseLabel("fixing", localeForRun())` (`packages/core/src/meeting/copy.ts:28`), "Fixing what the checks found in the minutes" on an `en` desk and "Memperbaiki temuan pemeriksaan pada notulen" on an `id` one, like the other phase labels.

**Failure handling.** A repair call that cannot be made, or that throws, keeps the draft already in hand and logs `meeting_minutes_repair_failed` (`produce`, `run.ts:301-327`, the log at `:324`); only the first call may throw. A cancel is thrown past that catch (`throwIfJobAborted`, `:319`, and again around `runChecked`, `:339-343`). Minutes that still fail after the repair are **kept**: the run logs `meeting_minutes_checks_failed` with the failing check ids (`:345-350`) and goes on, into the guards below. Only a draft that never parsed is an error, `generation_failed` or `invalid_minutes` at 502 (`minutesParseError`, `minutes-checks.ts:87`; thrown at `run.ts:352-354`).

**What is kept.** `summarizeMinutesChecks` (`minutes-checks.ts:439`) reduces the verdicts to `{ passed, rounds, verdicts: [{ check, ok }] }`. It holds ids and pass or fail only, because the artifact meta is not encrypted and no minutes text may go in it (`:431`). `writeMinutes` copies it onto the record as `checks` (`checksRecordOf`, `run.ts:275-281`; `checks: checksRecordOf(summary)`, `:374`), and `saveMinutesArtifact` writes it as `meta.checks` of the minutes artifact, for every set of minutes that went through the checks, passing or not (`run.ts:379-402`, `:397`). The record field is `minutesChecksRecordSchema` (`packages/host/src/meeting/records.ts:22`), nullable and defaulted to null (`:42`), so a record saved before the checks existed still loads. The translation's record and artifact carry no `checks` (`run.ts:546`).

**What the person sees.** `GET /api/v1/meetings` returns the record, so the studio has `minutes.checks` in hand (`MinutesRecord.checks`, `apps/web/components/meeting-studio.tsx:38`). `MeetingMinutesPanel` (`apps/web/components/meeting-minutes-panel.tsx:20`) renders the Minutes tab: `MeetingChecksNote` first, then `meeting-unverified` when names were removed, then `meeting-minutes`. `meetingChecksNote` (`apps/web/lib/meeting-checks.ts:51`) reads the verdicts, not the `passed` flag, and returns the failed kinds in a fixed order, `owners`, `dates`, `summary`, `shape` (`KIND_OF_CHECK`, `:20`). A check id it has no words for is left out, and nothing renders when every check passed, when the record has no verdicts, or on the Translation tab (`meeting-studio.tsx:905-910`). `MeetingChecksNote` (`apps/web/components/meeting-checks-note.tsx:11`) is a `role="status"` box, `meeting-checks-note`, with one `data-check` item per failed kind in `meeting-checks-list`, the title "These minutes may need a second look", and a hint that the minutes are saved and that "Write the minutes" runs them again. The wording is `meeting.checks.*` in both catalogs. A pass after a repair shows nothing: only `meta.checks.rounds` records that a repair was spent. `apps/web/lib/meeting-checks.test.tsx` pins the mapping and the rendering in both languages.

Then the code settles the sheet, on the draft that came out of the checks (`settleParsedMinutes`, `packages/core/src/meeting/sheet.ts:81`, called at `run.ts:356`), in this order and with no further model call:

1. `guardMinutesNames` (`packages/core/src/meeting/guard.ts:42`) checks every name the minutes assert against the transcript:
   - an **attendee** the transcript never named is dropped outright. A minutes sheet listing someone who was not in the room is worse than a short list;
   - an **action-item owner** the transcript never named becomes `[needs owner]`, because the action itself was still stated.

   Matching is deliberately generous (any word token of the name, at least 3 characters, case-insensitive, honorifics excluded, `guard.ts:12-34`): the point is to catch a wholly invented attendee, not to police how a speaker was introduced. The guard's own stamps, `[needs owner]` and `[figure not said]`, are exempt (`EXEMPT`, `guard.ts:12`).
2. `guardMinutesGrounding` (`packages/core/src/meeting/ground.ts:76`) clears a `heldOn` or a `due` unless that whole phrase is in the transcript (`dateSaid`, `:36`), and replaces a number the transcript does not contain as its own number with `[figure not said]` (`FIGURE_NOT_SAID`, `:4`; `12` is not found inside `120`, `2.1` and `2,1` are the same figure, `figureSaid`, `:31`). It rewrites every text field of the sheet, not only the decisions and action items the `quoted-dates` check reads.

The name count is logged as `meeting_minutes_names_guarded` (`run.ts:357-359`), the cleared dates and replaced figures as `meeting_minutes_grounded` (`:360-365`), and the run then emits a `grounding` phase (`:366`). The studio surfaces the dropped names to the owner on the Minutes tab as `meeting-unverified` (`apps/web/components/meeting-minutes-panel.tsx:24-28`). The figure marker is text in the minutes, the same way `[needs owner]` is, and there is no control for it.

This is the same family as Finance's number guard and Market's advice guard: a code check over model prose, not a nicer prompt. The `action-owners` and `quoted-dates` checks sit in front of the guards and ask the model to fix an unknown owner or an unsaid date first; the guards remain for whatever survives the repair. So a decision that quotes a date the repair did not fix is saved with `[figure not said]` in place of the number, while `meta.checks` still records `quoted-dates` as failed.

### 6. Translation

`translateMinutes` (`run.ts:492`) hands the work to `translateMeetingSheet` (`packages/core/src/meeting/sheet.ts:123`), which runs `MEETING_TRANSLATE_SYSTEM` (`prompts.ts:30`) over the finished minutes JSON, on the same model and the same pin as the minutes (`run.ts:513-514`), with the run's abort signal (`:522`). It **settles the result again** (`settleMinutes`, `sheet.ts:94`: the name guard, then the date and figure guard), because a translator that hallucinates a name, a date or a figure is exactly as wrong as a writer that does, and the transcript is still the only evidence either has. `minutesAgree` (`packages/core/src/meeting/agree.ts:27`) then requires the same list lengths, the same owners, the same dates, the same provisional marks and the same figures (a comma decimal matches a dot decimal, and `[figure not said]` counts as a figure). Wording may change. A miss, including JSON that is not the sheet, is asked once more with a one-line note in the target language (`translationRetryNote`, `copy.ts:33`). A second miss throws `MeetingTranslationError`, which `meetingFailure` (`run.ts:98`) turns into `translation_disagreed` (502) with the desk-language message (`translationDisagreedMessage`, `copy.ts:58`). A call that fails, a gateway outage for instance, is not retried. The translation runs **no checks and no repair round**, and its record and artifact carry no `checks`. A cancel is the job's `aborted` (`run.ts:531`), and one that lands before the save leaves no second artifact (`:535`).

**The minutes are saved before the translation starts.** `generateMinutes` writes `status: "minuted"` and the minutes onto the meeting, clearing any earlier translation, which described earlier minutes (`run.ts:460`); only then does it translate, and it writes the translation in a second update (`:482`). Before 2026-09-23 the one update came after the translation, so a translation that failed took the minutes with it: the owner paid for the minutes and saw nothing.

### 7. Artifacts and the Knowledge card

Both the transcript and each set of minutes become `mode: "meeting"` artifacts (`kind: "transcript"` / `"minutes"`, `text/markdown`). `persist()` never fails the run (`run.ts:111-129`), same precedent as `persistDraft` in `document-generate.ts`. The minutes also file a `Meeting` work card into the Knowledge Base (`fileWorkCard`, `run.ts:131-153`).

**Deleting the meeting deletes them (2026-10-02).** The artifacts are rows in the kernel `artifacts` table, not files in the meeting folder, so `rmSync` on the folder alone left `meeting / transcript "<title> — transcript"` in `GET /api/v1/artifacts` and the minutes' card in Knowledge, though the delete panel says the transcript and minutes go with the meeting. `store.remove` (`store.ts:170-183`) calls `removeMeetingArtifacts` (`packages/host/src/meeting/artifacts.ts`) before it removes the folder. Two handles find the rows, and both are used: the ids on the record (`transcriptArtifactId`, `minutes.artifactId`, `translation.artifactId`), which is the only handle on rows saved before this change, and the `meetingId` stamp that `saveTranscript` and `saveMinutesArtifact` now put in each artifact's `meta` (`run.ts:262`, `:395`; read back by `artifactIdsOwnedBy` in `packages/host/src/knowledge.ts`, the same LIKE-then-parse match Legal's `matterId` and Data's `datasetId` use). The stamp also catches what a re-run replaced on the record: running the minutes again writes a new artifact and points the record at it, so the old one used to be unreachable. The delete is one `sql.transaction` scoped to the desk and to `mode = 'meeting'`, so a stale or edited record can never name another mode's row; if it throws, nothing is deleted and the folder is still there to try again. The Knowledge cards then go through `sweepOrphanSources` (a failure there only warns; the next `GET /api/v1/knowledge` sweeps again). A stamp or an id from another desk is never touched. Test: `packages/host/src/meeting/delete-cascade.test.ts`, route level in `packages/host/src/handlers/meetings.test.ts`.

## Routes

Every by-id route, for the Phase 3 tenancy harness to cover:

| Method | Path | Gateway gate | Notes |
|---|---|---|---|
| GET | `/api/v1/meetings` | no | list + capability |
| POST | `/api/v1/meetings` | no | 201 |
| GET | `/api/v1/meetings/:meetingId` | no | **by id** |
| DELETE | `/api/v1/meetings/:meetingId` | no | **by id**; also deletes the meeting's artifacts and their Knowledge card (§ 7) |
| POST | `/api/v1/meetings/:meetingId/recording` | no | **by id**, multipart, 201 |
| POST | `/api/v1/meetings/:meetingId/transcript` | no | **by id**, pasted text |
| POST | `/api/v1/meetings/:meetingId/transcribe/stream` | yes | **by id**, SSE |
| POST | `/api/v1/meetings/:meetingId/minutes/stream` | yes | **by id**, SSE |
| POST | `/api/v1/meetings/:meetingId/run/stream` | yes | **by id**, SSE, upload → minutes |

The two minutes routes read `model`, `modelPinned` and `translate` from the body (`packages/host/src/handlers/meetings.ts:158-160`, `:178-180`).

All seven by-id routes resolve through `meetingStore()`, which filters on `tenant.workspaceId` and returns 404, not 403, for another workspace's record (`packages/host/src/meeting/store.ts:110-117`). A malformed id is a 400 from `assertSafeId` before it ever reaches the filesystem, which the route surfaces as a 404 (`packages/host/src/handlers/meetings.test.ts:98-101`).

## Model selection

| Leg | How it is picked |
|---|---|
| Transcription | `AGENTFORGE_MEETING_ASR_MODEL` if pinned, one id, no fallback, else `transcriptionCandidates(cachedModelIds())` over `TRANSCRIPTION_PREF` (`packages/core/src/meeting/asr-model.ts`), head `gemini-3.5-flash`. That is a **chain**, not a pick: a model that refuses, times out or answers with nothing is dropped and the next is asked, and the first that answers is preferred for every remaining chunk. Empty when the catalog lists nothing that can hear, the caller falls back to a pasted transcript rather than inventing an id. On the hosted server a tenant with a key and no cache row reads empty here (`no_model`) until the cache is filled; the shell's first catalogue read (not this one: `cachedModelIds` reads the cache directly) starts a background refill (`warmHostedModelCache`, `packages/host/src/selectable-models.ts:505`), so a reload after the first page load lists the recognisers. |
| Minutes and translation | `JOB_MODE_PREFERENCES.meeting` (`packages/core/src/models/mode-defaults.ts:82`), head `gpt-6-sol` since 2026-09-30, then `claude-sonnet-5-5`, `gemini-3.5-flash`, `gpt-5.6-sol` (the head, `gpt-5.6-sol`, was the model of the two driven runs below); the owner's `documentGenModel` setting overrides, and the picker overrides that (`resolveMeetingModel`, `packages/host/src/meeting/run.ts:90-95`). A picker change is also pinned for the run, minutes, repair and translation (§ 5). A translation that is not the same sheet is asked once more on that same model (§ 6). |

## The ASR-probe fix that came with this

`resolveAsrCapability()` in `packages/host/src/edit/asr.ts` accepted a model only when `mediaKind(id) === "audio"` **and** the id matched `/whisper|transcribe/i`. On the live Toko Token catalog that is satisfied by nothing: there is no `whisper` id (`grep -ri whisper docs/` returns none), and `mimo-v2.5-asr`, labelled `"Audio"` in `packages/core/src/models/gateway-roles.ts:159`, matched neither the `AUDIO` pattern in `media-kind.ts` nor the `ASR_ID` pattern. Two consequences, both now fixed:

- Edit's auto-captions reported `asr: { available: false }` on every live desk, and `GET /api/v1/edit/doctor` said so.
- `mimo-v2.5-asr` fell through to the **chat** bucket, so it was offered in the ordinary model picker, where it would simply fail.

`AUDIO` in `packages/core/src/models/media-kind.ts` now also matches a delimited `asr` token, `NOT_DEFAULT` in `preferred.ts` hides it from default picks, and `ASR_ID` in `edit/asr.ts` matches it too. Pinned by `packages/core/src/models/media-kind.test.ts` ("routes a speech recogniser to audio, not chat").

## Gotchas

- **One meeting can leave three usage rows, in two units.** The transcription is metered in
  seconds of audio (`recordTranscriptionUsage`, `packages/host/src/meeting/run.ts:246-249`, and
  `:237-240` for the answered part of a run that failed), because
  that is what a recogniser bills for, not the tokens of the transcript, and not the number of
  chunks `extractMeetingAudio` happened to split the recording into. The minutes and the
  translation are ordinary token runs, metered through their `meeting-minutes` and
  `meeting-translate` run prefixes. All three land under the `meetings` mode. Nobody has
  transcribed a per-second ASR list price yet, so the transcription row records its seconds with a
  null cost and `no_list_price` until one lands. See
  [`tenant-usage-ledger.md`](tenant-usage-ledger.md).
- **A fractional ffmpeg timeout used to kill every recording before a byte reached the gateway.** `timeoutForMedia` turned a probed duration (`65.556063` s) into `161112.126` ms, and `execFile` refuses a non-integer `timeout` with `ERR_OUT_OF_RANGE` *without spawning anything*. The catch-all in `packages/host/src/edit/ffmpeg/run.ts` reported that as `ffmpeg_failed` / "ffmpeg recipe failed", so the owner saw a run die at `extracting` and blamed ffmpeg for a request it never received. `runFfmpeg` now rounds the budget up (`run-timeout.test.ts`) and the failure message carries the exit code and the tail of stderr. `edit/ffmpeg/recipes.ts` had the same arithmetic, so Edit's probe, extract and render recipes were broken the same way for any clip that was not a whole number of seconds long.
- **`mimo-v2.5-asr` is not on this gateway, and the ids that were preferred instead do not work.** The 2026-09-21 catalog has 139 ids and no `mimo`. Of the audio-capable ones: `qwen3-livetranslate-flash`, `qwen3.5-omni-flash` and `qwen3.5-omni-plus` answer `503 get_channel_failed`, "Supply pool unavailable", so the model the picker had been choosing could never have transcribed anything; `gpt-audio` answers `200` with a refusal ("I'm sorry, but I can't provide that transcription") on both wires, which is why an empty answer is now treated as a chunk failure and why that id is off the list entirely; every `*-realtime` id speaks WebSocket only. `isTranscriptionModelId` now refuses realtime, TTS and any id whose `mediaKind` is image, video or other, and the `usable[0]` fallback that could hand a meeting to a video model is gone.
- **No ffmpeg, no recording path.** `extractMeetingAudio` raises `ffmpeg_missing` (503) rather than guessing. The capability block on `GET /api/v1/meetings` reports it so the studio can say so up front. In the packaged app the ffmpeg is the installer's own (2026-10-06, not packed): the block also carries `ffmpegBundled` (`usesBundledFfmpeg()`), the studio's note becomes `meeting.noFfmpegBundled` ("Reinstall ..."), and the 503 message says to reinstall the app instead of "Install it".
- **A picked model is pinned, a seeded one is not.** Press `meeting-model` to change the pick and the next run holds that model through the minutes, the repair and the translation (§ 5). Leave it alone and the studio still sends `model`, but without `modelPinned`, so the job fallback may swap it after a transport-class failure. The two look the same in the request body except for `modelPinned`. The artifact and the record name the model that answered, which is the picked one in the first case only.
- **Only the minutes are checked.** Transcription, the pasted transcript and the translation carry no checks, and a translation that fails does not lose the minutes (§ 6). The verdicts are on the minutes record and in the artifact's `meta.checks`; the studio shows only the failed ones, in `meeting-checks-note` on the Minutes tab. A set of minutes that passed, with or without a repair, shows nothing. The translation tab never shows a note, even when the minutes it came from carry one.
- **A re-run replaces the note.** `generateMinutes` writes the new minutes and their `checks` onto the meeting before the translation starts (`run.ts:460`), so the note on screen is always about the minutes on screen. Minutes saved before the checks existed have `checks: null` and never show a note.
- **A 25 MB cap is a transport fact, not a product choice.** Raising it means raising `MAX_BODY_BYTES` in `http-adapter.ts`, which every upload route shares.
- **The guard can only be as good as the transcript.** A guard run against an empty transcript refuses every name, which is the safe direction but means a transcript that failed silently would produce ownerless minutes rather than wrong ones. That is why an empty transcript is a hard error one step earlier.

## What was driven (2026-09-21)

Everything in this page above the Recording section was driven on webdev `127.0.0.1:3000` against the live
`https://api.tokotokenai.com/v1`, with synthetic recordings made on this machine with
`System.Speech.Synthesis.SpeechSynthesizer` (no tokens spent producing them) and never committed.

**The models, tried one short 14-second chunk each.** Verbatim and correct: `gemini-3.5-flash` (the only id that
labelled the speakers, ~7 s), `gpt-audio-mini` (~3 s, fastest), `gpt-audio-1.5` (correct streaming; non-streaming
wraps the text in a `{"text": …}` object), `qwen3-omni-flash-2025-12-01` (correct, and only with a data URI).
Refused: `qwen3-livetranslate-flash`, `qwen3.5-omni-flash`, `qwen3.5-omni-plus` (`503 get_channel_failed`),
`gpt-audio` (`200` + a refusal sentence). `TRANSCRIPTION_PREF` is that order, and
`packages/core/src/meeting/asr-model.test.ts` pins it against a snapshot of the live catalog.

**The two full runs**, both `POST /api/v1/meetings/:id/run/stream`, phases
`extracting → transcribing → minuting → saving → translating → job.done`:

| Meeting locale | Recording | Transcript | Minutes | Translation |
|---|---|---|---|---|
| `en` | 65 s, three named speakers | `gemini-3.5-flash`, verbatim with `**Daniel Brooks**:`-style labels | `gpt-5.6-sol`, 3 attendees, 2 decisions, 3 action items with owners and dates, 1 risk, 1 open question, `unverifiedNames: []` | `id`, `gpt-5.6-sol`, "Rilis perbaikan latensi checkout ke produksi pada Jumat, 14." |
| `id` | 73 s, three named speakers | `gemini-3.5-flash`, Indonesian | `gpt-5.6-sol`, Indonesian | `en`, `gpt-5.6-sol` |

Those two runs are proof of the pipeline on `gpt-5.6-sol`, not of `gpt-6-sol`, which replaced it as the head on 2026-09-30 (probed at every Thinking level, first token 1.7 to 5 s; no minutes were generated on it).

The translation target is `otherLocale(meeting.locale)` (`packages/host/src/meeting/run.ts`), so an `en` meeting is
translated to Indonesian and an `id` meeting to English. Both directions fired, with no owner action.

**Still unverified.** This machine has no Indonesian SAPI voice (only `en-US` David and Zira), so the Indonesian
sample is Indonesian *text* read by an English voice. The transcript was good Indonesian prose, but one speaker's
name came back as "Dwiistri" for "Dewi Lestari", an artefact of the synthetic pronunciation, not evidence about
the recogniser's Indonesian. Real Indonesian audio is still owed. So is a multi-chunk recording: both runs were a
single chunk, so the chain's "prefer the model that just worked" path and `CHUNK_SECONDS` segmentation are covered
by unit tests only.

## Related

- [`features/meeting.md`](../../../.cursor/skills/verify-agentforge/features/meeting.md), where to press
- [`legal-matter-run.md`](legal-matter-run.md), the file-job pattern this follows
- [`gateway-model-selection.md`](../gateway-model-selection.md), §2.1 endpoint types, §5.3 speech models, row 147
- [`edit-timeline.md`](edit-timeline.md), the other ASR caller
- [`tenant-usage-ledger.md`](tenant-usage-ledger.md), where a meeting's spend is recorded

## Recording (added 2026-09-21)

Everything above starts from a file that already exists. This section is the other intake: the
browser records the meeting itself, and then joins the pipeline above at step 3 with nothing changed.

**The one rule.** A recording is not a second intake path. `MeetingRecorderPanel` never calls the
host. The finished clip goes to `MeetingUploadController` (`apps/web/lib/meeting-upload.ts:117`),
which owns it until the host answers 2xx ([SR-45](../security-register.md#sr-45)), and the
controller's sender is `sendClip` (`apps/web/components/meeting-studio.tsx:506-512`), the same
`sendTo` the file input uses, the same `POST /api/v1/meetings/:meetingId/recording`, the same
`"file"` field. A recorder with its own `apiFetch` would pass every other test and quietly lose the
caps, the tenancy scoping and the status transition.

### The files

| File | What it owns |
|---|---|
| `apps/web/lib/meeting-recorder.ts` | `MeetingRecorderController`, the state machine, mime pick, byte cap, error mapping, and every track/AudioContext release. Framework-free: every browser object arrives through `RecorderDeps`, so it is unit-tested in a node environment. |
| `apps/web/lib/use-meeting-recorder.ts` | The React skin: subscribe (`useSyncExternalStore`), tick the elapsed clock at 250 ms while recording, and on unmount dispose and hand what the controller kept to `onDisposeClip`. |
| `apps/web/components/meeting-recorder.tsx` | Presentation. Takes a finished view, exactly as `ComponentSetupPanel` does, so it renders in a test without a browser. Also `MeetingOtherDeskClips`, the held-for-another-desk list. |
| `apps/web/lib/meeting-upload.ts`, `use-meeting-upload.ts` | The upload queue: holds a clip until a 2xx, queues while busy, keeps it with Retry and Save to device on a failure. |

States: `idle → requesting-permission → recording ⇄ paused → stopping → idle`, with `error`
reachable from any of them. The clip arrives through state rather than as a `stop()` return value,
so the owner's Stop and the cap's own auto-stop take one identical path out.

### Which meeting a recording belongs to (2026-09-23)

The meeting is fixed when Record is pressed: `startRecording` stores `{ id, title, workspaceId }` in
`recordingTargetRef` (`meeting-studio.tsx:310`, set in `startRecording`, `:448-454`), and a finished clip is offered to
the upload queue with that target (`clipTargetRef`). `sendClip` posts to the target, never to
whatever row is selected by then. It used to read the selection at send time, so switching rows
mid-recording, or before pressing Retry, put the recording on another meeting and replaced that
meeting's own. While a recording runs the list is locked: every row's select is disabled
(`locked`, `:743`), and the meeting being recorded cannot be deleted (`deleteLocked`, `:744`). A
failed upload names the meeting it was for (`meeting.record.uploadFailedFor`).

### A desk or language switch keeps the audio (2026-09-23)

`WorkModeKeepAlive` keys every work mode on the desk id, so a desk switch, or a language restart,
unmounts the studio. That used to take a running recording with it. Now:

- `dispose()` returns what the controller holds, a finished clip nobody took, or the chunks of a
  recording still running, paused or finishing, instead of dropping it
  (`apps/web/lib/meeting-recorder.ts:201`). The encoder's last partial chunk, at most one 1 s
  timeslice, is still lost: `stop()` flushes it asynchronously and there is nobody left to take it.
- The studio stashes it with its target in module scope (`stashRescuedClip`,
  `meeting-studio.tsx:151`), along with any clip still in the upload queue, and the next studio to
  mount takes them (`takeRescuedClips`, `:159`). This is memory, not storage: a page reload still
  loses them.
- A rescued clip for a meeting on this desk goes into the upload queue with the notice
  `meeting-record-kept` ("interrupted") (`:428-445`). One for a meeting on another desk cannot be
  uploaded from here, the host resolves `/meetings/:id` against the desk selected now and would
  answer 404 (`onSameDesk`, `:170`), so it is listed in `meeting-clip-other-desk`, one line per
  recording with `meeting-clip-other-desk-save-<key>` to save it to the device.
- The shell no longer changes desk on a failed read. `shellWorkspaceFrom`
  (`apps/web/src/App.tsx:68`) changes the desk id only when `GET /api/v1/workspaces` answers and
  names one; a 401 as a session lapsed, a 5xx or a proxy's error page used to read as "no desks",
  and that alone remounted every pane mid-meeting.

### A recorder error keeps the audio (2026-09-23)

When the encoder fails mid-recording, what it had already handed over becomes a clip and is
uploaded like any other, and only then is `recorder_failed` reported (`#onRecorderError`,
`apps/web/lib/meeting-recorder.ts:342`). The studio shows `meeting-record-kept` ("salvaged") beside the
error, and Dismiss on the error keeps the clip (`clearError`, `:183`). A failure before the first
chunk has nothing to keep and reads as it always did. `meeting-record-kept-dismiss` clears the
notice; the next Record clears it too.

### Audio only, and why the video track exists at all

`getDisplayMedia` will not offer a *tab* picker unless video is requested, so `mic+tab` asks for
`{ video: true, audio: true }` and stops the video track the instant the stream arrives
(`#mixInDisplayAudio`). Nothing ever records it. The tab's audio is then summed with the microphone
through an `AudioContext` `MediaStreamDestination`, and that mixed stream is what `MediaRecorder`
sees, which is the whole point: it is what puts an online meeting's **remote** voices into the
recording. A share that carries no audio track is refused as `display_no_audio` rather than
recording an hour of silence. `mic` alone opens no `AudioContext` at all.

### The cap, and its relationship to the host

`RECORDING_MAX_BYTES` (`meeting-recorder.ts`) is a **deliberate duplicate** of
`MEETING_RECORDING_MAX_BYTES` (`packages/host/src/meeting/store-files.ts:36`). The renderer must not
import `@agentforge/host` and `@agentforge/core` exports no meeting file limit, so the number is
restated and pinned by a test rather than shared. Two mechanisms keep an upload under it:

1. **Bitrate.** `audioBitsPerSecond: 24_000` (speech opus) is about 10.8 MB an hour, under half the
   cap, so an ordinary meeting is never close.
2. **A running count.** `MediaRecorder` is started with a 1 s timeslice, so each `dataavailable`
   chunk updates the total; crossing `RECORDING_MAX_BYTES - RECORDING_STOP_MARGIN_BYTES` (512 KB)
   auto-stops with `capped: true`, keeping everything captured and telling the owner
   (`meeting-record-capped`). The margin exists because a chunk is only measured after it arrives.

**The host needed no change.** `isMeetingMedia` lowercases and splits on `;` before testing
`MEETING_AUDIO_TYPES`, which already carries `audio/webm`, so `audio/webm;codecs=opus` is accepted ,
driven on webdev 2026-09-21, `201`, `status: "recorded"`. One cosmetic wrinkle: `EXT_BY_MIME` maps
`audio/webm` to `weba`, so a file named `recording-<iso>.webm` is stored as `recording/source.weba`.
ffmpeg reads by content, so `extractMeetingAudio` does not care.

### Gotchas

- **`dispose()` must not be terminal.** `apps/web/src/main.tsx` renders under `<StrictMode>`, so
  React mounts, runs the unmount cleanup and mounts again against the *same* controller, the hook
  holds it in a ref. The first build set a permanent `disposed` flag there, and Record became
  silently inert: pressed, and nothing happened at all, no error, no state. Thirty-six unit tests
  passed; only driving `/meeting` in a browser found it. The controller now carries a **generation
  token**: `start()` and `dispose()` both bump it, an async step whose generation has been
  superseded releases what it opened and reports nothing, and dispose is an ordinary boundary.
- **A leaked microphone track is an OS recording indicator that never goes away.** Every failure
  path releases what it opened, and each test asserts the tracks, not just the state.
- **Error codes are copy, not a generic failure.** Nine of them (`permission_denied`, `no_device`,
  `display_cancelled`, `display_no_audio`, `insecure_context`, `unsupported_browser`,
  `display_unsupported`, `recorder_failed`, `empty_recording`), each with a sentence in both
  catalogs under `meeting.record.errors.*`. They are looked up by template, so the catalog parity
  test cannot see them, `meeting-recorder-render.test.tsx` renders the panel once per code per
  locale instead.
- **Recording needs a secure context.** Webdev on `127.0.0.1` qualifies; a LAN IP over http does
  not, and is refused up front as `insecure_context` before the owner is asked for anything.
- **Capture itself is unverified.** The Browser pane blocks `getUserMedia` outright, so a granted
  microphone, the tab picker, the AudioContext mix and the resulting webm's decodability have never
  run. See the `unreleased.md` entry for exactly what was and was not driven.
