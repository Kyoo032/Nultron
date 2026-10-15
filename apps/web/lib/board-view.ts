/**
 * Pure helpers for the board page: names, order and copy. Kept apart from the page so they can be
 * tested without a browser.
 */
import type { BoardColumn, BoardPerson, CardSummary } from "./board-client";
import { BoardError } from "./board-client";
import { t } from "./i18n";
import { personName } from "./people-names";

/** A built-in column nobody renamed carries no name; the page shows the desk's word for its kind. */
export function columnLabel(column: BoardColumn): string {
  if (column.name) {
    return column.name;
  }
  return column.kind === "custom" ? "" : t(`board.columns.${column.kind}`);
}

export function personLabel(people: readonly BoardPerson[], userId: string, me: string): string {
  const person = people.find((entry) => entry.userId === userId);
  if (!person) {
    return t("board.unknownPerson");
  }
  const label = personName(person);
  return userId === me ? t("board.you", { name: label }) : label;
}

/**
 * Cards grouped by column, each list in position order. Position keys are base-62 strings whose
 * alphabet is in code-point order, so a plain `<` compare is the board's order; `localeCompare` is not.
 */
export function cardsByColumn(
  columns: readonly BoardColumn[],
  cards: readonly CardSummary[],
): ReadonlyMap<string, readonly CardSummary[]> {
  const grouped = new Map<string, CardSummary[]>(columns.map((column) => [column.id, []]));
  for (const card of cards) {
    grouped.get(card.columnId)?.push(card);
  }
  return new Map(
    [...grouped].map(([id, list]) => [
      id,
      [...list].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)),
    ]),
  );
}

const KNOWN_ERRORS = new Set([
  "card_conflict",
  "card_not_found",
  "column_not_found",
  "admin_only",
  "builtin_column",
  "column_not_empty",
  "invalid_card",
  "invalid_comment",
  "invalid_column",
  "not_allowed",
  "card_limit",
  "comment_limit",
  "column_limit",
  "position_exhausted",
]);

/**
 * Whether the Archive button is offered: the card's creator, its assignee, or an owner or admin. The host
 * makes the same decision (`mayArchive` in the host's board service) and refuses anyone else; this only
 * keeps the button away from people it would refuse.
 */
export function mayArchive(
  card: Pick<CardSummary, "createdBy" | "assignee">,
  me: string,
  canAdminister: boolean,
): boolean {
  return canAdminister || card.createdBy === me || card.assignee?.userId === me;
}

/** The desk's own sentence for a refusal. The host's text is English, so it is never shown as is. */
export function boardErrorMessage(error: unknown, context?: "move"): string {
  // A drag has no boxes holding the person's edits, so its conflict gets its own sentence.
  if (context === "move" && error instanceof BoardError && error.code === "card_conflict") {
    return t("board.errors.moveConflict");
  }
  if (error instanceof BoardError && KNOWN_ERRORS.has(error.code)) {
    return t(`board.errors.${error.code}`);
  }
  return t("board.errors.generic");
}

/**
 * Where a dragged card lands when dropped on `targetId` in a column: directly above the target. Dropped
 * on the column itself (no target), it goes to the end. Dropping a card on itself changes nothing.
 */
export function dropPlacement(
  draggedId: string,
  columnId: string,
  targetId: string | null,
): { columnId: string; beforeId: string | null } | null {
  if (targetId === draggedId) {
    return null;
  }
  return { columnId, beforeId: targetId };
}
