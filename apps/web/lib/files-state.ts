/**
 * What the file viewer is showing, as a reducer, and the few calls that move it.
 *
 * The viewer is a small state machine: closed, loading a file's head and history, failed, or ready with
 * one version in view. Opening a file loads the head text and the version list together; picking an
 * older version loads that text once and keeps it. Restore and delete ask first (`confirm`), and the
 * restore button always carries the version in view, never the head. No React in here, so the whole
 * flow runs in a unit test against a fake `FilesApi` (`files-state.test.ts`).
 */
import type { FilesApi, FilesOutcome, SavedFile } from "./files-api";
import type { FileEntry, FileRead, FileVersion } from "./files-model";

export type Confirm = "none" | "restore" | "delete";

export type ViewerState =
  | { readonly phase: "closed" }
  | { readonly phase: "loading"; readonly path: string }
  | { readonly phase: "failed"; readonly path: string; readonly code: string }
  | {
      readonly phase: "ready";
      readonly path: string;
      readonly versions: readonly FileVersion[];
      /** The version in view. The head until an older one is picked. */
      readonly viewing: number;
      /** Version number to the text already fetched for it. The head is in here from the start. */
      readonly texts: Readonly<Record<number, FileRead>>;
      /** The host's code when the version in view could not be read. */
      readonly textError: string | null;
      readonly confirm: Confirm;
    };

export const VIEWER_CLOSED: ViewerState = { phase: "closed" };

export type ViewerAction =
  | { readonly type: "open"; readonly path: string }
  | { readonly type: "close" }
  | {
      readonly type: "loaded";
      readonly path: string;
      readonly head: FileRead;
      readonly versions: readonly FileVersion[];
    }
  | { readonly type: "failed"; readonly path: string; readonly code: string }
  | { readonly type: "pick"; readonly version: number }
  | { readonly type: "versionLoaded"; readonly path: string; readonly version: number; readonly read: FileRead }
  | { readonly type: "versionFailed"; readonly path: string; readonly version: number; readonly code: string }
  | { readonly type: "ask"; readonly confirm: "restore" | "delete" }
  | { readonly type: "cancelConfirm" };

/** The newest version in a history. Zero for an empty one. */
export function latestVersion(versions: readonly FileVersion[]): number {
  return versions.reduce((newest, entry) => Math.max(newest, entry.version), 0);
}

export function viewerPath(state: ViewerState): string | null {
  return state.phase === "closed" ? null : state.path;
}

/** The text of the version in view, or null while it is still loading or when it failed. */
export function shownText(state: ViewerState): FileRead | null {
  return state.phase === "ready" ? (state.texts[state.viewing] ?? null) : null;
}

export function isViewingLatest(state: ViewerState): boolean {
  return state.phase === "ready" && state.viewing === latestVersion(state.versions);
}

/** The version whose text is missing and should be fetched now, or null. */
export function versionToFetch(state: ViewerState): number | null {
  if (state.phase !== "ready" || state.textError !== null || state.texts[state.viewing]) {
    return null;
  }
  return state.viewing;
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case "open":
      return { phase: "loading", path: action.path };
    case "close":
      return VIEWER_CLOSED;
    case "loaded": {
      if (state.phase === "closed" || state.path !== action.path) {
        return state;
      }
      const viewing = action.head.version ?? latestVersion(action.versions);
      return {
        phase: "ready",
        path: action.path,
        versions: action.versions,
        viewing,
        texts: { [viewing]: action.head },
        textError: null,
        confirm: "none",
      };
    }
    case "failed":
      return state.phase === "closed" || state.path !== action.path
        ? state
        : { phase: "failed", path: action.path, code: action.code };
    case "pick": {
      if (state.phase !== "ready" || !state.versions.some((entry) => entry.version === action.version)) {
        return state;
      }
      return { ...state, viewing: action.version, textError: null, confirm: "none" };
    }
    case "versionLoaded": {
      if (state.phase !== "ready" || state.path !== action.path) {
        return state;
      }
      return { ...state, texts: { ...state.texts, [action.version]: action.read } };
    }
    case "versionFailed": {
      if (state.phase !== "ready" || state.path !== action.path || state.viewing !== action.version) {
        return state;
      }
      return { ...state, textError: action.code };
    }
    case "ask": {
      if (state.phase !== "ready") {
        return state;
      }
      // Restoring the version that is already the newest would only repeat it.
      if (action.confirm === "restore" && isViewingLatest(state)) {
        return state;
      }
      return { ...state, confirm: action.confirm };
    }
    case "cancelConfirm":
      return state.phase === "ready" ? { ...state, confirm: "none" } : state;
    default:
      return state;
  }
}

export type ViewerLoad =
  | { readonly ok: true; readonly head: FileRead; readonly versions: readonly FileVersion[] }
  | { readonly ok: false; readonly code: string };

/** A file's head text and its history, together. Either failing fails the open. */
export async function loadFileViewer(api: FilesApi, path: string): Promise<ViewerLoad> {
  const [head, versions] = await Promise.all([api.content(path), api.versions(path)]);
  if (!head.ok) {
    return { ok: false, code: head.code };
  }
  if (!versions.ok) {
    return { ok: false, code: versions.code };
  }
  return { ok: true, head: head.data, versions: versions.data };
}

/** What a Restore press would send: the path and the version in view. Null when there is nothing to restore. */
export function restoreRequest(state: ViewerState): { readonly path: string; readonly version: number } | null {
  if (state.phase !== "ready" || isViewingLatest(state)) {
    return null;
  }
  return { path: state.path, version: state.viewing };
}

export type RestoreDone = { readonly from: number; readonly saved: SavedFile };

/** POST the revert for the version in view. Sends nothing, and says so, when the newest is in view. */
export async function restoreVersion(api: FilesApi, state: ViewerState): Promise<FilesOutcome<RestoreDone>> {
  const request = restoreRequest(state);
  if (request === null) {
    return { ok: false, code: "invalid_request", status: 0 };
  }
  const outcome = await api.revert(request.path, request.version);
  return outcome.ok ? { ok: true, data: { from: request.version, saved: outcome.data } } : outcome;
}

export type FilesListState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly items: readonly FileEntry[] }
  | { readonly status: "failed"; readonly code: string };

export const FILES_LIST_LOADING: FilesListState = { status: "loading" };

/** The list call as a list state. */
export async function loadFileList(api: FilesApi): Promise<FilesListState> {
  const outcome = await api.list();
  return outcome.ok ? { status: "ready", items: outcome.data } : { status: "failed", code: outcome.code };
}
