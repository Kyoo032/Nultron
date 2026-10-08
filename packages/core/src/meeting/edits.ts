/**
 * Meeting mode: the owner's own changes to a decision or an action item.
 *
 * An edit changes the words the owner is allowed to change (a decision's statement, context and provisional
 * mark; an action item's task, owner, due date and first step) and marks the item `edited`. It never touches
 * the item's `quote`, which stays the transcript's own words, or its `evidence`, which stays the code's
 * verdict on that quote. A regenerate keeps edited items (`keepEditedItems`): the owner's work is not
 * overwritten by the next model run.
 *
 * Pure: no model call, no clock, no file access.
 */
import { z } from "zod";
import { QUOTE_MIN_CHARS, normaliseForMatch } from "../harness/judges";
import type { MeetingMinutes } from "./minutes";

/** The longest any one edited field can be. */
export const MINUTES_EDIT_TEXT_MAX_CHARS = 2000;

export class MinutesEditError extends Error {
  readonly code = "item_not_found" as const;

  constructor() {
    super("item_not_found");
    this.name = "MinutesEditError";
  }
}

const required = z.string().trim().min(1).max(MINUTES_EDIT_TEXT_MAX_CHARS);
const optional = z.string().trim().max(MINUTES_EDIT_TEXT_MAX_CHARS);

const decisionFields = z
  .object({ statement: required.optional(), context: optional.optional(), provisional: z.boolean().optional() })
  .strict();
const actionFields = z
  .object({
    task: required.optional(),
    owner: required.optional(),
    due: optional.optional(),
    firstStep: optional.optional(),
  })
  .strict();

const hasAField = (fields: Record<string, unknown>) => Object.values(fields).some((value) => value !== undefined);
const index = z.number().int().min(0);

/** One edit: which item (the n-th decision or action item, from 0) and the fields to change. */
export const minutesItemEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    index,
    set: decisionFields.refine(hasAField, { message: "set at least one field" }),
  }),
  z.object({
    kind: z.literal("action"),
    index,
    set: actionFields.refine(hasAField, { message: "set at least one field" }),
  }),
]);

export type MinutesItemEdit = z.infer<typeof minutesItemEditSchema>;

/** The fields an edit sets, without the ones left undefined, so a spread never blanks a field. */
function given<T extends object>(set: T): Partial<T> {
  return Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function replaceAt<T>(list: readonly T[], at: number, next: T): T[] {
  return list.map((item, position) => (position === at ? next : item));
}

/** The same minutes with one item changed and marked edited. Throws {@link MinutesEditError} when there is no such item. */
export function applyMinutesItemEdit(minutes: MeetingMinutes, edit: MinutesItemEdit): MeetingMinutes {
  if (edit.kind === "decision") {
    const current = minutes.decisions[edit.index];
    if (!current) {
      throw new MinutesEditError();
    }
    return {
      ...minutes,
      decisions: replaceAt(minutes.decisions, edit.index, { ...current, ...given(edit.set), edited: true }),
    };
  }
  const current = minutes.actionItems[edit.index];
  if (!current) {
    throw new MinutesEditError();
  }
  return {
    ...minutes,
    actionItems: replaceAt(minutes.actionItems, edit.index, { ...current, ...given(edit.set), edited: true }),
  };
}

function comparable(quote: string): string {
  return normaliseForMatch(quote, { foldCase: true }).value;
}

/** The same words, up to case and spacing, or one is a cut of the other (a regenerate may quote a little more or less). */
function sameQuote(left: string, right: string): boolean {
  const a = comparable(left);
  const b = comparable(right);
  if (a === "" || b === "") {
    return false;
  }
  if (a === b) {
    return true;
  }
  return a.length >= QUOTE_MIN_CHARS && b.length >= QUOTE_MIN_CHARS && (a.includes(b) || b.includes(a));
}

type Item = { readonly quote: string; readonly edited?: boolean | undefined };

function keepEdited<T extends Item>(previous: readonly T[], next: readonly T[]): T[] {
  const result = [...next];
  const taken = new Set<number>();
  for (const item of previous.filter((candidate) => candidate.edited === true)) {
    const at = result.findIndex(
      (candidate, position) =>
        !taken.has(position) && candidate.edited !== true && sameQuote(candidate.quote, item.quote),
    );
    if (at === -1) {
      result.push(item);
      taken.add(result.length - 1);
    } else {
      result[at] = item;
      taken.add(at);
    }
  }
  return result;
}

/**
 * `next` (a regenerate) with the owner's edited items from `previous` put back: over the new item that quotes
 * the same words, or at the end of the list when the regenerate no longer has one. Everything else is the
 * regenerate's. Items without a quote cannot be matched, so an edited one is appended.
 */
export function keepEditedItems(previous: MeetingMinutes | null, next: MeetingMinutes): MeetingMinutes {
  if (!previous) {
    return next;
  }
  return {
    ...next,
    decisions: keepEdited(previous.decisions, next.decisions),
    actionItems: keepEdited(previous.actionItems, next.actionItems),
  };
}

/**
 * The words of every edited item, one per line. They are the owner's, not the transcript's, so a guard that
 * checks names, dates and figures against the transcript is also given these: the owner may name a person
 * the meeting did not.
 */
export function userEditedText(minutes: MeetingMinutes): string {
  const decisions = minutes.decisions
    .filter((decision) => decision.edited === true)
    .map((decision) => [decision.statement, decision.context]);
  const actions = minutes.actionItems
    .filter((item) => item.edited === true)
    .map((item) => [item.task, item.owner, item.due, item.firstStep]);
  return [...decisions, ...actions]
    .map((fields) => fields.filter((field) => field.trim() !== "").join(" "))
    .filter((line) => line !== "")
    .join("\n");
}
