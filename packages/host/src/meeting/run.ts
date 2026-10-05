/**
 * Meeting mode — the run: recording → transcript → minutes sheet → the same sheet in the other language.
 *
 * Every phase is resumable on its own, because they fail for different reasons and for different
 * lengths of time. Transcription costs a gateway call per ten minutes of audio and is the step
 * worth not repeating, so it is persisted before the minutes are written. A desk with no
 * recogniser on its key skips straight to the minutes over a pasted transcript.
 *
 * The minutes call runs its checks and one repair round (`./minutes-checks`). Names, dates, and
 * figures the transcript does not support are then stripped in code, with no further model call.
 * The translation is asked once more only when it is not that same sheet, and when it still
 * disagrees the minutes stay and the translation is not saved.
 */

import { rm } from "node:fs/promises";
import {
  ApiError,
  gatewayRequiredMessage,
  hasLiveProvider,
  parseAppLocale,
  resolveChatModel,
  resolveRuntimeMode,
  withOutputLanguage,
  type AppLocale,
  type TenantContext,
} from "@agentforge/core";
import { harnessSpecFor } from "@agentforge/core/harness";
import {
  MEETING_MINUTES_SYSTEM,
  MEETING_TRANSLATE_SYSTEM,
  MeetingSheetError,
  MeetingTranslationError,
  emptyMinutesMessage,
  invalidMinutesMessage,
  meetingMinutesToMarkdown,
  meetingPhaseLabel,
  meetingTranscriptToMarkdown,
  minutesPrompt,
  settleParsedMinutes,
  transcriptPlainText,
  translateMeetingSheet,
  translationDisagreedMessage,
  type MeetingTranscript,
} from "@agentforge/core/meeting";
import { runChecked, type RunCheckedResult } from "../harness/run-checked";
import { artifactStore } from "../artifacts";
import { collectJobAssistantRun } from "../job-regen";
import type { JobEmitter } from "@agentforge/core/jobs";
import { throwIfJobAborted } from "../job-stream";
import { artifactWorkCard } from "../work-cards";
import { upsertWorkSource } from "../knowledge-ingest";
import { loadSettings, type SettingsScope } from "../settings-store";
import { modelCacheScopeOf } from "../model-cache";
import { listSelectableModels, modeDefaultsFor } from "../selectable-models";
import { localeForRun } from "../run-context";
import { log } from "../log";
import { recordTranscriptionUsage } from "../usage-record";
import { extractMeetingAudio, type ExtractedAudio } from "./audio";
import {
  buildMinutesChecks,
  minutesParseError,
  minutesRepairPrompt,
  parseMinutesDraft,
  summarizeMinutesChecks,
  type MinutesChecksSummary,
  type MinutesDraft,
} from "./minutes-checks";
import { meetingStore, requireMeeting, type MeetingRecord } from "./store";
import { resolveMeetingAsr, transcribeChunks } from "./transcribe";
import type { MeetingMinutesRecord, MinutesChecksRecord } from "./records";

const NO_EMIT: JobEmitter = () => {};

/** The language a set of minutes gets translated into: whichever of the two it is not in. */
export function otherLocale(locale: AppLocale): AppLocale {
  return locale === "en" ? "id" : "en";
}

function requireLiveMeetingRuntime(tenant: SettingsScope): void {
  const settings = loadSettings(tenant);
  const mode = resolveRuntimeMode({
    settingsHasKey: hasLiveProvider(settings),
    envRuntime: process.env.AGENTFORGE_RUNTIME,
  });
  if (mode === "stub") {
    throw new ApiError("runtime_stub", gatewayRequiredMessage("meeting", localeForRun()), 503);
  }
}

export function resolveMeetingModel(explicit: string | undefined, tenant: SettingsScope): string {
  const settings = loadSettings(tenant);
  const scope = modelCacheScopeOf(tenant);
  const defaults = modeDefaultsFor(scope);
  return resolveChatModel(explicit, settings.documentGenModel || defaults.meeting, listSelectableModels(scope));
}

/** Desk-locale copy for a translation that was not the sheet. The model never sees these strings. */
function meetingFailure(error: unknown): never {
  if (error instanceof MeetingTranslationError) {
    throw new ApiError("translation_disagreed", translationDisagreedMessage(localeForRun()), 502);
  }
  if (error instanceof MeetingSheetError) {
    const message =
      error.code === "generation_failed" ? emptyMinutesMessage(localeForRun()) : invalidMinutesMessage(localeForRun());
    throw new ApiError(error.code, message, 502);
  }
  throw error;
}

/** Saving an artifact never fails the run; the minutes are still returned to the caller. */
function persist(
  tenant: TenantContext,
  input: { kind: "transcript" | "minutes"; title: string; body: string; meta: Record<string, unknown> },
): string {
  try {
    return artifactStore().create(tenant, {
      mode: "meeting",
      kind: input.kind,
      title: input.title,
      mime: "text/markdown",
      body: input.body,
      meta: input.meta,
    }).id;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("meeting_artifact_not_saved", { code, kind: input.kind });
    return "";
  }
}

async function fileWorkCard(
  tenant: TenantContext,
  input: { artifactId: string; title: string; markdown: string; model: string },
): Promise<void> {
  if (!input.artifactId) {
    return;
  }
  try {
    await upsertWorkSource(
      tenant,
      artifactWorkCard({
        type: "Meeting",
        artifactId: input.artifactId,
        title: input.title,
        markdown: input.markdown,
        model: input.model,
      }),
    );
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("meeting_work_card_not_filed", { code });
  }
}

/**
 * Recording → transcript. Persists on the meeting before returning, so a later failure writing the
 * minutes never costs the transcription again.
 */
export async function transcribeMeeting(
  tenant: TenantContext,
  meetingId: string,
  options: { emit?: JobEmitter; abortSignal?: AbortSignal; language?: string } = {},
): Promise<MeetingRecord> {
  const emit = options.emit ?? NO_EMIT;
  const meeting = requireMeeting(tenant, meetingId);
  const source = meetingStore().recordingPath(tenant, meetingId);
  if (!source) {
    throw new ApiError("invalid_request", "Upload a recording before transcribing", 400);
  }
  const capability = resolveMeetingAsr(tenant);
  if (!capability.available) {
    throw new ApiError(
      "asr_unavailable",
      capability.reason === "no_key"
        ? "Save a gateway key in Settings before transcribing."
        : "This gateway key lists no speech-to-text model. Paste the transcript instead.",
      503,
    );
  }
  throwIfJobAborted(options.abortSignal);
  emit({ type: "job.phase", phase: "extracting", label: "Reading the recording" });
  const workspace = meetingStore().audioWorkspace(tenant, meetingId);
  try {
    // Inside the `try`: ffmpeg can fail after writing some chunks, and a cancel can land the moment
    // it finishes. Either way the chunks must not outlive the run.
    const audio = await extractMeetingAudio(source, workspace.dir, workspace.allow);
    throwIfJobAborted(options.abortSignal);
    emit({
      type: "job.phase",
      phase: "transcribing",
      label: `Transcribing with ${capability.model}`,
    });
    const transcript = await transcribeAndMeter(tenant, audio, {
      language: options.language ?? meeting.locale,
      model: capability.model ?? "",
      emit,
      abortSignal: options.abortSignal,
    });
    if (!transcriptPlainText(transcript)) {
      throw new ApiError("transcription_empty", "The recogniser returned nothing for that recording", 502);
    }
    return saveTranscript(tenant, meetingId, transcript);
  } finally {
    // The chunks are a cache of the recording, which is still on disk; keeping them would double
    // every meeting's footprint for nothing.
    await rm(workspace.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Every chunk through the recogniser, metered in seconds of audio. When a later chunk fails, the
 * chunks before it were still answered, and billed, by the gateway, so their share is recorded
 * before the error goes on.
 */
async function transcribeAndMeter(
  tenant: TenantContext,
  audio: ExtractedAudio,
  options: { language: string; model: string; emit: JobEmitter; abortSignal?: AbortSignal },
): Promise<MeetingTranscript> {
  let answered = 0;
  let transcript: MeetingTranscript;
  try {
    transcript = await transcribeChunks(audio.files, {
      language: options.language,
      tenant,
      offsets: audio.offsets,
      signal: options.abortSignal,
      onChunk: (current, total) => {
        // Announced before its chunk is sent, so every chunk before this one has answered.
        answered = current - 1;
        options.emit({ type: "job.step", phase: "transcribing", label: "Audio", current, total });
      },
    });
  } catch (error) {
    if (answered > 0) {
      // The first chunk that did not answer starts where the billed audio ends.
      recordTranscriptionUsage(tenant, {
        model: options.model,
        seconds: audio.offsets[answered] ?? audio.durationSeconds,
      });
    }
    throw error;
  }
  // Recorded before the transcript is judged: the gateway has already charged for the audio,
  // so a recogniser that answers with nothing is still a call the tenant pays for.
  recordTranscriptionUsage(tenant, {
    model: transcript.model || options.model,
    seconds: audio.durationSeconds,
  });
  return transcript;
}

/** Store a transcript — gateway-produced or pasted — and save it as an artifact. */
export function saveTranscript(tenant: TenantContext, meetingId: string, transcript: MeetingTranscript): MeetingRecord {
  const meeting = requireMeeting(tenant, meetingId);
  const markdown = meetingTranscriptToMarkdown(transcript, `${meeting.title} — transcript`);
  const artifactId = persist(tenant, {
    kind: "transcript",
    title: `${meeting.title} — transcript`,
    body: markdown,
    // `meetingId` ties the artifact to its meeting so deleting the meeting finds it (`./artifacts`).
    meta: { model: transcript.model, source: transcript.source, meetingId: meeting.id },
  });
  return meetingStore().update(tenant, meetingId, {
    status: "transcribed",
    transcript,
    transcriptArtifactId: artifactId,
  });
}

/** The minutes as written; `record.checks` holds what the checks made of them. */
type WrittenMinutes = { record: MeetingMinutesRecord };

/** The summary as the record keeps it: plain data, copied, so the record shares nothing with the run. */
function checksRecordOf(summary: MinutesChecksSummary): MinutesChecksRecord {
  return {
    passed: summary.passed,
    rounds: summary.rounds,
    verdicts: summary.verdicts.map((verdict) => ({ check: verdict.check, ok: verdict.ok })),
  };
}

/**
 * The minutes call, run until its checks pass or the one repair round is spent. Minutes that still
 * fail are kept, as they were before the checks existed: the person gets a draft to edit, and the
 * verdicts travel with it (`checks` in the artifact meta). Only minutes that never parse are an error.
 */
async function writeMinutes(
  tenant: TenantContext,
  meeting: MeetingRecord,
  transcript: string,
  locale: AppLocale,
  model: string,
  options: { emit: JobEmitter; signal?: AbortSignal; modelExplicit: boolean },
): Promise<WrittenMinutes> {
  const { signal, modelExplicit } = options;
  const basePrompt = minutesPrompt(transcript, { title: meeting.title });
  const checks = buildMinutesChecks(transcript);
  let last: MinutesDraft | null = null;

  const produce = async (repairNote: string | null): Promise<MinutesDraft> => {
    try {
      const run = await collectJobAssistantRun({
        tenant,
        model,
        modelExplicit,
        systemPrompt: withOutputLanguage(MEETING_MINUTES_SYSTEM, "meeting", locale),
        runPrefix: "meeting-minutes",
        agentId: "meeting",
        jobMode: "meeting",
        versionId: "meeting-minutes",
        prompt: last && repairNote ? minutesRepairPrompt(basePrompt, last.raw, repairNote) : basePrompt,
        locale,
        ...(signal ? { signal } : {}),
      });
      last = { raw: run.text, model: run.model, parsed: parseMinutesDraft(run.text) };
      return last;
    } catch (error) {
      throwIfJobAborted(signal);
      if (!last) {
        throw error;
      }
      // A repair that could not be asked is not a reason to lose the draft already in hand.
      log.warn("meeting_minutes_repair_failed", { code: error instanceof ApiError ? error.code : "internal_error" });
      return last;
    }
  };

  let result: RunCheckedResult<MinutesDraft>;
  try {
    result = await runChecked({
      produce,
      checks,
      repairRounds: harnessSpecFor("meeting").repairRounds,
      ...(signal ? { signal } : {}),
      onRound: () =>
        options.emit({ type: "job.step", phase: "minuting", label: meetingPhaseLabel("fixing", localeForRun()) }),
    });
  } catch (error) {
    // runChecked rethrows the signal's own reason; the job's cancel is its 499 `aborted`.
    throwIfJobAborted(signal);
    throw error;
  }
  const summary = summarizeMinutesChecks(checks, result);
  if (!summary.passed) {
    log.warn("meeting_minutes_checks_failed", {
      failed: summary.verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.check),
      rounds: summary.rounds,
    });
  }
  const { parsed } = result.output;
  if (!parsed.ok) {
    throw minutesParseError(parsed);
  }
  // The checks and the repair asked the model; this is the code's last word on names, dates and figures.
  const settled = settleParsedMinutes(parsed.minutes, transcript);
  if (settled.replacedNames > 0) {
    log.warn("meeting_minutes_names_guarded", { replaced: settled.replacedNames });
  }
  if (settled.clearedDates > 0 || settled.replacedFigures > 0) {
    log.warn("meeting_minutes_grounded", {
      clearedDates: settled.clearedDates,
      replacedFigures: settled.replacedFigures,
    });
  }
  options.emit({ type: "job.phase", phase: "grounding", label: meetingPhaseLabel("grounding", localeForRun()) });
  return {
    record: {
      locale,
      minutes: settled.minutes,
      artifactId: "",
      model: result.output.model,
      unverifiedNames: settled.unverifiedNames,
      checks: checksRecordOf(summary),
    },
  };
}

async function saveMinutesArtifact(
  tenant: TenantContext,
  meeting: MeetingRecord,
  record: MeetingMinutesRecord,
  suffix: string,
): Promise<MeetingMinutesRecord> {
  const markdown = meetingMinutesToMarkdown(record.minutes);
  const title = `${meeting.title} — ${suffix}`;
  const artifactId = persist(tenant, {
    kind: "minutes",
    title,
    body: markdown,
    meta: {
      model: record.model,
      locale: record.locale,
      unverifiedNames: record.unverifiedNames,
      meetingId: meeting.id,
      // Ids and pass/fail only: the meta is not encrypted, so no minutes text goes into it.
      ...(record.checks ? { checks: record.checks } : {}),
    },
  });
  await fileWorkCard(tenant, { artifactId, title, markdown, model: record.model });
  return { ...record, artifactId };
}

type MinutesRunOptions = {
  emit?: JobEmitter;
  abortSignal?: AbortSignal;
  model?: string;
  /**
   * The person picked `model` in the studio (`modelPinned` on the request, `readModelPinned`): the
   * minutes call, its repair and the translation then all stay on it and a gateway outage is the
   * run's error. Unset, `model` is the seeded default and the job model fallback may stand in for it.
   */
  modelExplicit?: boolean;
  translate?: boolean;
};

/**
 * Transcript → minutes in the meeting's own language, then the same minutes in the other one.
 * Translation is a second model call over the finished JSON rather than a second reading of the
 * transcript, so the two languages cannot disagree about what was decided. A translation that
 * changes the sheet is asked once more; if it still disagrees, the minutes stay and the
 * translation is not saved.
 */
export async function generateMinutes(
  tenant: TenantContext,
  meetingId: string,
  options: MinutesRunOptions = {},
): Promise<MeetingRecord> {
  const emit = options.emit ?? NO_EMIT;
  // The person picked `options.model` in the studio: a gateway outage is then the answer, never a stand-in.
  const modelExplicit = options.modelExplicit === true;
  // Ownership before the runtime gate: a meeting that is not this tenant's is refused the same way
  // whether or not the desk has a key, so a keyless desk cannot be used to probe another tenant's
  // ids, and the tenancy harness reaches this check under the stub runtime.
  const meeting = requireMeeting(tenant, meetingId);
  requireLiveMeetingRuntime(tenant);
  if (!meeting.transcript) {
    throw new ApiError("invalid_request", "Transcribe the recording, or paste a transcript, first", 400);
  }
  const transcript = transcriptPlainText(meeting.transcript);
  if (!transcript) {
    throw new ApiError("invalid_request", "That transcript is empty", 400);
  }
  const model = resolveMeetingModel(options.model, tenant);
  const locale = parseAppLocale(meeting.locale);

  throwIfJobAborted(options.abortSignal);
  emit({ type: "job.phase", phase: "minuting", label: meetingPhaseLabel("writing", localeForRun()) });
  const written = await writeMinutes(tenant, meeting, transcript, locale, model, {
    emit,
    signal: options.abortSignal,
    modelExplicit,
  });
  // Minutes the person cancelled are not saved as an artifact or a work card.
  throwIfJobAborted(options.abortSignal);
  emit({ type: "job.phase", phase: "saving", label: meetingPhaseLabel("saving", localeForRun()) });
  const minutes = await saveMinutesArtifact(tenant, meeting, written.record, "minutes");
  // On the meeting before the translation starts, so a translation that fails cannot take the
  // minutes with it. An earlier translation described earlier minutes, so it is cleared here.
  const minuted = meetingStore().update(tenant, meetingId, { status: "minuted", minutes, translation: null });
  if (options.translate === false) {
    return minuted;
  }

  throwIfJobAborted(options.abortSignal);
  const target = otherLocale(locale);
  const translation = await translateMinutes(
    tenant,
    meeting,
    minutes,
    target,
    model,
    options.abortSignal,
    modelExplicit,
    (attempt) =>
      emit({
        type: "job.phase",
        phase: "translating",
        label: meetingPhaseLabel(attempt === 1 ? "translating" : "translating-again", localeForRun()),
      }),
  );
  return meetingStore().update(tenant, meetingId, { translation });
}

/**
 * The finished minutes in the other language. The guards run again on the result: a translator
 * that hallucinates a name, a date or a figure is exactly as wrong as a writer that does, and the
 * transcript is still the only evidence either of them has. A translation that is not the same
 * sheet (counts, owners, dates, provisional marks, figures) is asked once more, and a second miss
 * is `translation_disagreed`: nothing is saved.
 */
export async function translateMinutes(
  tenant: TenantContext,
  meeting: MeetingRecord,
  source: MeetingMinutesRecord,
  target: AppLocale,
  model: string,
  signal?: AbortSignal,
  modelExplicit = false,
  onAttempt?: (attempt: 1 | 2) => void,
): Promise<MeetingMinutesRecord> {
  const transcript = meeting.transcript ? transcriptPlainText(meeting.transcript) : "";
  let answered = model;
  let settled: Awaited<ReturnType<typeof translateMeetingSheet>>;
  try {
    settled = await translateMeetingSheet({
      transcript,
      source: source.minutes,
      locale: target,
      ask: async (prompt) => {
        const run = await collectJobAssistantRun({
          tenant,
          model,
          modelExplicit,
          systemPrompt: withOutputLanguage(MEETING_TRANSLATE_SYSTEM, "meeting", target),
          runPrefix: "meeting-translate",
          agentId: "meeting",
          jobMode: "meeting",
          versionId: "meeting-translate",
          prompt,
          locale: target,
          ...(signal ? { signal } : {}),
        });
        answered = run.model;
        return run.text;
      },
      onAttempt,
    });
  } catch (error) {
    // A cancel is the job's 499 `aborted`, whatever the call it landed in threw.
    throwIfJobAborted(signal);
    return meetingFailure(error);
  }
  // A translation the person cancelled is not saved as a second artifact.
  throwIfJobAborted(signal);
  return saveMinutesArtifact(
    tenant,
    meeting,
    {
      locale: target,
      minutes: settled.minutes,
      artifactId: "",
      model: answered,
      unverifiedNames: settled.unverifiedNames,
      // The translation is not checked or repaired: it claims no verdicts.
      checks: null,
    },
    target === "id" ? "notulen" : "minutes (English)",
  );
}

/** The whole path in one call, for the studio's single button. */
export async function runMeeting(
  tenant: TenantContext,
  meetingId: string,
  options: MinutesRunOptions = {},
): Promise<MeetingRecord> {
  // Ownership first, as in `generateMinutes` above.
  const meeting = requireMeeting(tenant, meetingId);
  requireLiveMeetingRuntime(tenant);
  if (!meeting.transcript && meeting.recording) {
    await transcribeMeeting(tenant, meetingId, { emit: options.emit, abortSignal: options.abortSignal });
  }
  return generateMinutes(tenant, meetingId, options);
}
