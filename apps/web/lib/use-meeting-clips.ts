"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { t } from "./i18n";
import { onSameDesk, stashRescuedClip, takeRescuedClips, type ClipTarget, type RescuedClip } from "./meeting-rescue";
import { saveClipToDevice, type UploadOutcome } from "./meeting-upload";
import { useMeetingRecorder } from "./use-meeting-recorder";
import { useMeetingUpload } from "./use-meeting-upload";
import { useWorkspaceScope } from "./workspace-scope";

/**
 * The recorder and everything that keeps its recording from being lost, for the Meeting studio.
 *
 * A recording is the one thing in this app that cannot be produced again, so three things hold it until the
 * host has it: the upload queue (`MeetingUploadController`: held until a 2xx, Retry, Save to device), the
 * rescue slot (a desk or language switch unmounts the studio under a running recording; the next studio takes
 * what was captured) and the target (a recording belongs to the meeting selected when Record was pressed,
 * whatever row is selected by the time it stops). All of that is here, so the studio only says which meeting
 * a recording is for and how a clip is sent.
 */
export function useMeetingClips({
  send,
  busy,
  selectedIdRef,
  onSelectMeeting,
}: {
  /** The one POST of a clip: the same route a chosen file takes, to the meeting the clip was recorded for. */
  readonly send: (meetingId: string, file: File) => Promise<UploadOutcome>;
  /** A create or an upload is in flight: a clip waits in the queue rather than racing it. */
  readonly busy: boolean;
  readonly selectedIdRef: MutableRefObject<string | null>;
  /** A rescued recording for a meeting nothing else selects takes the selection. */
  readonly onSelectMeeting: (id: string) => void;
}) {
  const { id: workspaceId } = useWorkspaceScope();
  /** The meeting of the clip in the upload queue, for the notice that names it. */
  const [clipTarget, setClipTarget] = useState<ClipTarget | null>(null);
  /** The last recording ended early and what it captured was kept, and why. */
  const [kept, setKept] = useState<"salvaged" | "interrupted" | null>(null);
  /** Recordings rescued from an unmounted studio that have not been queued: see `stashRescuedClip`. */
  const [held, setHeld] = useState<readonly RescuedClip[]>([]);
  /** Set when Record is pressed. */
  const recordingTargetRef = useRef<ClipTarget | null>(null);
  /** The meeting of the clip the upload queue holds: what `sendClip`, and so Retry, posts to. */
  const clipTargetRef = useRef<ClipTarget | null>(null);
  /** `held` as of now rather than as of the last render, for the stash on unmount. */
  const heldRef = useRef<readonly RescuedClip[]>([]);

  // Unmounted mid-recording (a desk or language change): what was captured goes to the next studio.
  const recorder = useMeetingRecorder(undefined, (clip) => {
    const target = recordingTargetRef.current;
    if (target) {
      stashRescuedClip({ clip, target });
    } else {
      // Unreachable, since Record sets the target first; but a recording is never simply dropped.
      saveClipToDevice(clip);
    }
  });

  function sendClip(file: File): Promise<UploadOutcome> {
    const target = clipTargetRef.current;
    if (!target) {
      return Promise.resolve({ ok: false, message: t("meeting.errors.noMeeting") });
    }
    return send(target.id, file);
  }

  const upload = useMeetingUpload(sendClip);
  const { clip: recordedClip, clearClip, status: recorderStatus } = recorder;
  const { offer: offerClip, setBlocked, recordingStarted, pending: pendingClip } = upload;
  const pendingClipRef = useRef(pendingClip);
  pendingClipRef.current = pendingClip;

  /** True while the microphone is open: choosing a file mid-recording would fight it for the slot. */
  const recording = recorderStatus !== "idle" && recorderStatus !== "error";

  useEffect(() => {
    if (!recordedClip) {
      return;
    }
    // Ownership moves first; only then is the recorder's copy dropped. The clip goes to the meeting
    // Record was pressed for, and a failed recorder hands over what it had captured the same way.
    const target = recordingTargetRef.current;
    if (target) {
      clipTargetRef.current = target;
      setClipTarget(target);
      offerClip(recordedClip);
    } else {
      saveClipToDevice(recordedClip);
    }
    if (recorderStatus === "error") {
      setKept("salvaged");
    }
    clearClip();
  }, [recordedClip, recorderStatus, clearClip, offerClip]);

  // Busy is a queue, not a bin: a clip offered mid-upload waits here instead of being dropped.
  // The clip carries its own meeting, so what is selected now does not decide whether it can go.
  useEffect(() => {
    setBlocked(busy);
  }, [setBlocked, busy]);

  // A new recording replaces the last one's notices; nothing else clears them but Dismiss.
  useEffect(() => {
    if (recorderStatus === "requesting-permission" || recorderStatus === "recording") {
      recordingStarted();
      setKept(null);
    }
  }, [recorderStatus, recordingStarted]);

  // A previous studio was unmounted with a recording in hand. Take it: see `stashRescuedClip`.
  useEffect(() => {
    const rescued = takeRescuedClips().filter(
      (entry) => !heldRef.current.some((existing) => existing.clip === entry.clip),
    );
    if (rescued.length > 0) {
      heldRef.current = [...heldRef.current, ...rescued];
      setHeld(heldRef.current);
    }
    return () => {
      // Unmounting in turn: whatever has not reached the host moves on to the next studio.
      const pending = pendingClipRef.current;
      const target = clipTargetRef.current;
      if (pending && target) {
        stashRescuedClip({ clip: pending, target });
      }
      for (const entry of heldRef.current) {
        stashRescuedClip(entry);
      }
      heldRef.current = [];
    };
  }, []);

  // One rescued recording at a time goes into the upload queue, once it is free and on its desk.
  // A recording from another desk stays held: the host would answer its meeting with 404 here.
  useEffect(() => {
    if (pendingClip || recording) {
      return;
    }
    const next = held.find((entry) => onSameDesk(entry.target, workspaceId));
    if (!next) {
      return;
    }
    heldRef.current = heldRef.current.filter((entry) => entry !== next);
    setHeld(heldRef.current);
    clipTargetRef.current = next.target;
    setClipTarget(next.target);
    setKept("interrupted");
    if (selectedIdRef.current === null) {
      onSelectMeeting(next.target.id);
    }
    offerClip(next.clip);
  }, [held, pendingClip, recording, workspaceId, offerClip, selectedIdRef, onSelectMeeting]);

  /** Record, fixing the meeting it is for. The list stays locked until it stops. */
  function beginRecording(meeting: { readonly id: string; readonly title: string }) {
    recordingTargetRef.current = { id: meeting.id, title: meeting.title, workspaceId };
    recorder.start();
  }

  return {
    recorder,
    upload,
    recording,
    kept,
    dismissKept: () => setKept(null),
    clipTarget,
    /** Recordings held for a meeting on another desk: shown by title, saved by key. */
    otherDeskClips: held.filter((entry) => !onSameDesk(entry.target, workspaceId)),
    beginRecording,
    /** Notices about a clip must never sit in a closed box: Retry and Save to device keep a recording alive. */
    needsAttention:
      recording || upload.pending !== null || upload.capped || kept !== null || recorder.errorCode !== null,
  };
}
