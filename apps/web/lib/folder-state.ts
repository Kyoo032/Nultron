/**
 * What the folder control and the "changes to approve" panel know, as one pure reducer.
 *
 * Every transition returns a new object; nothing here mutates a previous state. The host is the
 * source of truth (it owns the mount and the proposals), so this is a picture of its last answers
 * plus what the owner has done since: which rows are open, which are mid-decision, and the outcome
 * of each decision, kept on screen until the owner dismisses it because a decided proposal is no
 * longer in the host's pending list and would otherwise vanish the moment it was approved.
 */
import type {
  ApplyFailure,
  FolderErrorCode,
  FolderStatus,
  ProposalDiff,
  ProposalKind,
  ProposalSummary,
} from "./folder-api";

export type Decision = "approve" | "reject";

/** How a decision ended, for the line under a row. */
export type Outcome =
  | { readonly tag: "applied" }
  | { readonly tag: "stale" }
  | { readonly tag: "failed"; readonly reason: ApplyFailure }
  | { readonly tag: "rejected" }
  /** Somebody else decided first, or the proposal is gone. */
  | { readonly tag: "gone" };

export type DiffEntry =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly diff: ProposalDiff }
  | { readonly phase: "failed"; readonly code: FolderErrorCode };

export type DecidedRow = {
  readonly id: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly outcome: Outcome;
};

export type FolderState = {
  /** The host's last answer; null until the first one, which is when the surface stays hidden. */
  readonly status: FolderStatus | null;
  readonly pending: readonly ProposalSummary[];
  readonly decided: readonly DecidedRow[];
  /** Ids of rows whose changes are showing. */
  readonly expanded: readonly string[];
  readonly diffs: Readonly<Record<string, DiffEntry>>;
  /** A decision on its way to the host, by proposal id. */
  readonly busy: Readonly<Record<string, Decision>>;
  /** Why a decision did not go through, by proposal id; the row stays pending and can be retried. */
  readonly rowErrors: Readonly<Record<string, FolderErrorCode>>;
  readonly mounting: boolean;
  readonly error: FolderErrorCode | null;
};

export const INITIAL_FOLDER_STATE: FolderState = Object.freeze({
  status: null,
  pending: [],
  decided: [],
  expanded: [],
  diffs: {},
  busy: {},
  rowErrors: {},
  mounting: false,
  error: null,
});

export type FolderAction =
  | { readonly type: "status"; readonly status: FolderStatus }
  | { readonly type: "pending"; readonly items: readonly ProposalSummary[] }
  | { readonly type: "toggled"; readonly id: string }
  | { readonly type: "diff"; readonly id: string; readonly entry: DiffEntry }
  | { readonly type: "busy"; readonly id: string; readonly decision: Decision }
  | { readonly type: "rowError"; readonly id: string; readonly code: FolderErrorCode }
  | { readonly type: "decided"; readonly row: Pick<ProposalSummary, "id" | "path" | "kind">; readonly outcome: Outcome }
  | { readonly type: "dismissed"; readonly id: string }
  | { readonly type: "mounting"; readonly on: boolean }
  | { readonly type: "closed" }
  | { readonly type: "error"; readonly code: FolderErrorCode | null };

function without<T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
}

function keepOnly<T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => ids.has(key)));
}

export function folderReducer(state: FolderState, action: FolderAction): FolderState {
  switch (action.type) {
    case "status":
      return { ...state, status: action.status, error: null };
    case "pending": {
      // A row the host no longer lists as pending is decided or gone: drop what was open for it,
      // unless it is a decided row still on screen under its outcome.
      const live = new Set([...action.items.map((item) => item.id), ...state.decided.map((row) => row.id)]);
      return {
        ...state,
        // A row already decided here is not pending any more, whatever a late read says.
        pending: action.items.filter((item) => !state.decided.some((row) => row.id === item.id)),
        expanded: state.expanded.filter((id) => live.has(id)),
        diffs: keepOnly(state.diffs, live),
        busy: keepOnly(state.busy, live),
        rowErrors: keepOnly(state.rowErrors, live),
      };
    }
    case "toggled":
      return {
        ...state,
        expanded: state.expanded.includes(action.id)
          ? state.expanded.filter((id) => id !== action.id)
          : [...state.expanded, action.id],
      };
    case "diff":
      return { ...state, diffs: { ...state.diffs, [action.id]: action.entry } };
    case "busy":
      return {
        ...state,
        busy: { ...state.busy, [action.id]: action.decision },
        rowErrors: without(state.rowErrors, action.id),
      };
    case "rowError":
      return {
        ...state,
        busy: without(state.busy, action.id),
        rowErrors: { ...state.rowErrors, [action.id]: action.code },
      };
    case "decided": {
      const { row, outcome } = action;
      return {
        ...state,
        pending: state.pending.filter((item) => item.id !== row.id),
        decided: [
          { id: row.id, path: row.path, kind: row.kind, outcome },
          ...state.decided.filter((item) => item.id !== row.id),
        ],
        busy: without(state.busy, row.id),
        rowErrors: without(state.rowErrors, row.id),
        // The diff stays in `expanded`/`diffs` so the owner can still read what was decided.
      };
    }
    case "dismissed":
      return {
        ...state,
        decided: state.decided.filter((row) => row.id !== action.id),
        expanded: state.expanded.filter((id) => id !== action.id),
        diffs: without(state.diffs, action.id),
      };
    case "mounting":
      return { ...state, mounting: action.on, error: action.on ? null : state.error };
    case "closed":
      return {
        ...INITIAL_FOLDER_STATE,
        status: state.status ? { ...state.status, mounted: false, name: null } : state.status,
      };
    case "error":
      return { ...state, error: action.code };
  }
}

/** How many changes are waiting for the owner. */
export function pendingCount(state: FolderState): number {
  return state.pending.length;
}

/** Is there anything for the panel to show: a change to decide, or a decision's outcome to read? */
export function hasProposalRows(state: FolderState): boolean {
  return state.pending.length > 0 || state.decided.length > 0;
}
