import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PeoplePickerView } from "@/components/projects-people-picker";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import type { InvitablePerson } from "@/lib/projects-client";
import { INITIAL_PICKER, keyIntent, matchPeople, pickerStep, type PickerState } from "@/lib/projects-picker";

afterEach(() => {
  resetLocaleForTests();
});

const PEOPLE: InvitablePerson[] = [
  { userId: "u-ana", name: "Ana Putri" },
  { userId: "u-budi", name: "Budi Santoso" },
  { userId: "u-citra", name: "Citra" },
  { userId: "u-dewi", name: "dewi.k" },
];

function render(state: PickerState, people: InvitablePerson[] | null = PEOPLE, busy = false): string {
  return renderToStaticMarkup(
    <PeoplePickerView
      baseId="pk"
      people={people}
      loadFailed={false}
      busy={busy}
      state={state}
      onEvent={() => {}}
      onSubmit={() => {}}
    />,
  );
}

describe("matching colleagues", () => {
  it("matches the name or the id, ignoring case and outer spaces", () => {
    expect(matchPeople(PEOPLE, "  SAN ").map((person) => person.userId)).toEqual(["u-budi"]);
    expect(matchPeople(PEOPLE, "u-cit").map((person) => person.userId)).toEqual(["u-citra"]);
    expect(matchPeople(PEOPLE, "a").map((person) => person.userId)).toEqual(["u-ana", "u-budi", "u-citra"]);
    expect(matchPeople(PEOPLE, "zzz")).toEqual([]);
  });

  it("offers everyone for an empty query, up to the limit", () => {
    expect(matchPeople(PEOPLE, "")).toHaveLength(4);
    expect(matchPeople(PEOPLE, "", 2).map((person) => person.userId)).toEqual(["u-ana", "u-budi"]);
  });
});

describe("the picker's keyboard", () => {
  it("ArrowDown opens on the first option and wraps; ArrowUp from closed lands on the last", () => {
    let state = pickerStep(INITIAL_PICKER, { type: "move", by: 1 }, 3);
    expect(state).toMatchObject({ open: true, active: 0 });
    state = pickerStep(state, { type: "move", by: 1 }, 3);
    state = pickerStep(state, { type: "move", by: 1 }, 3);
    state = pickerStep(state, { type: "move", by: 1 }, 3);
    expect(state.active).toBe(0);
    expect(pickerStep(INITIAL_PICKER, { type: "move", by: -1 }, 3)).toMatchObject({ open: true, active: 2 });
    expect(pickerStep(INITIAL_PICKER, { type: "move", by: 1 }, 0)).toMatchObject({ open: true, active: -1 });
  });

  it("Enter picks the active option, Escape closes, and typing forgets the pick", () => {
    const active: PickerState = { query: "bu", chosen: null, active: 0, open: true };
    expect(keyIntent("Enter", active)).toEqual({ kind: "pick", index: 0 });
    expect(keyIntent("Enter", { ...active, active: -1 })).toBeNull();
    expect(keyIntent("Escape", active)).toEqual({ kind: "event", event: { type: "close" } });
    expect(keyIntent("Escape", INITIAL_PICKER)).toBeNull();
    expect(keyIntent("Tab", active)).toBeNull();

    const chosen = pickerStep(active, { type: "choose", person: PEOPLE[1] }, 1);
    expect(chosen).toEqual({ query: "Budi Santoso", chosen: "u-budi", active: -1, open: false });
    expect(pickerStep(chosen, { type: "type", query: "Budi S" }, 1)).toEqual({
      query: "Budi S",
      chosen: null,
      active: -1,
      open: true,
    });
    expect(pickerStep(active, { type: "close" }, 1)).toMatchObject({ open: false, active: -1 });
  });
});

describe("the picker as drawn", () => {
  it("lists the matches as options, marks the active one and points the combobox at it", () => {
    const html = render({ query: "a", chosen: null, active: 1, open: true });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="pk-list"');
    expect(html).toContain('aria-activedescendant="pk-option-1"');
    expect([...html.matchAll(/data-user="([^"]+)"/g)].map((match) => match[1])).toEqual(["u-ana", "u-budi", "u-citra"]);
    expect(html).toContain('id="pk-option-1" role="option" aria-selected="true"');
    expect(html).toContain('id="pk-option-0" role="option" aria-selected="false"');
  });

  it("enables Invite once someone is chosen, and not while busy", () => {
    const chosen: PickerState = { query: "Citra", chosen: "u-citra", active: -1, open: false };
    expect(render(chosen)).toMatch(/<button type="submit" class="btn btn-secondary" data-testid="projects-invite">/);
    expect(render(chosen, PEOPLE, true)).toContain('disabled="" data-testid="projects-invite"');
    expect(render(chosen)).not.toContain('role="listbox"');
  });

  it("says nobody matches, in Indonesian too", () => {
    const state: PickerState = { query: " zzz ", chosen: null, active: -1, open: true };
    expect(render(state)).toContain("Nobody in your company matches &quot;zzz&quot;.");
    applyLocale("id");
    const html = render(state);
    expect(html).toContain("Tidak ada orang di perusahaan Anda yang cocok dengan &quot;zzz&quot;.");
    expect(html).toContain(">Cari rekan berdasarkan nama</label>");
  });
});
