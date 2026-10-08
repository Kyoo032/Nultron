/**
 * Unsent Chat composer text and files.
 *
 * `WorkModeKeepAlive` mounts every desk under a key that changes with the desk (`nextDeskKey`).
 * The shell starts with no desk id, then `GET /workspaces` names one. Before 2026-10-02 that
 * answer remounted the pane, and composer state died with the remount, which is how an
 * attachment made on a brand-new Chat disappeared before it was sent. The first id no longer
 * remounts anything; a switch to a different desk still does. This stash lives outside that
 * key and stays the safety net for the switch: a later desk id adopts the boot draft; a switch
 * to a different desk does not.
 */

export type ComposerDraftFile = {
  id: string;
  file: File;
  kind: string;
  /** A document's read state, kept so a finished read is not repeated after a remount. */
  read?: unknown;
};

type Stash = {
  workspaceId: string | null;
  text: string;
  files: ComposerDraftFile[];
};

let stash: Stash = { workspaceId: null, text: "", files: [] };

export function readComposerDraft(workspaceId: string | null): { text: string; files: ComposerDraftFile[] } {
  if (stash.workspaceId && workspaceId && stash.workspaceId !== workspaceId) {
    stash = { workspaceId, text: "", files: [] };
    return { text: "", files: [] };
  }
  if (stash.workspaceId == null && workspaceId) {
    stash = { ...stash, workspaceId };
  }
  return { text: stash.text, files: [...stash.files] };
}

export function writeComposerDraft(
  workspaceId: string | null,
  draft: { text: string; files: ComposerDraftFile[] },
): void {
  const id =
    stash.workspaceId && workspaceId && stash.workspaceId !== workspaceId
      ? workspaceId
      : (workspaceId ?? stash.workspaceId);
  stash = { workspaceId: id, text: draft.text, files: draft.files };
}

export function resetComposerDraftForTests(): void {
  stash = { workspaceId: null, text: "", files: [] };
}
