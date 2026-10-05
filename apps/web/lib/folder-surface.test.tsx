/**
 * The folder control and the "changes to approve" panel, rendered.
 *
 * `renderToStaticMarkup` against the real `t()` and the real catalogs (apps/web runs vitest without
 * a DOM): that the surface is genuinely absent where there is no folder, that the chip names the
 * folder and never prints a path, that each way a decision can end is on the page in words, and
 * that the diff draws what the host sent. The flow that produces those states is
 * `folder-actions.test.ts`; the pressing, the widths and the themes are driven live
 * (`.cursor/skills/verify-agentforge/features/chat.md`).
 */
import { hostCapabilities } from "@agentforge/core/capabilities";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let electron = true;

vi.mock("@/lib/api-client", () => ({
  isElectron: () => electron,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

import { FolderSurfaceView } from "@/components/folder/folder-surface";
import type { FolderController } from "./folder-actions";
import type { ProposalSummary } from "./folder-api";
import { folderReducer, INITIAL_FOLDER_STATE, type FolderAction, type FolderState } from "./folder-state";
import { applyLocale, resetLocaleForTests } from "./i18n";

const DESKTOP = hostCapabilities({});
const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

const CONTROLLER: FolderController = {
  refresh: async () => undefined,
  open: async () => undefined,
  close: async () => undefined,
  toggleDiff: async () => undefined,
  decide: async () => undefined,
  dismiss: () => undefined,
  clearError: () => undefined,
};

function stateFrom(actions: FolderAction[]): FolderState {
  return actions.reduce(folderReducer, INITIAL_FOLDER_STATE);
}

const OPEN_NOTES: FolderAction = { type: "status", status: { available: true, mounted: true, name: "notes" } };

function render(state: FolderState, capabilities = DESKTOP): string {
  return renderToStaticMarkup(<FolderSurfaceView state={state} capabilities={capabilities} controller={CONTROLLER} />);
}

function tag(markup: string, testId: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) {
    throw new Error(`${testId} is not in the markup`);
  }
  return match[0];
}

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

beforeEach(() => {
  electron = true;
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("where the surface is absent", () => {
  it("renders nothing before the host has answered", () => {
    expect(render(INITIAL_FOLDER_STATE)).toBe("");
  });

  it("renders nothing when the host says a folder is not possible here (hosted, or webdev without the routes)", () => {
    const state = stateFrom([{ type: "status", status: { available: false, mounted: false, name: null } }]);
    expect(render(state, HOSTED)).toBe("");
    expect(render(state, DESKTOP)).toBe("");
  });

  it("renders nothing on webdev: the host allows a folder but there is no shell to pick one", () => {
    electron = false;
    const state = stateFrom([{ type: "status", status: { available: true, mounted: false, name: null } }]);
    expect(render(state)).toBe("");
  });

  it("renders nothing for a packaged shell pointed at a host that does not allow folders", () => {
    const state = stateFrom([{ type: "status", status: { available: true, mounted: false, name: null } }]);
    expect(render(state, HOSTED)).toBe("");
  });
});

describe("the control", () => {
  it("offers Open folder before a folder is open", () => {
    const markup = render(stateFrom([{ type: "status", status: { available: true, mounted: false, name: null } }]));
    expect(count(markup, "folder-control")).toBe(1);
    expect(count(markup, "folder-open")).toBe(1);
    expect(count(markup, "folder-chip")).toBe(0);
    expect(markup).toContain("Open folder");
  });

  it("disables Open folder while the dialog or the host is busy", () => {
    const markup = render(
      stateFrom([
        { type: "status", status: { available: true, mounted: false, name: null } },
        { type: "mounting", on: true },
      ]),
    );
    expect(tag(markup, "folder-open")).toMatch(/ disabled=""/);
    expect(markup).toContain("Opening…");
  });

  it("shows the folder's name in a chip with a close action, and no Open folder button", () => {
    const markup = render(stateFrom([OPEN_NOTES]));
    expect(count(markup, "folder-chip")).toBe(1);
    expect(count(markup, "folder-close")).toBe(1);
    expect(count(markup, "folder-open")).toBe(0);
    expect(markup).toContain(">notes<");
    expect(tag(markup, "folder-close")).toContain('aria-label="Close folder notes"');
  });

  it("prints the name only: nothing in the markup looks like a path", () => {
    const markup = render(stateFrom([OPEN_NOTES]));
    expect(markup).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it("says in the close tooltip that waiting changes will be dropped", () => {
    const state = stateFrom([
      OPEN_NOTES,
      { type: "pending", items: [{ id: "a", path: "a.md", kind: "write", status: "pending" }] },
    ]);
    expect(tag(render(state), "folder-close")).toContain("Changes waiting for your approval will be dropped");
  });

  it("shows a refusal in words, not as a code", () => {
    const markup = render(
      stateFrom([
        { type: "status", status: { available: true, mounted: false, name: null } },
        { type: "error", code: "folder_mount_refused" },
      ]),
    );
    expect(markup).toContain('data-testid="folder-error"');
    expect(markup).toContain("That folder cannot be opened.");
    expect(markup).not.toContain("folder_mount_refused");
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const markup = render(stateFrom([{ type: "status", status: { available: true, mounted: false, name: null } }]));
    expect(markup).toContain("Buka folder");
    expect(markup).not.toContain("Open folder");
  });
});

const WRITE = { id: "p1", path: "notes/plan.md", kind: "write", status: "pending" } as const;
const DELETE = { id: "p2", path: "old.txt", kind: "delete", status: "pending" } as const;

describe("the proposals panel", () => {
  it("is absent with nothing waiting", () => {
    expect(count(render(stateFrom([OPEN_NOTES])), "folder-proposals")).toBe(0);
  });

  it("is absent when no folder is open, even with a decided row left over", () => {
    const state = stateFrom([
      { type: "status", status: { available: true, mounted: false, name: null } },
      { type: "decided", row: WRITE, outcome: { tag: "applied" } },
    ]);
    expect(count(render(state), "folder-proposals")).toBe(0);
  });

  it("lists each proposal with its path, its kind and the two buttons that decide it", () => {
    const markup = render(stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE, DELETE] }]));
    expect(count(markup, "folder-proposals")).toBe(1);
    expect(count(markup, "folder-proposal")).toBe(2);
    expect(count(markup, "folder-proposal-approve")).toBe(2);
    expect(count(markup, "folder-proposal-reject")).toBe(2);
    expect(markup).toContain("notes/plan.md");
    expect(markup).toContain("old.txt");
    expect(markup).toContain(">Change<");
    expect(markup).toContain(">Delete<");
    expect(markup).toContain('data-testid="folder-proposals-count">2<');
    expect(count(markup, "folder-proposal-diff")).toBe(0);
    expect(count(markup, "folder-proposal-outcome")).toBe(0);
  });

  it("names the file in each button, so a screen reader can tell the rows apart", () => {
    const markup = render(stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE] }]));
    expect(markup).toContain('aria-label="Approve the change to notes/plan.md"');
    expect(markup).toContain('aria-label="Reject the change to notes/plan.md"');
  });

  it("disables both buttons and says what is happening while a decision is on its way", () => {
    const markup = render(
      stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE] }, { type: "busy", id: "p1", decision: "approve" }]),
    );
    expect(tag(markup, "folder-proposal-approve")).toMatch(/ disabled=""/);
    expect(tag(markup, "folder-proposal-reject")).toMatch(/ disabled=""/);
    expect(markup).toContain("Applying…");
  });

  it("shows a decision that did not go through on its row, and leaves the buttons live", () => {
    const markup = render(
      stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE] }, { type: "rowError", id: "p1", code: "network" }]),
    );
    expect(markup).toContain('data-testid="folder-proposal-error"');
    expect(markup).toContain("Could not reach the app. Try again.");
    expect(tag(markup, "folder-proposal-approve")).not.toMatch(/ disabled=""/);
  });
});

describe("the outcome of a decision", () => {
  function outcomeMarkup(outcome: Extract<FolderAction, { type: "decided" }>, kindRow: ProposalSummary = WRITE) {
    const state = stateFrom([OPEN_NOTES, { type: "pending", items: [kindRow] }, outcome]);
    return render(state);
  }

  it("says applied, and takes the buttons away", () => {
    const markup = outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "applied" } });
    expect(tag(markup, "folder-proposal-outcome")).toContain('data-outcome="applied"');
    expect(markup).toContain("Applied. Your folder now has this change.");
    expect(count(markup, "folder-proposal-approve")).toBe(0);
    expect(count(markup, "folder-proposal-reject")).toBe(0);
    expect(count(markup, "folder-proposal-dismiss")).toBe(1);
  });

  it("says a delete was applied in its own words", () => {
    const markup = outcomeMarkup({ type: "decided", row: DELETE, outcome: { tag: "applied" } }, DELETE);
    expect(markup).toContain("Applied. The file was deleted.");
  });

  it("explains a stale approval: nothing was written, and what to do", () => {
    const markup = outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "stale" } });
    expect(tag(markup, "folder-proposal-outcome")).toContain('data-outcome="stale"');
    expect(markup).toContain("Not applied. The file changed after this was proposed, so nothing was written.");
    expect(markup).toContain("Ask Chat for a fresh change.");
  });

  it("explains a failed write by its reason", () => {
    const denied = outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "failed", reason: "denied" } });
    expect(denied).toContain("protected or outside the folder you opened");
    const io = outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "failed", reason: "io_error" } });
    expect(io).toContain("could not be written");
  });

  it("says rejected, and says someone got there first", () => {
    expect(outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "rejected" } })).toContain(
      "Rejected. Nothing was changed.",
    );
    expect(outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "gone" } })).toContain(
      "This change was already decided.",
    );
  });

  it("says it in Indonesian too", () => {
    applyLocale("id");
    const markup = outcomeMarkup({ type: "decided", row: WRITE, outcome: { tag: "applied" } });
    expect(markup).toContain("Diterapkan. Folder Anda sekarang memuat perubahan ini.");
  });
});

describe("the diff", () => {
  const diffState = (before: string, after: string, stale = false, extra: FolderAction[] = []) =>
    stateFrom([
      OPEN_NOTES,
      { type: "pending", items: [WRITE] },
      { type: "toggled", id: "p1" },
      {
        type: "diff",
        id: "p1",
        entry: { phase: "ready", diff: { ...WRITE, before, after, stale } },
      },
      ...extra,
    ]);

  it("is absent until the row is opened, and says it is loading while it loads", () => {
    const closed = render(stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE] }]));
    expect(count(closed, "folder-proposal-diff")).toBe(0);
    const loading = render(stateFrom([OPEN_NOTES, { type: "pending", items: [WRITE] }, { type: "toggled", id: "p1" }]));
    expect(count(loading, "folder-proposal-diff")).toBe(1);
    expect(loading).toContain("Loading the changes…");
  });

  it("marks the toggle expanded and points it at the diff", () => {
    const markup = render(diffState("a\n", "b\n"));
    const toggle = tag(markup, "folder-proposal-toggle");
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('aria-controls="folder-diff-p1"');
    expect(markup).toContain('id="folder-diff-p1"');
    expect(markup).toContain("Hide changes");
  });

  it("draws removed and added lines with a marker and a word for a screen reader", () => {
    const markup = render(diffState("one\ntwo\nthree\n", "one\n2\nthree\n"));
    expect(markup).toMatch(/data-kind="remove"[^>]*>.*?Removed: <\/span><span[^>]*>two</);
    expect(markup).toMatch(/data-kind="add"[^>]*>.*?Added: <\/span><span[^>]*>2</);
    expect(count(markup, "folder-proposal-lines")).toBe(1);
    expect(tag(markup, "folder-proposal-lines")).toContain('aria-label="notes/plan.md"');
    expect(tag(markup, "folder-proposal-lines")).toContain('tabindex="0"');
  });

  it("warns that a pending change is stale because the file moved on", () => {
    const markup = render(diffState("a\n", "b\n", true));
    expect(count(markup, "folder-proposal-stale")).toBe(1);
    expect(markup).toContain("This file has changed since the change was proposed.");
    expect(count(render(diffState("a\n", "b\n", false)), "folder-proposal-stale")).toBe(0);
  });

  it("does not warn about stale on a row that is already decided", () => {
    const markup = render(
      diffState("a\n", "b\n", true, [{ type: "decided", row: WRITE, outcome: { tag: "applied" } }]),
    );
    expect(count(markup, "folder-proposal-stale")).toBe(0);
    expect(count(markup, "folder-proposal-outcome")).toBe(1);
  });

  it("says when each side was cut to the line limit", () => {
    const long = Array.from({ length: 2100 }, (_, index) => `line ${index}`).join("\n");
    const markup = render(diffState(long, `${long}\nmore`));
    expect(count(markup, "folder-proposal-truncated")).toBe(1);
    expect(markup).toContain("Showing the first 2000 lines of each side.");
  });

  it("folds a long unchanged run into one line instead of drawing it", () => {
    const body = Array.from({ length: 40 }, (_, index) => `row ${index}`);
    const markup = render(
      diffState(body.join("\n"), body.map((line, index) => (index === 20 ? "changed" : line)).join("\n")),
    );
    expect(markup).toContain('data-kind="gap"');
    expect(markup).toContain("unchanged lines");
    expect(markup).not.toContain(">row 5<");
  });

  it("says when only the line endings differ instead of drawing an empty box", () => {
    const markup = render(diffState("a\nb\n", "a\r\nb\r\n"));
    expect(markup).toContain("Only the line endings or the end of the file differ.");
    expect(count(markup, "folder-proposal-lines")).toBe(0);
  });

  it("draws a new file as all additions and a delete as all removals", () => {
    const created = render(diffState("", "hello\nworld\n"));
    expect(created).not.toContain('data-kind="remove"');
    expect(created.split('data-kind="add"').length - 1).toBe(2);
    const deleted = render(diffState("hello\nworld\n", ""));
    expect(deleted).not.toContain('data-kind="add"');
    expect(deleted.split('data-kind="remove"').length - 1).toBe(2);
  });

  it("shows a diff that failed to load as a sentence", () => {
    const markup = render(
      stateFrom([
        OPEN_NOTES,
        { type: "pending", items: [WRITE] },
        { type: "toggled", id: "p1" },
        { type: "diff", id: "p1", entry: { phase: "failed", code: "network" } },
      ]),
    );
    expect(markup).toContain("Could not reach the app. Try again.");
  });

  it("escapes what the file holds: a line that looks like markup is text", () => {
    const markup = render(diffState("", '<img src=x onerror="alert(1)">\n'));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=");
  });
});
