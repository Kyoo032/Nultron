import { describe, expect, it } from "vitest";
import type { ProposalSummary } from "./folder-api";
import {
  folderReducer,
  hasProposalRows,
  INITIAL_FOLDER_STATE,
  pendingCount,
  type FolderAction,
  type FolderState,
} from "./folder-state";

const A: ProposalSummary = { id: "a", path: "a.md", kind: "write", status: "pending" };
const B: ProposalSummary = { id: "b", path: "b.md", kind: "delete", status: "pending" };

/** Freezes the whole tree, so a reducer that mutates anything throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function run(actions: FolderAction[], from: FolderState = INITIAL_FOLDER_STATE): FolderState {
  return actions.reduce((state, action) => folderReducer(deepFreeze(state), action), from);
}

describe("folderReducer", () => {
  it("never changes the state it was given", () => {
    const before = deepFreeze(run([{ type: "pending", items: [A, B] }]));
    expect(() =>
      run(
        [
          { type: "toggled", id: "a" },
          { type: "diff", id: "a", entry: { phase: "loading" } },
          { type: "busy", id: "a", decision: "approve" },
          { type: "decided", row: A, outcome: { tag: "applied" } },
          { type: "dismissed", id: "a" },
          { type: "closed" },
        ],
        before,
      ),
    ).not.toThrow();
    expect(before.pending).toEqual([A, B]);
  });

  it("opens and closes a row's changes", () => {
    const opened = run([{ type: "toggled", id: "a" }]);
    expect(opened.expanded).toEqual(["a"]);
    expect(run([{ type: "toggled", id: "a" }], opened).expanded).toEqual([]);
  });

  it("moves a decided proposal out of pending and puts its outcome first", () => {
    const state = run([
      { type: "pending", items: [A, B] },
      { type: "decided", row: A, outcome: { tag: "applied" } },
      { type: "decided", row: B, outcome: { tag: "rejected" } },
    ]);
    expect(state.pending).toEqual([]);
    expect(state.decided.map((row) => [row.id, row.outcome.tag])).toEqual([
      ["b", "rejected"],
      ["a", "applied"],
    ]);
  });

  it("does not list a decided proposal as pending again when a late read still has it", () => {
    const state = run([
      { type: "decided", row: A, outcome: { tag: "applied" } },
      { type: "pending", items: [A, B] },
    ]);
    expect(state.pending).toEqual([B]);
  });

  it("forgets what was open for a proposal the host no longer lists, but keeps a decided row's", () => {
    const state = run([
      { type: "pending", items: [A, B] },
      { type: "toggled", id: "a" },
      { type: "toggled", id: "b" },
      { type: "diff", id: "a", entry: { phase: "loading" } },
      { type: "diff", id: "b", entry: { phase: "loading" } },
      { type: "decided", row: A, outcome: { tag: "stale" } },
      { type: "pending", items: [] },
    ]);
    expect(state.expanded).toEqual(["a"]);
    expect(Object.keys(state.diffs)).toEqual(["a"]);
  });

  it("clears a row's error when it is tried again", () => {
    const state = run([
      { type: "pending", items: [A] },
      { type: "rowError", id: "a", code: "network" },
    ]);
    expect(state.rowErrors).toEqual({ a: "network" });
    expect(run([{ type: "busy", id: "a", decision: "approve" }], state).rowErrors).toEqual({});
  });

  it("closing returns to a blank desk but remembers that a folder is possible", () => {
    const state = run([
      { type: "status", status: { available: true, mounted: true, name: "notes" } },
      { type: "pending", items: [A] },
      { type: "decided", row: A, outcome: { tag: "applied" } },
      { type: "closed" },
    ]);
    expect(state).toEqual({
      ...INITIAL_FOLDER_STATE,
      status: { available: true, mounted: false, name: null },
    });
  });

  it("counts what is waiting, and says when there is anything to show", () => {
    expect(pendingCount(run([{ type: "pending", items: [A, B] }]))).toBe(2);
    expect(hasProposalRows(INITIAL_FOLDER_STATE)).toBe(false);
    expect(hasProposalRows(run([{ type: "decided", row: A, outcome: { tag: "gone" } }]))).toBe(true);
  });
});
