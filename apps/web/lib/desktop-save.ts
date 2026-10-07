/**
 * What a failed save in the packaged app looks like to the renderer.
 *
 * The shell answers every save (`host:save-bytes`, apps/desktop/main.cjs) with `{ ok: true }` or
 * `{ ok: false, reason }`. A closed dialog (`canceled`) is the person's own choice and says nothing;
 * every other refusal (the disk would not take the file, the file is too large, the name or the sender
 * was refused) throws a `DesktopSaveError` carrying the reason and a sentence in the owner's language,
 * so a download button can say it did not save instead of looking as though it had.
 */
import type { DesktopSaveResult } from "./desktop-bridge";
import { t } from "./i18n";

/** The reason the shell uses when the person closed the save dialog. Not a failure. */
export const SAVE_CANCELED = "canceled";

function sentenceFor(reason: string | undefined): string {
  switch (reason) {
    case "write-failed":
      return t("common.saveFailed.writeFailed");
    case "too-large":
      return t("common.saveFailed.tooLarge");
    default:
      return t("common.saveFailed.generic");
  }
}

export class DesktopSaveError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "DesktopSaveError";
    this.reason = reason;
  }
}

/** Throws when the shell said the file was not saved and the person did not just close the dialog. */
export function throwIfSaveFailed(result: DesktopSaveResult | undefined): void {
  if (!result || result.ok || result.reason === SAVE_CANCELED) {
    return;
  }
  const reason = result.reason ?? "unknown";
  throw new DesktopSaveError(reason, sentenceFor(result.reason));
}

/** The sentence to show for a failed save, or null when `error` is anything else. */
export function saveFailureMessage(error: unknown): string | null {
  return error instanceof DesktopSaveError ? error.message : null;
}
