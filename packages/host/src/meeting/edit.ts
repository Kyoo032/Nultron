/**
 * Meeting mode — the owner's own changes to a decision or an action item.
 *
 * An edit is free (no model call) and is saved with the meeting: the item is marked `edited`, keeps
 * its quote and its evidence verdict, and a later regenerate keeps it (`keepEditedItems` in `./run.ts`).
 * The minutes are saved again as an artifact so the Knowledge card and the download say what the owner
 * now says; the artifact they replace, and the translation, which described the old words, go with it.
 */

import { ApiError, type TenantContext } from "@agentforge/core";
import {
  applyMinutesItemEdit,
  itemNotFoundMessage,
  minutesRequiredMessage,
  MinutesEditError,
  type MeetingMinutes,
  type MinutesItemEdit,
} from "@agentforge/core/meeting";
import { assertSafeSourceText } from "../job-source";
import { localeForRun } from "../run-context";
import { loadSettings } from "../settings-store";
import { removeMeetingArtifactsById } from "./artifacts";
import { saveMinutesArtifact } from "./minutes-artifact";
import { meetingStore, requireMeeting, type MeetingRecord } from "./store";

/** What the owner typed goes into the translation prompt later, so it passes the injection guard now. */
function assertSafeEdit(tenant: TenantContext, edit: MinutesItemEdit): void {
  const typed = Object.values(edit.set)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  assertSafeSourceText(typed, { injectionGuardBypass: loadSettings(tenant).injectionGuardBypass === true });
}

function applyOrRefuse(minutes: MeetingMinutes, edit: MinutesItemEdit): MeetingMinutes {
  try {
    return applyMinutesItemEdit(minutes, edit);
  } catch (error) {
    if (error instanceof MinutesEditError) {
      throw new ApiError("not_found", itemNotFoundMessage(localeForRun()), 404);
    }
    throw error;
  }
}

/** Change one decision or action item of the stored minutes. Returns the meeting as it now is. */
export async function editMeetingMinutes(
  tenant: TenantContext,
  meetingId: string,
  edit: MinutesItemEdit,
): Promise<MeetingRecord> {
  const meeting = requireMeeting(tenant, meetingId);
  const current = meeting.minutes;
  if (!current) {
    throw new ApiError("invalid_request", minutesRequiredMessage(localeForRun()), 400);
  }
  assertSafeEdit(tenant, edit);
  const edited = applyOrRefuse(current.minutes, edit);
  const saved = await saveMinutesArtifact(tenant, meeting, { ...current, minutes: edited, artifactId: "" }, "minutes");
  // Only drop what was replaced once its replacement exists: a failed save must not cost the owner both.
  if (saved.artifactId !== "") {
    removeMeetingArtifactsById(tenant, [current.artifactId, meeting.translation?.artifactId ?? ""]);
  }
  return meetingStore().update(tenant, meetingId, { minutes: saved, translation: null });
}
