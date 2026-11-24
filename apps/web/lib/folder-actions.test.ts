/**
 * The folder surface's behaviour end to end, with no browser: the real controller and the real
 * reducer over a fake API. What is held: opening takes the folder and keeps its name only, a run
 * ending or a decision re-reads the host, and each way an approval can end lands as its outcome.
 */
import { describe, expect, it, vi } from "vitest";
import type { DesktopFolderPick } from "./folder-actions";
import { createFolderController } from "./folder-actions";
import type { FolderApi, FolderResult, FolderStatus, ProposalDiff, ProposalSummary } from "./folder-api";
import { folderReducer, INITIAL_FOLDER_STATE, type FolderState } from "./folder-state";

const OPEN: FolderStatus = { available: true, mounted: true, name: "notes" };
const CLOSED: FolderStatus = { available: true, mounted: false, name: null };

const WRITE: ProposalSummary = { id: "p1", path: "plan.md", kind: "write", status: "pending" };
const DELETE: ProposalSummary = { id: "p2", path: "old/todo.txt", kind: "delete", status: "pending" };

const ok = <T>(value: T): FolderResult<T> => ({ ok: true, value });
const fail = (code: Extract<FolderResult<never>, { ok: false }>["code"], status = 409): FolderResult<never> => ({
  ok: false,
  code,
  status,
});

function diffOf(proposal: ProposalSummary, over: Partial<ProposalDiff> = {}): ProposalDiff {
  return { ...proposal, before: "one\ntwo\n", after: "one\n2\n", stale: false, ...over };
}

/** A host whose pending list shrinks as proposals are decided, like the real one. */
function fakeApi(over: Partial<FolderApi> = {}): FolderApi {
  const waiting = new Map([WRITE, DELETE].map((item) => [item.id, item]));
  return {
    status: vi.fn(async () => ok(OPEN)),
    mount: vi.fn(async () => ok(OPEN)),
    unmount: vi.fn(async () => ok(true as const)),
    pending: vi.fn(async () => ok([...waiting.values()])),
    diff: vi.fn(async (id: string) => ok(diffOf(id === "p1" ? WRITE : DELETE))),
    approve: vi.fn(async (id: string) => {
      waiting.delete(id);
      return ok({ status: "applied" as const });
    }),
    reject: vi.fn(async (id: string) => {
      waiting.delete(id);
      return ok(true as const);
    }),
    ...over,
  };
}

function harness(
  api: FolderApi,
  pick: () => Promise<DesktopFolderPick | null> = async () => ({ path: "/x/notes" }),
  initial = INITIAL_FOLDER_STATE,
) {
  let current: FolderState = initial;
  const controller = createFolderController({
    api,
    pickFolder: pick,
    getState: () => current,
    dispatch: (action) => {
      current = folderReducer(current, action);
    },
  });
  return { controller, state: () => current };
}

describe("refresh", () => {
  it("reads the status, then the pending proposals when a folder is open", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    expect(state().status).toEqual(OPEN);
    expect(state().pending.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(api.pending).toHaveBeenCalledTimes(1);
  });

  it("does not ask for proposals when no folder is open, and empties the list", async () => {
    const api = fakeApi({ status: vi.fn(async () => ok(CLOSED)) });
    const { controller, state } = harness(api, undefined, { ...INITIAL_FOLDER_STATE, pending: [WRITE] });
    await controller.refresh();
    expect(api.pending).not.toHaveBeenCalled();
    expect(state().pending).toEqual([]);
  });

  it("stays hidden on a host without the routes: a first failure reads as no folder, with no error shown", async () => {
    const api = fakeApi({ status: vi.fn(async () => fail("not_found", 404)) });
    const { controller, state } = harness(api);
    await controller.refresh();
    expect(state().status).toEqual({ available: false, mounted: false, name: null });
    expect(state().error).toBeNull();
  });

  it("keeps what it was showing and says why when a later read fails", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    (api.status as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fail("network", 0));
    await controller.refresh();
    expect(state().status).toEqual(OPEN);
    expect(state().pending).toHaveLength(2);
    expect(state().error).toBe("network");
  });

  it("applies only the newest of two overlapping reads", async () => {
    let releaseFirst: (value: FolderResult<FolderStatus>) => void = () => undefined;
    const slow = new Promise<FolderResult<FolderStatus>>((resolve) => {
      releaseFirst = resolve;
    });
    const status = vi.fn<FolderApi["status"]>().mockReturnValueOnce(slow).mockResolvedValueOnce(ok(OPEN));
    const { controller, state } = harness(fakeApi({ status }));
    const first = controller.refresh();
    await controller.refresh();
    releaseFirst(ok(CLOSED));
    await first;
    expect(state().status).toEqual(OPEN);
  });
});

describe("open", () => {
  it("mounts the picked path once and keeps only the folder's name", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api, async () => ({ path: "C:\\Users\\me\\secret place\\notes" }));
    await controller.open();
    expect(api.mount).toHaveBeenCalledTimes(1);
    expect(api.mount).toHaveBeenCalledWith("C:\\Users\\me\\secret place\\notes");
    expect(state().status).toEqual(OPEN);
    expect(JSON.stringify(state())).not.toContain("secret place");
    expect(state().mounting).toBe(false);
    expect(state().pending).toHaveLength(2);
  });

  it("does nothing when the dialog is closed without a choice", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api, async () => ({ canceled: true }));
    await controller.open();
    expect(api.mount).not.toHaveBeenCalled();
    expect(state().error).toBeNull();
    expect(state().mounting).toBe(false);
  });

  it("says so when this shell has no folder dialog", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api, async () => null);
    await controller.open();
    expect(api.mount).not.toHaveBeenCalled();
    expect(state().error).toBe("noPicker");
  });

  it("shows the host's refusal as its code", async () => {
    const api = fakeApi({ mount: vi.fn(async () => fail("folder_mount_refused", 400)) });
    const { controller, state } = harness(api);
    await controller.open();
    expect(state().error).toBe("folder_mount_refused");
    expect(state().mounting).toBe(false);
  });

  it("clears an old error when the owner tries again", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api, undefined, { ...INITIAL_FOLDER_STATE, error: "folder_mount_refused" });
    await controller.open();
    expect(state().error).toBeNull();
  });
});

describe("close", () => {
  it("drops the folder, its proposals and the decided rows", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p1", "approve");
    expect(state().decided).toHaveLength(1);
    await controller.close();
    expect(api.unmount).toHaveBeenCalledTimes(1);
    expect(state().status).toEqual({ available: true, mounted: false, name: null });
    expect(state().pending).toEqual([]);
    expect(state().decided).toEqual([]);
  });

  it("keeps the folder open and says why when the host cannot close it", async () => {
    const api = fakeApi({ unmount: vi.fn(async () => fail("network", 0)) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.close();
    expect(state().status?.mounted).toBe(true);
    expect(state().error).toBe("network");
  });
});

describe("looking at a change", () => {
  it("loads the diff the first time a row opens, and not again while it stays loaded", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.toggleDiff("p1");
    expect(state().expanded).toEqual(["p1"]);
    expect(state().diffs.p1).toEqual({ phase: "ready", diff: diffOf(WRITE) });
    await controller.toggleDiff("p1");
    expect(state().expanded).toEqual([]);
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("asks the host again when a pending row is reopened, so a file that changed shows as stale", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.toggleDiff("p1");
    await controller.toggleDiff("p1");
    (api.diff as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(diffOf(WRITE, { stale: true })));
    await controller.toggleDiff("p1");
    expect(api.diff).toHaveBeenCalledTimes(2);
    const entry = state().diffs.p1;
    expect(entry?.phase === "ready" && entry.diff.stale).toBe(true);
  });

  it("keeps a failed load as a failure the row can show", async () => {
    const api = fakeApi({ diff: vi.fn(async () => fail("network", 0)) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.toggleDiff("p1");
    expect(state().diffs.p1).toEqual({ phase: "failed", code: "network" });
  });

  it("never re-reads a decided row: the file on disk is no longer what was decided on", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.toggleDiff("p1");
    await controller.decide("p1", "approve");
    await controller.toggleDiff("p1");
    await controller.toggleDiff("p1");
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(state().diffs.p1?.phase).toBe("ready");
  });
});

describe("deciding", () => {
  it("approve calls the host and shows the row as applied", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p1", "approve");
    expect(api.approve).toHaveBeenCalledWith("p1");
    expect(state().decided).toEqual([{ id: "p1", path: "plan.md", kind: "write", outcome: { tag: "applied" } }]);
    expect(state().busy).toEqual({});
  });

  it("reads the list again after a decision", async () => {
    const api = fakeApi();
    const { controller } = harness(api);
    await controller.refresh();
    (api.pending as ReturnType<typeof vi.fn>).mockClear();
    (api.pending as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok([DELETE]));
    await controller.decide("p1", "approve");
    expect(api.pending).toHaveBeenCalledTimes(1);
  });

  it("shows a stale approval as stale, with the row removed from pending", async () => {
    const api = fakeApi({ approve: vi.fn(async () => ok({ status: "stale" as const })) });
    const { controller, state } = harness(api);
    await controller.refresh();
    (api.pending as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok([DELETE]));
    await controller.decide("p1", "approve");
    expect(state().decided[0]?.outcome).toEqual({ tag: "stale" });
    expect(state().pending.map((item) => item.id)).toEqual(["p2"]);
  });

  it("shows a failed write with its reason", async () => {
    const api = fakeApi({ approve: vi.fn(async () => ok({ status: "failed" as const, reason: "denied" as const })) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p2", "approve");
    expect(state().decided[0]).toEqual({
      id: "p2",
      path: "old/todo.txt",
      kind: "delete",
      outcome: { tag: "failed", reason: "denied" },
    });
  });

  it("reject calls the host and shows the row as rejected", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p2", "reject");
    expect(api.reject).toHaveBeenCalledWith("p2");
    expect(api.approve).not.toHaveBeenCalled();
    expect(state().decided[0]?.outcome).toEqual({ tag: "rejected" });
  });

  it("reads 'already decided' and 'gone' as a note, not an error", async () => {
    const api = fakeApi({ approve: vi.fn(async () => fail("proposal_not_pending")) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p1", "approve");
    expect(state().decided[0]?.outcome).toEqual({ tag: "gone" });
    expect(state().rowErrors).toEqual({});
  });

  it("keeps the row pending, and retryable, when the call itself fails", async () => {
    const api = fakeApi({ approve: vi.fn(async () => fail("network", 0)) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p1", "approve");
    expect(state().pending.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(state().rowErrors).toEqual({ p1: "network" });
    expect(state().busy).toEqual({});
    expect(state().decided).toEqual([]);
  });

  it("keeps the row pending when no folder is open any more", async () => {
    const api = fakeApi({ approve: vi.fn(async () => fail("folder_not_mounted")) });
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.decide("p1", "approve");
    expect(state().rowErrors).toEqual({ p1: "folder_not_mounted" });
  });

  it("ignores a second press while a decision is on its way", async () => {
    let release: (value: FolderResult<{ status: "applied" }>) => void = () => undefined;
    const approve = vi.fn(
      () =>
        new Promise<FolderResult<{ status: "applied" }>>((resolve) => {
          release = resolve;
        }),
    );
    const api = fakeApi({ approve });
    const { controller, state } = harness(api);
    await controller.refresh();
    const first = controller.decide("p1", "approve");
    expect(state().busy).toEqual({ p1: "approve" });
    await controller.decide("p1", "approve");
    expect(approve).toHaveBeenCalledTimes(1);
    release(ok({ status: "applied" as const }));
    await first;
    expect(state().decided).toHaveLength(1);
  });

  it("does nothing for an id that is not pending", async () => {
    const api = fakeApi();
    const { controller } = harness(api);
    await controller.refresh();
    await controller.decide("missing", "approve");
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("dismiss removes the decided row and what was open for it", async () => {
    const api = fakeApi();
    const { controller, state } = harness(api);
    await controller.refresh();
    await controller.toggleDiff("p1");
    await controller.decide("p1", "approve");
    controller.dismiss("p1");
    expect(state().decided).toEqual([]);
    expect(state().expanded).toEqual([]);
    expect(state().diffs).toEqual({});
  });
});
