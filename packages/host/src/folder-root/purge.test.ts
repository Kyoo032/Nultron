import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeFolderProposals } from "./index";
import { DESK_A, DESK_B, openProposalsFixture, type ProposalsFixture } from "./test-support";

/**
 * Deleting a desk takes its folder proposals with it. Each row holds a sealed copy of text the agent
 * wanted to write, and nothing in the app can reach a deleted desk's proposals, so a row left behind
 * is a body that stays on disk for ever.
 */

let fx: ProposalsFixture;

beforeEach(() => {
  fx = openProposalsFixture();
});

afterEach(() => {
  fx.db.close();
});

function rowsOf(workspaceId: string): number {
  return (
    fx.db.prepare("SELECT COUNT(*) AS n FROM file_proposals WHERE workspace_id = ?").get(workspaceId) as { n: number }
  ).n;
}

function propose(tenant: typeof DESK_A, path: string): string {
  return fx.store.propose(tenant, {
    runId: "run-1",
    path,
    kind: "write",
    beforeSha256: null,
    afterBody: "secret body",
  });
}

describe("purgeFolderProposals", () => {
  it("removes every proposal of the desk, whatever its status, and leaves another desk's alone", async () => {
    const pending = propose(DESK_A, "a.txt");
    const decided = propose(DESK_A, "b.txt");
    fx.store.reject(DESK_A, decided);
    const applied = propose(DESK_A, "c.txt");
    fx.store.claim(DESK_A, applied);
    fx.store.finish(DESK_A, applied, "applied");
    propose(DESK_B, "a.txt");
    expect(rowsOf(DESK_A.workspaceId)).toBe(3);

    const removed = await purgeFolderProposals(DESK_A.workspaceId, { store: fx.store });

    expect(removed).toBe(3);
    expect(rowsOf(DESK_A.workspaceId)).toBe(0);
    expect(fx.store.get(DESK_A, pending)).toBeNull();
    expect(rowsOf(DESK_B.workspaceId)).toBe(1);
  });

  it("is a no-op for a desk with no proposals", async () => {
    propose(DESK_B, "a.txt");
    expect(await purgeFolderProposals(DESK_A.workspaceId, { store: fx.store })).toBe(0);
    expect(rowsOf(DESK_B.workspaceId)).toBe(1);
  });
});
