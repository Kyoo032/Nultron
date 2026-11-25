"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { AppLocale } from "@agentforge/core/locale";
import { transcriptPlainText, type MinutesItemEdit } from "@agentforge/core/meeting";
import { JobProgressList } from "@/components/job-progress";
import { MeetingIntake } from "@/components/meeting-intake";
import { MeetingListRow } from "@/components/meeting-list-row";
import { MeetingMinutesPanel } from "@/components/meeting-minutes-panel";
import { MeetingMinutesView } from "@/components/meeting-minutes-view";
import { MeetingMore } from "@/components/meeting-more";
import { MeetingOtherDeskClips, MeetingRecorderPanel } from "@/components/meeting-recorder";
import { MeetingTranslateBar } from "@/components/meeting-translate-bar";
import { ModeHeader } from "@/components/mode-header";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { apiFetch } from "@/lib/api-client";
import { meetingFfmpegNoteKey } from "@/lib/ffmpeg-notice-copy";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { getLocale, t } from "@/lib/i18n";
import { useLocale } from "@/lib/locale-context";
import { Link } from "@/lib/nav";
import {
  classifyMeetingFile,
  promptForRun,
  titleFromFileName,
  titleFromTranscript,
  wordCount,
} from "@/lib/meeting-intake";
import {
  readAlwaysTranslate,
  readMeetingLanguage,
  writeAlwaysTranslate,
  writeMeetingLanguage,
} from "@/lib/meeting-prefs";
import {
  asMeeting,
  errorMessage,
  postMeetingTranscriptFile,
  putMinutesEdit,
  requestMeeting,
} from "@/lib/meeting-request";
import { rescuedKey } from "@/lib/meeting-rescue";
import type { Capability, Meeting, MeetingTab } from "@/lib/meeting-types";
import { postMeetingRecording, saveClipToDevice, type UploadOutcome } from "@/lib/meeting-upload";
import { modelPickBody, studioModelPick } from "@/lib/model-choice";
import { useProductBrand } from "@/lib/product-brand";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import { useJobModel } from "@/lib/use-job-model";
import { useJobStream } from "@/lib/use-job-stream";
import { useMeetingClips } from "@/lib/use-meeting-clips";

function mentionsSettings(message: string): boolean {
  return /gateway|api key|settings|runtime_stub|live gateway/i.test(message);
}

/** The tab a meeting opens on: the minutes once it has them, otherwise whatever it has to read. */
function tabFor(meeting: Meeting): MeetingTab {
  return meeting.minutes ? "minutes" : "transcript";
}

/** A title for a meeting nobody named: it starts from a recording made on the desk. */
function stampedTitle(): string {
  return `${t("meeting.untitled")} · ${new Date().toLocaleDateString(getLocale())}`;
}

export function MeetingStudio() {
  // Nultron Enterprise: a signed-in tenant may open the desk before adding a key. Hosted only; false elsewhere.
  // Recording and uploading are local, so only the transcribe-and-minute run waits for a key.
  const needsKey = useHostedNeedsKey();
  const { productName } = useProductBrand();
  const { models, model, pinned: modelPinned, setModel } = useJobModel("meeting");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const deskLocale = useLocale();
  // The language meetings are usually spoken in: what the owner last picked, else the desk's.
  const [locale, setLocale] = useState<AppLocale>(() => readMeetingLanguage(deskLocale));
  useEffect(() => {
    setLocale(readMeetingLanguage(deskLocale));
  }, [deskLocale]);
  const [alwaysTranslate, setAlwaysTranslate] = useState<boolean>(() => readAlwaysTranslate());
  const [prompt, setPrompt] = useState("");
  const [paste, setPaste] = useState("");
  const [tab, setTab] = useState<MeetingTab>("minutes");
  const [busy, setBusy] = useState<"create" | "upload" | "paste" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [jobKind, setJobKind] = useState<"run" | "translate" | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const job = useJobStream<Meeting>();

  const selected = meetings.find((meeting) => meeting.id === selectedId) ?? null;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // The recorder, its upload queue and the rescue of a recording that outlives its studio.
  const clips = useMeetingClips({ send: sendClipTo, busy: busy !== null, selectedIdRef, onSelectMeeting: setSelectedId });
  const { recorder, upload, recording, kept } = clips;

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/v1/meetings");
      const data = (await res.json().catch(() => null)) as { items?: Meeting[]; capability?: Capability } | null;
      if (!res.ok || !data) {
        setError(errorMessage(data, t("meeting.errors.load")));
        return;
      }
      setMeetings(data.items ?? []);
      setCapability(data.capability ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("meeting.errors.load"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Replace one meeting in place so the list does not jump while a job is running. `select: false`
   * is a recording that finished uploading after the owner had moved on: it updates its row without
   * taking the selection back, unless nothing else is selected.
   */
  function merge(meeting: Meeting, select = true) {
    setMeetings((current) =>
      current.some((item) => item.id === meeting.id)
        ? current.map((item) => (item.id === meeting.id ? meeting : item))
        : [meeting, ...current],
    );
    if (select || selectedIdRef.current === null) {
      setSelectedId(meeting.id);
    }
  }

  /**
   * A meeting to put a file, a pasted transcript or a recording on. `reuse` says which already-selected
   * meeting will do: "any" for a transcript pasted on a meeting that has a recording, "empty" for a drop,
   * which starts a new meeting unless the selected one has nothing in it yet (made from More). Creating is
   * free, and the new meeting is selected. Null, with the reason shown, when the host refused.
   */
  async function ensureMeeting(name: string, reuse: "any" | "empty"): Promise<Meeting | null> {
    if (selected && (reuse === "any" || (!selected.recording && !selected.transcript))) {
      return selected;
    }
    const outcome = await requestMeeting("/api/v1/meetings", { title: name, locale }, t("meeting.errors.create"));
    if (!outcome.ok) {
      setError(outcome.message);
      return null;
    }
    if (!outcome.meeting) {
      // The host made it but could not say which: the list shows it, and the owner drops the file again.
      await load();
      setError(t("meeting.errors.create"));
      return null;
    }
    merge(outcome.meeting);
    return outcome.meeting;
  }

  /** The manual create form under More: a title and a language, for an owner who wants to name it first. */
  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const name = title.trim();
    // Creating selects the new meeting, which would move the owner off the one being recorded.
    if (!name || busy || recording) {
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const outcome = await requestMeeting("/api/v1/meetings", { title: name, locale }, t("meeting.errors.create"));
      if (!outcome.ok) {
        // The title stays in the field for another try.
        setError(outcome.message);
        return;
      }
      setTitle("");
      setTab("transcript");
      if (outcome.meeting) {
        merge(outcome.meeting);
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * A file dropped on the desk, or picked: the meeting is created (named after the file, in the remembered
   * language) and the file goes on it. Both steps are free. A recording takes the recording route, a
   * transcript the transcript-file route, and nothing is run until the owner presses Run.
   */
  async function onFile(file: File, count: number) {
    if (busy || recording || job.busy) {
      return;
    }
    setError(null);
    const kind = classifyMeetingFile(file);
    if (kind === "unsupported") {
      setDropNotice(t("meeting.drop.unsupported"));
      return;
    }
    setDropNotice(count > 1 ? t("meeting.drop.oneFile") : null);
    setBusy("upload");
    try {
      const meeting = await ensureMeeting(titleFromFileName(file.name, t("meeting.untitled")), "empty");
      if (!meeting) {
        return;
      }
      const outcome =
        kind === "recording" ? await postMeetingRecording(meeting.id, file) : await postMeetingTranscriptFile(meeting.id, file);
      if (!outcome.ok) {
        // The meeting exists and is empty: the owner can drop a different file onto it.
        setError(outcome.message);
        return;
      }
      const updated = asMeeting(outcome.meeting);
      if (updated) {
        merge(updated);
        setTab(kind === "transcript" ? "transcript" : tabFor(updated));
      } else {
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  /** The recorder's POST: the same route a chosen file takes, to the meeting it was recorded for. */
  async function sendClipTo(meetingId: string, file: File): Promise<UploadOutcome> {
    setBusy("upload");
    setError(null);
    try {
      const outcome = await postMeetingRecording(meetingId, file);
      if (outcome.ok) {
        // A 2xx the host could not serialise is still stored; reloading shows it.
        const meeting = asMeeting(outcome.meeting);
        if (meeting) {
          merge(meeting, false);
        } else {
          void load();
        }
      }
      return outcome;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Record, fixing the meeting it is for. With no meeting selected one is made first (free), so Record
   * under More needs no form either. The list stays locked until it stops.
   */
  async function startRecording() {
    setError(null);
    const meeting = selected ?? (await ensureMeeting(stampedTitle(), "any"));
    if (!meeting) {
      return;
    }
    clips.beginRecording(meeting);
  }

  /**
   * Save the pasted words as the transcript of the selected meeting, making one first if there is none.
   * Free. Answers the meeting as it now is, so a Run pressed on pasted words can go straight on.
   */
  async function savePaste(text: string): Promise<Meeting | null> {
    setBusy("paste");
    setError(null);
    try {
      const meeting = await ensureMeeting(titleFromTranscript(text, t("meeting.untitled")), "any");
      if (!meeting) {
        return null;
      }
      const outcome = await requestMeeting(
        `/api/v1/meetings/${meeting.id}/transcript`,
        { text },
        t("meeting.errors.transcript"),
      );
      if (!outcome.ok) {
        // The pasted transcript stays in the box for another try.
        setError(outcome.message);
        return null;
      }
      setPaste("");
      setTab("transcript");
      if (outcome.meeting) {
        merge(outcome.meeting);
        return outcome.meeting;
      }
      await load();
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Run: the paid step. Words pasted but not yet saved are saved first (free), then the run goes on them. */
  async function onRun() {
    if (job.busy || busy || needsKey) {
      return;
    }
    setError(null);
    const pasted = paste.trim();
    const meeting = pasted && !selected?.transcript ? await savePaste(pasted) : selected;
    if (!meeting || (!meeting.transcript && !meeting.recording)) {
      return;
    }
    // With a transcript already in hand there is nothing to transcribe, so skip straight to the
    // minutes rather than asking the host to re-decide.
    const url = meeting.transcript
      ? `/api/v1/meetings/${meeting.id}/minutes/stream`
      : `/api/v1/meetings/${meeting.id}/run/stream`;
    const request = promptForRun(prompt);
    setJobKind("run");
    try {
      // `modelPinned` travels only for a model the person picked: the host then never swaps it for a
      // stand-in when the gateway cannot reach it (`model-choice.ts`). Translation is the owner's choice.
      const result = await job.run(url, {
        ...modelPickBody(studioModelPick(model, modelPinned)),
        translate: alwaysTranslate,
        ...(request ? { prompt: request } : {}),
      });
      if (result) {
        merge(result);
        setTab("minutes");
      }
    } finally {
      setJobKind(null);
    }
  }

  /** Translate the stored minutes to the other language: opt-in, one paid call, replaces an earlier one. */
  async function onTranslate() {
    const meeting = selected;
    if (!meeting?.minutes || job.busy || busy || needsKey) {
      return;
    }
    setError(null);
    setJobKind("translate");
    try {
      const result = await job.run(
        `/api/v1/meetings/${meeting.id}/translate/stream`,
        modelPickBody(studioModelPick(model, modelPinned)),
      );
      if (result) {
        merge(result);
        setTab("translation");
      }
    } finally {
      setJobKind(null);
    }
  }

  /** Save the owner's change to one item. Free. Answers the host's refusal, or null when it took it. */
  async function saveEdit(edit: MinutesItemEdit): Promise<string | null> {
    const meeting = selected;
    if (!meeting) {
      return t("meeting.errors.edit");
    }
    const outcome = await putMinutesEdit(meeting.id, edit);
    if (!outcome.ok) {
      return outcome.message;
    }
    if (outcome.meeting) {
      merge(outcome.meeting, false);
    } else {
      await load();
    }
    return null;
  }

  /** Second press of the two-step delete: the row's confirm panel calls this, never the × itself. */
  async function onDelete(id: string) {
    if (deleteBusy) {
      return;
    }
    setDeleteBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/meetings/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as unknown;
        setError(errorMessage(data, t("meeting.errors.delete")));
        return;
      }
      setMeetings((current) => current.filter((meeting) => meeting.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
      }
      setDeletingId(null);
    } catch {
      setError(t("meeting.errors.delete"));
    } finally {
      setDeleteBusy(false);
    }
  }

  /** Back to the front door with nothing on it: the next file starts another meeting. */
  function startNew() {
    if (recording || busy || job.busy) {
      return;
    }
    setSelectedId(null);
    setPrompt("");
    setPaste("");
    setDropNotice(null);
    setError(null);
    job.reset();
  }

  const blocked = capability && !capability.available;
  const ffmpegNoteKey = meetingFfmpegNoteKey(capability);
  const jobError = job.error ? job.error.message : null;
  const shown = error ?? jobError;
  const { otherDeskClips } = clips;
  const content = Boolean(selected && (selected.transcript || selected.minutes || selected.translation));
  const minutesLocale = selected?.minutes?.locale ?? "en";
  const targetLocale: AppLocale = minutesLocale === "id" ? "en" : "id";
  const editing = selected?.minutes
    ? {
        disabled: job.busy || busy !== null,
        clearsTranslation: selected.translation !== null,
        onSave: saveEdit,
      }
    : undefined;
  const translateBar = (
    <MeetingTranslateBar
      target={targetLocale}
      hasTranslation={selected?.translation != null}
      busy={job.busy && jobKind === "translate"}
      disabled={job.busy || busy !== null || needsKey}
      onTranslate={() => void onTranslate()}
    />
  );

  return (
    <main
      data-mode="meeting"
      className="mx-auto flex min-h-full max-w-[var(--content-stage)] flex-col px-6 py-10 text-[var(--text)]"
      data-testid="meeting-studio"
    >
      <ModeHeader icon="meeting" title={t("meeting.title")} outcome={t("meeting.subtitle")} />

      {needsKey ? <NeedsKeyNote testId="meeting-needs-key" className="mt-6 text-sm text-[var(--text-2)]" /> : null}
      {shown && !isGatewayBlockedText(shown) ? (
        <div
          className="mt-6 rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="meeting-error"
        >
          {shown}
          {mentionsSettings(shown) && !/settings/i.test(shown) ? (
            <>
              {" "}
              {t("meeting.openSettingsLead")}{" "}
              <Link href="/settings" className="underline">
                {t("meeting.settings")}
              </Link>
              .
            </>
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <p
          className="mt-4 rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--text-2)]"
          data-testid="meeting-no-asr"
        >
          {t("meeting.noAsr")}
        </p>
      ) : null}
      {ffmpegNoteKey ? (
        <p
          className="mt-4 rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--text-2)]"
          data-testid="meeting-no-ffmpeg"
        >
          {t(ffmpegNoteKey, { productName })}
        </p>
      ) : null}

      <MeetingOtherDeskClips
        items={otherDeskClips.map((entry) => ({ key: rescuedKey(entry), title: entry.target.title }))}
        onSave={(key) => {
          const entry = otherDeskClips.find((candidate) => rescuedKey(candidate) === key);
          if (entry) {
            saveClipToDevice(entry.clip);
          }
        }}
      />

      <MeetingIntake
        prompt={prompt}
        onPrompt={setPrompt}
        paste={paste}
        onPasteChange={setPaste}
        onSavePaste={() => void savePaste(paste.trim())}
        showPaste={!selected?.transcript}
        running={job.busy && jobKind === "run"}
        jobBusy={job.busy}
        busy={busy !== null}
        uploading={busy === "upload"}
        // Choosing a file mid-recording would race the clip that is about to arrive for the same upload slot.
        fileDisabled={busy !== null || recording || job.busy}
        hasSource={Boolean(selected?.recording || selected?.transcript || paste.trim())}
        hasMinutes={selected?.minutes != null}
        needsKey={needsKey}
        alwaysTranslate={alwaysTranslate}
        meetingTitle={selected?.title ?? null}
        recording={selected?.recording ?? null}
        transcriptWords={selected?.transcript ? wordCount(transcriptPlainText(selected.transcript)) : null}
        notice={dropNotice}
        onFile={(file, count) => void onFile(file, count)}
        onRun={() => void onRun()}
        onCancel={job.cancel}
        onNew={startNew}
      />

      <JobProgressList progress={job.progress} busy={job.busy} mode="meeting" testId="meeting-progress" />

      <MeetingMore
        open={moreOpen || clips.needsAttention}
        onOpenChange={setMoreOpen}
        title={title}
        onTitle={setTitle}
        locale={locale}
        onLocale={(value) => {
          setLocale(value);
          writeMeetingLanguage(value);
        }}
        onCreate={(event) => void onCreate(event)}
        createDisabled={busy !== null || recording}
        models={models}
        model={model}
        onModel={setModel}
        alwaysTranslate={alwaysTranslate}
        onAlwaysTranslate={(value) => {
          setAlwaysTranslate(value);
          writeAlwaysTranslate(value);
        }}
      >
        <MeetingRecorderPanel
          // A clip still in hand is a reason not to start another one: this controller
          // holds exactly one recording, and a second would replace bytes nothing else has.
          disabled={busy !== null || job.busy || upload.pending !== null}
          view={{ ...recorder, start: () => void startRecording() }}
          clip={{
            capped: upload.capped,
            status: upload.status,
            errorMessage: upload.errorMessage,
            dismissCapped: upload.dismissCapped,
            retry: upload.retry,
            save: () => {
              if (upload.pending) {
                saveClipToDevice(upload.pending);
              }
            },
            meetingTitle: upload.pending ? (clips.clipTarget?.title ?? null) : null,
            kept,
            dismissKept: clips.dismissKept,
          }}
        />
      </MeetingMore>

      <div className="mt-8 grid flex-1 content-start gap-6 md:grid-cols-[16rem_1fr]">
        <aside className="order-2 min-w-0 space-y-1 md:order-1" data-testid="meeting-list">
          {meetings.length === 0 ? (
            // One line only: the character belongs to the empty desk below, so it shows once.
            <p className="px-2 py-6 text-center text-sm text-[var(--text-2)]" data-testid="meeting-empty">
              {t("meeting.empty")}
            </p>
          ) : null}
          {meetings.map((meeting, index) => (
            <div key={meeting.id} className="enter-rise" style={{ "--i": index } as CSSProperties}>
              <MeetingListRow
                meeting={meeting}
                selected={meeting.id === selectedId}
                confirming={meeting.id === deletingId}
                deleting={deleteBusy}
                // The list is locked while recording, so the row being recorded is the selected one.
                locked={recording}
                deleteLocked={recording && meeting.id === selectedId}
                onSelect={() => {
                  if (!recording) {
                    setSelectedId(meeting.id);
                    setTab(tabFor(meeting));
                    setDropNotice(null);
                  }
                }}
                onAskDelete={() => setDeletingId(meeting.id)}
                onConfirmDelete={() => void onDelete(meeting.id)}
                onCancelDelete={() => setDeletingId(null)}
              />
            </div>
          ))}
        </aside>

        <section className="order-1 min-w-0 md:order-2">
          {selected && content ? (
            <>
              <nav className="flex flex-wrap gap-2 text-sm" data-testid="meeting-tabs">
                {(["transcript", "minutes", "translation"] as MeetingTab[]).map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setTab(name)}
                    className={`rounded-pill px-3 py-1 ${
                      tab === name ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-2)]"
                    }`}
                    data-testid={`meeting-tab-${name}`}
                  >
                    {name === "transcript"
                      ? t("meeting.transcript")
                      : name === "minutes"
                        ? t("meeting.minutesTab")
                        : t("meeting.translationTab")}
                  </button>
                ))}
              </nav>

              <div className="mt-4">
                {tab === "transcript" && selected.transcript ? (
                  <pre
                    className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--text-2)]"
                    data-testid="meeting-transcript"
                  >
                    {selected.transcript.text}
                  </pre>
                ) : null}
                {tab === "minutes" && selected.minutes ? (
                  <>
                    <MeetingMinutesPanel record={selected.minutes} {...(editing ? { editing } : {})} />
                    <div className="mt-4">{translateBar}</div>
                  </>
                ) : null}
                {tab === "translation" && selected.minutes ? (
                  selected.translation ? (
                    <div className="enter-rise">
                      <MeetingMinutesView minutes={selected.translation.minutes} testId="meeting-translation" />
                      <div className="mt-4">{translateBar}</div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-[var(--text-2)]" data-testid="meeting-translation-empty">
                        {t("meeting.translateEmpty", {
                          language: targetLocale === "id" ? t("meeting.languageIndonesian") : t("meeting.languageEnglish"),
                        })}
                      </p>
                      {translateBar}
                    </div>
                  )
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      </div>

      {selected || job.busy || job.progress.phases.length > 0 ? null : <StudioEmptyDesk mode="meeting" />}
    </main>
  );
}
