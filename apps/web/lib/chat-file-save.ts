/**
 * Saving a file a Chat answer made, through the artifact file route. The deck card and the document cards
 * both save this way, so the route, the native save dialog and the failure sentence live here once. A card
 * keeps only its own busy and failed state.
 *
 * It never throws: a save that did not happen comes back as `{ ok: false, reason }`, where `reason` is the
 * shell's own sentence when it said why (`DesktopSaveError`), and null when the generic sentence should show.
 */
import { downloadArtifactFile } from "@/lib/artifacts-client";
import { saveFailureMessage } from "@/lib/desktop-save";

export type ChatFileSaveResult = { readonly ok: true } | { readonly ok: false; readonly reason: string | null };

export async function saveChatFile(
  artifactId: string,
  filename: string,
  save: (artifactId: string, fallbackName: string) => Promise<void> = downloadArtifactFile,
): Promise<ChatFileSaveResult> {
  try {
    await save(artifactId, filename);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: saveFailureMessage(error) };
  }
}
