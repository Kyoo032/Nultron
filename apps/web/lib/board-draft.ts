/**
 * The card dialog's edit model. A draft is the person's boxes; the base is the card as the host last
 * sent it. A save sends only the fields that differ from the base, with the base's version, so a save
 * never writes back a field the person did not touch.
 */
import type { CardChange, CardDetail } from "./board-client";

export type CardDraft = { title: string; description: string; assignee: string; columnId: string };

export function draftOf(card: CardDetail): CardDraft {
  return {
    title: card.title,
    description: card.description,
    assignee: card.assignee?.userId ?? "",
    columnId: card.columnId,
  };
}

/** The fields the person changed against `base`, or null when there is nothing to send. */
export function changeOf(base: CardDetail, draft: CardDraft): CardChange | null {
  const title = draft.title.trim();
  const change: CardChange = {
    version: base.version,
    ...(title !== base.title ? { title } : {}),
    ...(draft.description !== base.description ? { description: draft.description } : {}),
    ...(draft.assignee !== (base.assignee?.userId ?? "")
      ? { assignee: draft.assignee ? { kind: "person" as const, userId: draft.assignee } : null }
      : {}),
    ...(draft.columnId !== base.columnId ? { columnId: draft.columnId, beforeId: null } : {}),
  };
  return Object.keys(change).length > 1 ? change : null;
}

/**
 * A newer card arrived (someone else's save, or a 409). Every box the person left alone takes the new
 * value; every box they edited keeps their text. Without this, saving after someone else's change
 * would quietly put back the old value of a field the person never touched.
 */
export function rebaseDraft(draft: CardDraft, oldBase: CardDetail, newBase: CardDetail): CardDraft {
  const before = draftOf(oldBase);
  const after = draftOf(newBase);
  return {
    title: draft.title === before.title ? after.title : draft.title,
    description: draft.description === before.description ? after.description : draft.description,
    assignee: draft.assignee === before.assignee ? after.assignee : draft.assignee,
    columnId: draft.columnId === before.columnId ? after.columnId : draft.columnId,
  };
}

/** True when the person has edits that a newer card would sit beside. */
export function isDirty(base: CardDetail, draft: CardDraft): boolean {
  return changeOf(base, draft) !== null;
}
