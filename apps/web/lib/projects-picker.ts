import type { InvitablePerson } from "./projects-client";

export type PickerState = {
  readonly query: string;
  readonly chosen: string | null;
  readonly active: number;
  readonly open: boolean;
};

export type PickerEvent =
  | { readonly type: "type"; readonly query: string }
  | { readonly type: "move"; readonly by: 1 | -1 }
  | { readonly type: "choose"; readonly person: InvitablePerson }
  | { readonly type: "open" }
  | { readonly type: "close" };

export type KeyIntent =
  | { readonly kind: "event"; readonly event: PickerEvent }
  | { readonly kind: "pick"; readonly index: number };

export const PICKER_LIMIT = 8;

export const INITIAL_PICKER: PickerState = { query: "", chosen: null, active: -1, open: false };

export function matchPeople(
  people: readonly InvitablePerson[],
  query: string,
  limit: number = PICKER_LIMIT,
): InvitablePerson[] {
  const needle = query.trim().toLocaleLowerCase();
  const found = needle
    ? people.filter(
        (person) =>
          person.name.toLocaleLowerCase().includes(needle) || person.userId.toLocaleLowerCase().includes(needle),
      )
    : people;
  return found.slice(0, limit);
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

export function pickerStep(state: PickerState, event: PickerEvent, count: number): PickerState {
  switch (event.type) {
    case "type":
      return { query: event.query, chosen: null, active: -1, open: true };
    case "move":
      if (count === 0) {
        return { ...state, open: true, active: -1 };
      }
      if (state.open && state.active >= 0) {
        return { ...state, active: wrap(state.active + event.by, count) };
      }
      return { ...state, open: true, active: event.by === 1 ? 0 : count - 1 };
    case "choose":
      return { query: event.person.name, chosen: event.person.userId, active: -1, open: false };
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false, active: -1 };
  }
}

export function keyIntent(key: string, state: PickerState): KeyIntent | null {
  switch (key) {
    case "ArrowDown":
      return { kind: "event", event: { type: "move", by: 1 } };
    case "ArrowUp":
      return { kind: "event", event: { type: "move", by: -1 } };
    case "Escape":
      return state.open ? { kind: "event", event: { type: "close" } } : null;
    case "Enter":
      return state.open && state.active >= 0 ? { kind: "pick", index: state.active } : null;
    default:
      return null;
  }
}
