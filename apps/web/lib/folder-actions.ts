/**
 * What the owner can do with the folder surface, as plain async functions over the folder API.
 *
 * Kept out of the component so the whole flow (open, close, look at a change, approve, reject) can
 * be driven in a test with a fake API and a reducer, with no browser. The component owns only the
 * hook that feeds `dispatch` and `getState`.
 *
 * Reads race: a run ending and a decision finishing can both ask the host for the list, and the
 * slower answer must not overwrite the newer one, so each refresh takes a number and only the latest
 * is applied.
 */
import type { DesktopFolderPick } from "./desktop-bridge";
import { NO_FOLDER, type ApproveOutcome, type FolderApi, type ProposalSummary } from "./folder-api";
import type { FolderAction, FolderState, Outcome } from "./folder-state";

export type FolderControllerDeps = {
  readonly api: FolderApi;
  readonly dispatch: (action: FolderAction) => void;
  readonly getState: () => FolderState;
  /** The shell's folder dialog; `null` when this shell has none. */
  readonly pickFolder: () => Promise<DesktopFolderPick | null>;
};

export type FolderController = {
  refresh(): Promise<void>;
  open(): Promise<void>;
  close(): Promise<void>;
  toggleDiff(id: string): Promise<void>;
  decide(id: string, decision: "approve" | "reject"): Promise<void>;
  dismiss(id: string): void;
  clearError(): void;
};

function outcomeOf(result: ApproveOutcome): Outcome {
  if (result.status === "failed") {
    return { tag: "failed", reason: result.reason };
  }
  return { tag: result.status };
}

/** A decision the host says was already made, or on a proposal it no longer has. */
const ALREADY_DECIDED = new Set(["proposal_not_pending", "not_found"]);

export function createFolderController(deps: FolderControllerDeps): FolderController {
  const { api, dispatch, getState, pickFolder } = deps;
  let latestRefresh = 0;

  async function refresh(): Promise<void> {
    const turn = ++latestRefresh;
    const status = await api.status();
    if (turn !== latestRefresh) {
      return;
    }
    if (!status.ok) {
      // A host without these routes, or one that could not be reached. Nothing is shown for a
      // surface that has never been seen; one that was showing keeps its last picture and says why.
      if (getState().status === null) {
        dispatch({ type: "status", status: NO_FOLDER });
      } else {
        dispatch({ type: "error", code: status.code });
      }
      return;
    }
    dispatch({ type: "status", status: status.value });
    if (!status.value.available || !status.value.mounted) {
      dispatch({ type: "pending", items: [] });
      return;
    }
    const pending = await api.pending();
    if (turn !== latestRefresh) {
      return;
    }
    if (!pending.ok) {
      dispatch({ type: "error", code: pending.code });
      return;
    }
    dispatch({ type: "pending", items: pending.value.filter((item) => item.status === "pending") });
  }

  async function open(): Promise<void> {
    dispatch({ type: "mounting", on: true });
    try {
      const picked = await pickFolder();
      if (picked === null) {
        dispatch({ type: "error", code: "noPicker" });
        return;
      }
      if ("canceled" in picked) {
        return;
      }
      const mounted = await api.mount(picked.path);
      if (!mounted.ok) {
        dispatch({ type: "error", code: mounted.code });
        return;
      }
      dispatch({ type: "status", status: mounted.value });
      await refresh();
    } catch {
      dispatch({ type: "error", code: "unknown" });
    } finally {
      dispatch({ type: "mounting", on: false });
    }
  }

  async function close(): Promise<void> {
    const closed = await api.unmount();
    if (!closed.ok) {
      dispatch({ type: "error", code: closed.code });
      return;
    }
    // Invalidate any list still on its way: it was asked for before the folder went away.
    latestRefresh += 1;
    dispatch({ type: "closed" });
  }

  async function toggleDiff(id: string): Promise<void> {
    const before = getState();
    const wasOpen = before.expanded.includes(id);
    dispatch({ type: "toggled", id });
    if (wasOpen) {
      return;
    }
    // A decided row's file has already changed on disk, so the host's "now" is no longer what the
    // owner decided on: the diff read before the decision is the one that stays.
    if (before.decided.some((row) => row.id === id)) {
      return;
    }
    if (before.diffs[id]?.phase !== "ready") {
      dispatch({ type: "diff", id, entry: { phase: "loading" } });
    }
    const result = await api.diff(id);
    dispatch({
      type: "diff",
      id,
      entry: result.ok ? { phase: "ready", diff: result.value } : { phase: "failed", code: result.code },
    });
  }

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    const state = getState();
    const row: ProposalSummary | undefined = state.pending.find((item) => item.id === id);
    if (!row || state.busy[id]) {
      return;
    }
    dispatch({ type: "busy", id, decision });
    const summary = { id: row.id, path: row.path, kind: row.kind };
    if (decision === "approve") {
      const result = await api.approve(id);
      if (result.ok) {
        dispatch({ type: "decided", row: summary, outcome: outcomeOf(result.value) });
      } else if (ALREADY_DECIDED.has(result.code)) {
        dispatch({ type: "decided", row: summary, outcome: { tag: "gone" } });
      } else {
        dispatch({ type: "rowError", id, code: result.code });
        return;
      }
    } else {
      const result = await api.reject(id);
      if (result.ok) {
        dispatch({ type: "decided", row: summary, outcome: { tag: "rejected" } });
      } else if (ALREADY_DECIDED.has(result.code)) {
        dispatch({ type: "decided", row: summary, outcome: { tag: "gone" } });
      } else {
        dispatch({ type: "rowError", id, code: result.code });
        return;
      }
    }
    await refresh();
  }

  return {
    refresh,
    open,
    close,
    toggleDiff,
    decide,
    dismiss: (id) => dispatch({ type: "dismissed", id }),
    clearError: () => dispatch({ type: "error", code: null }),
  };
}
