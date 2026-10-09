/**
 * The Meeting desk's JSON and file requests that are not a stream: create a meeting, save a pasted
 * transcript, send a transcript file, edit one minutes item.
 *
 * All four answer the meeting, and all four follow the order `postMeetingRecording` uses since SR-45:
 * `res.ok` before the body, an error body read with a catch, and a dead network reported rather than
 * thrown. A 2xx whose body is not a meeting still counts as done; the caller reloads the list to show it.
 */
import type { MinutesItemEdit } from "@agentforge/core/meeting";
import { apiFetch } from "@/lib/api-client";
import { messageUnlessBlocked } from "@/lib/gateway-blocked";
import { t } from "@/lib/i18n";
import type { Meeting } from "./meeting-types";
import type { MeetingApiFetch, UploadOutcome } from "./meeting-upload";

export function errorMessage(payload: unknown, fallback: string): string {
  // Hosted only: a 403 gateway_blocked is "no usable key", said as the catalog sentence (`gateway-blocked.ts`).
  const blocked = messageUnlessBlocked(payload, () => "");
  if (blocked) {
    return blocked;
  }
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  return fallback;
}

/** A body that is a meeting, or null when the host answered 2xx with something else. */
export function asMeeting(value: unknown): Meeting | null {
  return value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? (value as Meeting)
    : null;
}

export type MeetingRequestOutcome =
  | { readonly ok: true; readonly meeting: Meeting | null }
  | { readonly ok: false; readonly message: string };

type JsonMethod = "POST" | "PUT";

/** One JSON request, answered with the meeting. */
async function sendJson(
  method: JsonMethod,
  path: string,
  body: unknown,
  fallback: string,
  fetcher: MeetingApiFetch,
): Promise<MeetingRequestOutcome> {
  let res: Response;
  try {
    res = await fetcher(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.message ? error.message : fallback };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    return { ok: false, message: errorMessage(payload, fallback) };
  }
  const payload = await res.json().catch(() => null);
  return { ok: true, meeting: asMeeting(payload) };
}

/**
 * Create a meeting or save a pasted transcript: one JSON POST, answered with the meeting.
 *
 * Both callers used to read `res.json()` first with no `catch`, so an html error page or an offline
 * laptop threw a rejection nothing handled and the owner saw no message at all.
 */
export function requestMeeting(
  path: string,
  body: unknown,
  fallback: string,
  fetcher: MeetingApiFetch = apiFetch,
): Promise<MeetingRequestOutcome> {
  return sendJson("POST", path, body, fallback, fetcher);
}

/**
 * The owner's change to one decision or action item of the stored minutes. Free (no model call): the host
 * marks the item `edited`, keeps its quote, and answers the meeting as it now is, with the translation, which
 * described the old words, cleared.
 */
export function putMinutesEdit(
  meetingId: string,
  edit: MinutesItemEdit,
  fetcher: MeetingApiFetch = apiFetch,
): Promise<MeetingRequestOutcome> {
  return sendJson("PUT", `/api/v1/meetings/${meetingId}/minutes/edits`, edit, t("meeting.errors.edit"), fetcher);
}

/**
 * A transcript the owner already has, as a file: one multipart POST under the field `file`, read locally
 * on the host and free (`POST /api/v1/meetings/:id/transcript/file`). The host refuses a scan, an
 * encrypted file or one that is too long with a sentence of its own, which is shown as it came.
 */
export async function postMeetingTranscriptFile(
  meetingId: string,
  file: File,
  fetcher: MeetingApiFetch = apiFetch,
): Promise<UploadOutcome> {
  const form = new FormData();
  form.set("file", file, file.name);
  const fallback = t("meeting.errors.transcriptFile");
  let res: Response;
  try {
    res = await fetcher(`/api/v1/meetings/${meetingId}/transcript/file`, { method: "POST", body: form });
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.message ? error.message : fallback };
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    return { ok: false, message: errorMessage(payload, fallback) };
  }
  try {
    return { ok: true, meeting: await res.json() };
  } catch {
    // A 2xx the host could not serialise: the transcript is stored, and a reload shows it.
    return { ok: true, meeting: null };
  }
}
