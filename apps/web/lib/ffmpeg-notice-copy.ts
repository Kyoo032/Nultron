import type { EditDoctor } from "@/lib/edit-client";

/**
 * Which catalog line the onboarding setup check shows under the ffmpeg notice.
 *
 * The host marks the doctor's setup hint `bundled` when the failing ffmpeg is the packaged app's own copy
 * (`packages/host/src/edit/ffmpeg-setup.ts`). Then there is nothing to install later, only an app to reinstall;
 * every other case keeps the install-later line.
 */
export function onboardingFfmpegLaterKey(doctor: EditDoctor | null | undefined): string {
  return doctor?.ffmpeg?.setup?.bundled ? "onboarding.ffmpegBundledLater" : "onboarding.ffmpegLater";
}

/** The slice of the Meeting capability this reads. `ffmpegBundled` comes from the host, like `ffmpeg`. */
export type MeetingFfmpegCapability = { ffmpeg: boolean; ffmpegBundled?: boolean };

/**
 * The note the Meeting studio shows when a recording cannot be read for lack of ffmpeg, or null when it can.
 * In the packaged app (`ffmpegBundled`) the person is told to reinstall; elsewhere, that ffmpeg is not installed.
 */
export function meetingFfmpegNoteKey(capability: MeetingFfmpegCapability | null | undefined): string | null {
  if (!capability || capability.ffmpeg) {
    return null;
  }
  return capability.ffmpegBundled ? "meeting.noFfmpegBundled" : "meeting.noFfmpeg";
}
