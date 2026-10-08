/**
 * The owner's inline edit of one decision or action item, as the host takes it.
 *
 * The page sends only what changed: the host refuses an edit that sets nothing, and the item keeps every
 * field the owner left alone. A required field the owner emptied is not sent either, because the host
 * requires it (the form disables Save for that, so this is the second line). The quote and the evidence are
 * not editable and never travel: the quote stays the transcript's own words.
 */
import type { MeetingActionItem, MeetingDecision, MinutesItemEdit } from "@agentforge/core/meeting";

export type DecisionDraft = { statement: string; context: string; provisional: boolean };
export type ActionDraft = { task: string; owner: string; due: string; firstStep: string };

export function decisionDraftOf(decision: MeetingDecision): DecisionDraft {
  return { statement: decision.statement, context: decision.context, provisional: decision.provisional };
}

export function actionDraftOf(item: MeetingActionItem): ActionDraft {
  return { task: item.task, owner: item.owner, due: item.due, firstStep: item.firstStep };
}

/** Whether a draft can be saved: every required field has words in it. */
export function decisionDraftValid(draft: DecisionDraft): boolean {
  return draft.statement.trim() !== "";
}

export function actionDraftValid(draft: ActionDraft): boolean {
  return draft.task.trim() !== "" && draft.owner.trim() !== "";
}

type Fields = Record<string, string | boolean>;

/** The fields of `next` that differ from `current` (compared trimmed); a required field emptied is left out. */
function changed(current: Fields, next: Fields, required: readonly string[]): Fields {
  const set: Fields = {};
  for (const [key, value] of Object.entries(next)) {
    const was = current[key];
    if (typeof value === "string") {
      const words = value.trim();
      if (words !== String(was ?? "").trim() && !(required.includes(key) && words === "")) {
        set[key] = words;
      }
    } else if (value !== was) {
      set[key] = value;
    }
  }
  return set;
}

export function decisionEdit(index: number, current: MeetingDecision, draft: DecisionDraft): MinutesItemEdit | null {
  const set = changed(decisionDraftOf(current), draft, ["statement"]);
  return Object.keys(set).length === 0 ? null : ({ kind: "decision", index, set } as MinutesItemEdit);
}

export function actionEdit(index: number, current: MeetingActionItem, draft: ActionDraft): MinutesItemEdit | null {
  const set = changed(actionDraftOf(current), draft, ["task", "owner"]);
  return Object.keys(set).length === 0 ? null : ({ kind: "action", index, set } as MinutesItemEdit);
}

export type EditSaveResult = { readonly done: true } | { readonly done: false; readonly message: string };

/**
 * Save an edit through `save`, which answers the host's refusal sentence or null when it took it. Nothing
 * changed is a close without a request: the owner pressed Save on words they did not touch.
 */
export async function submitEdit(
  edit: MinutesItemEdit | null,
  save: (edit: MinutesItemEdit) => Promise<string | null>,
): Promise<EditSaveResult> {
  if (edit === null) {
    return { done: true };
  }
  const message = await save(edit);
  return message === null ? { done: true } : { done: false, message };
}
