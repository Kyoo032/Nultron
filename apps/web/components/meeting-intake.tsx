"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { WorkingStatus } from "@/components/working-status";
import { t } from "@/lib/i18n";
import { MEETING_FILE_ACCEPT } from "@/lib/meeting-intake";
import { PROMPT_ACTIONS, PROMPT_INPUT, PROMPT_ROW } from "@/lib/prompt-row";

export type MeetingIntakeProps = {
  readonly prompt: string;
  readonly onPrompt: (value: string) => void;
  readonly paste: string;
  readonly onPasteChange: (value: string) => void;
  /** Save the pasted text as the meeting's transcript. Free. */
  readonly onSavePaste: () => void;
  /** The paste option is offered only while the meeting has no transcript of its own. */
  readonly showPaste: boolean;
  /** The Run job itself is going. */
  readonly running: boolean;
  /** Any job is going (a run or a translation): Cancel is offered. */
  readonly jobBusy: boolean;
  /** A create, an upload or a paste save is in flight. */
  readonly busy: boolean;
  readonly uploading: boolean;
  /** A recording is being made, or a request is in flight: the picker and the drop do nothing. */
  readonly fileDisabled: boolean;
  /** There is a recording or a transcript to run on. */
  readonly hasSource: boolean;
  readonly hasMinutes: boolean;
  /** Hosted, signed in, no key yet: Run waits. */
  readonly needsKey: boolean;
  readonly alwaysTranslate: boolean;
  /** The meeting on the desk, named beside a way to start another; null when none is selected. */
  readonly meetingTitle: string | null;
  readonly recording: { readonly name: string; readonly bytes: number } | null;
  readonly transcriptWords: number | null;
  /** A line about the last drop: more than one file, or a file that is neither a recording nor a transcript. */
  readonly notice: string | null;
  /** The first file of a drop or a pick, and how many came with it. */
  readonly onFile: (file: File, count: number) => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  /** Clear the desk, so the next file starts another meeting. */
  readonly onNew: () => void;
};

function readableSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * The Meeting desk's front door: one prompt box, a drop zone for a recording or a transcript, a paste
 * option and Run. Prompt first (Rizky, 2026-10-05): no form up front, files optional beyond the one the
 * meeting is about, and nothing paid until Run, which says it uses the key.
 *
 * Presentation and the drop's browser events only; what a file does after it lands (create the meeting,
 * upload it) is the studio's, which owns the requests.
 */
export function MeetingIntake(props: MeetingIntakeProps) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  function take(files: FileList | readonly File[] | null) {
    const list = files ? Array.from(files) : [];
    const [first] = list;
    if (first) {
      props.onFile(first, list.length);
    }
    // The same file may be chosen again after it was refused or replaced.
    if (input.current) {
      input.current.value = "";
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (!props.fileDisabled) {
      take(event.dataTransfer.files);
    }
  }

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    if (props.fileDisabled) {
      return;
    }
    event.preventDefault();
    setDragging(true);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    props.onRun();
  }

  const note = props.alwaysTranslate ? t("meeting.runNoteTranslate") : t("meeting.runNote");
  const runLabel = props.hasMinutes ? t("meeting.runAgain") : t("meeting.run");

  return (
    <form
      className="mt-6 space-y-4 rounded-xl border border-[var(--line)] p-3 sm:p-4"
      onSubmit={onSubmit}
      data-testid="meeting-prompt-bar"
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor="meeting-prompt" className="text-sm text-[var(--text-2)]">
            {t("meeting.prompt.label")}
          </label>
          {props.meetingTitle !== null ? (
            <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--text-3)]">
              <span className="min-w-0 max-w-[16rem] truncate" data-testid="meeting-current">
                {props.meetingTitle}
              </span>
              <button
                type="button"
                onClick={props.onNew}
                disabled={props.fileDisabled}
                className="inline-flex h-7 shrink-0 items-center rounded-pill border border-[var(--line)] px-3 text-xs text-[var(--text)] disabled:opacity-45"
                data-testid="meeting-start-new"
              >
                {t("meeting.startNew")}
              </button>
            </span>
          ) : null}
        </div>
        <div className={`${PROMPT_ROW} mt-1.5`}>
          <input
            id="meeting-prompt"
            type="text"
            value={props.prompt}
            onChange={(event) => props.onPrompt(event.target.value)}
            className={PROMPT_INPUT}
            placeholder={t("meeting.prompt.placeholder")}
            maxLength={2000}
            disabled={props.jobBusy}
            aria-describedby="meeting-run-note"
            data-testid="meeting-prompt"
          />
          <div className={PROMPT_ACTIONS}>
            {props.jobBusy ? (
              <button
                type="button"
                onClick={props.onCancel}
                className="wash inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-transparent px-3 text-xs text-[var(--text)] hover:bg-[var(--accent-soft)]"
                data-testid="meeting-cancel"
              >
                {t("meeting.cancel")}
              </button>
            ) : null}
            <button
              type="submit"
              className="btn btn-primary h-8 shrink-0 rounded-pill px-4"
              disabled={props.jobBusy || props.busy || props.needsKey || !props.hasSource}
              data-testid="meeting-run"
            >
              {props.running ? <WorkingStatus label={t("meeting.running")} /> : runLabel}
            </button>
          </div>
        </div>
        <p id="meeting-run-note" className="mt-1.5 text-xs text-[var(--text-3)]" data-testid="meeting-run-note">
          {note}
        </p>
      </div>

      <div>
        <label
          className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center text-sm focus-within:border-[var(--accent)] ${
            dragging ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)]"
          } ${props.fileDisabled ? "cursor-not-allowed opacity-60" : ""}`}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="meeting-drop"
          data-dragging={dragging ? "true" : undefined}
        >
          <input
            ref={input}
            type="file"
            accept={MEETING_FILE_ACCEPT}
            className="sr-only"
            disabled={props.fileDisabled}
            onChange={(event) => take(event.target.files)}
            data-testid="meeting-file"
          />
          {dragging ? (
            <span className="font-medium text-[var(--text)]">{t("meeting.drop.over")}</span>
          ) : props.recording || props.transcriptWords !== null ? (
            <>
              {props.recording ? (
                <span className="font-medium text-[var(--text)]" data-testid="meeting-recording">
                  {t("meeting.uploaded", { name: props.recording.name, size: readableSize(props.recording.bytes) })}
                </span>
              ) : (
                <span className="font-medium text-[var(--text)]" data-testid="meeting-transcript-ready">
                  {t("meeting.transcriptReady", { words: String(props.transcriptWords) })}
                </span>
              )}
              <span className="text-xs text-[var(--text-3)]">{t("meeting.drop.another")}</span>
            </>
          ) : (
            <>
              <span className="font-medium text-[var(--text)]">{t("meeting.drop.title")}</span>
              <span className="max-w-[var(--content-narrow)] text-xs text-[var(--text-3)]">
                {t("meeting.drop.hint")}
              </span>
              <span className="mt-1 inline-flex h-8 items-center rounded-pill border border-[var(--line)] px-4 text-xs text-[var(--text)]">
                {t("meeting.drop.choose")}
              </span>
            </>
          )}
        </label>
        <div className="mt-2 space-y-1">
          {props.uploading ? <WorkingStatus label={t("meeting.uploading")} testId="meeting-uploading" /> : null}
          {props.notice ? (
            <p className="text-xs text-[var(--danger)]" role="status" data-testid="meeting-drop-notice">
              {props.notice}
            </p>
          ) : null}
          <p className="text-xs text-[var(--text-3)]">{t("meeting.drop.free")}</p>
        </div>
      </div>

      {props.showPaste ? (
        <details className="rounded-lg border border-[var(--line)] px-3 py-2" data-testid="meeting-how">
          <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">
            {t("meeting.orPaste")}
          </summary>
          <textarea
            id="meeting-paste"
            value={props.paste}
            onChange={(event) => props.onPasteChange(event.target.value)}
            placeholder={t("meeting.pastePlaceholder")}
            rows={5}
            className="mt-2 w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
            data-testid="meeting-paste"
          />
          <button
            type="button"
            onClick={props.onSavePaste}
            disabled={props.busy || !props.paste.trim()}
            className="mt-2 inline-flex h-8 items-center rounded-pill border border-[var(--line)] px-4 text-sm disabled:opacity-45"
            data-testid="meeting-save-paste"
          >
            {t("meeting.savePaste")}
          </button>
        </details>
      ) : null}
    </form>
  );
}
