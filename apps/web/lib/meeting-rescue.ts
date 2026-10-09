/**
 * Meeting mode: a recording whose studio went away before the host had it.
 *
 * `WorkModeKeepAlive` keys every work mode on the desk id, so a desk switch, or a language restart,
 * unmounts the Meeting studio. The recorder hands back what it had captured and the upload queue still holds
 * whatever had not reached the host; both used to go with the component. They wait here, in module scope,
 * which outlives the pane, until the next studio mounts and takes them. This is memory, not storage: a page
 * reload still loses them.
 */
import type { RecordedClip } from "./meeting-recorder";

/** The meeting a recording belongs to: fixed when Record is pressed, never re-read from the list. */
export type ClipTarget = {
  readonly id: string;
  readonly title: string;
  /** The desk it was made on; null when the shell had not named one yet. */
  readonly workspaceId: string | null;
};

/** A recording whose studio went away before the host had it. */
export type RescuedClip = { readonly clip: RecordedClip; readonly target: ClipTarget };

let rescuedClips: readonly RescuedClip[] = [];

/** Keep a recording that outlived its studio. */
export function stashRescuedClip(entry: RescuedClip): void {
  if (rescuedClips.some((held) => held.clip === entry.clip)) {
    return;
  }
  rescuedClips = [...rescuedClips, entry];
}

/** Everything held, oldest first. The slot is empty afterwards. */
export function takeRescuedClips(): readonly RescuedClip[] {
  const taken = rescuedClips;
  rescuedClips = [];
  return taken;
}

/**
 * Whether a recording can be uploaded from this desk. The host resolves `/meetings/:id` against the
 * desk selected now, so a meeting on another desk answers 404. An unknown desk gets the benefit of
 * the doubt: if it is wrong, the upload fails and the clip is kept with Retry and Save to device.
 */
export function onSameDesk(target: ClipTarget, workspaceId: string | null): boolean {
  return target.workspaceId === null || workspaceId === null || target.workspaceId === workspaceId;
}

/** A stable key for a held recording, for the list and for Save. */
export function rescuedKey(entry: RescuedClip): string {
  return `${entry.target.id}:${entry.clip.filename}:${entry.clip.bytes}`;
}
