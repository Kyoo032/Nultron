import { describe, expect, it, vi } from "vitest";
import type { FilesApi, FilesOutcome } from "./files-api";
import type { FileRead, FileVersion } from "./files-model";
import {
  VIEWER_CLOSED,
  isViewingLatest,
  loadFileViewer,
  restoreRequest,
  restoreVersion,
  shownText,
  versionToFetch,
  viewerReducer,
  type ViewerAction,
  type ViewerState,
} from "./files-state";

const PATH = "notes/plan.md";

function version(n: number, over: Partial<FileVersion> = {}): FileVersion {
  return {
    version: n,
    bytes: n,
    sha256: `h${n}`,
    authorKind: "user",
    authorId: "u1",
    mode: null,
    createdAt: n,
    ...over,
  };
}

function read(n: number, text: string): FileRead {
  return { path: PATH, text, sha256: `h${n}`, bytes: text.length, version: n };
}

function run(actions: readonly ViewerAction[], from: ViewerState = VIEWER_CLOSED): ViewerState {
  return actions.reduce(viewerReducer, from);
}

const THREE = [version(1), version(2, { authorKind: "agent", authorId: "run-1", mode: "research" }), version(3)];

function ready(): ViewerState {
  return run([
    { type: "open", path: PATH },
    { type: "loaded", path: PATH, head: read(3, "three"), versions: THREE },
  ]);
}

function fakeApi(over: Partial<FilesApi> = {}): FilesApi {
  const fail = async (): Promise<FilesOutcome<never>> => ({ ok: false, code: "error", status: 500 });
  return { list: fail, content: fail, versions: fail, version: fail, save: fail, revert: fail, remove: fail, ...over };
}

describe("opening a file", () => {
  it("goes closed, loading, then ready on the head with the newest version in view", () => {
    const loading = run([{ type: "open", path: PATH }]);
    expect(loading).toEqual({ phase: "loading", path: PATH });
    const state = ready();
    expect(state).toMatchObject({ phase: "ready", path: PATH, viewing: 3, confirm: "none", textError: null });
    expect(shownText(state)?.text).toBe("three");
    expect(isViewingLatest(state)).toBe(true);
    expect(versionToFetch(state)).toBeNull();
  });

  it("ignores an answer for a file that is no longer the one open", () => {
    const state = run([
      { type: "open", path: PATH },
      { type: "open", path: "other.md" },
      { type: "loaded", path: PATH, head: read(3, "three"), versions: THREE },
    ]);
    expect(state).toEqual({ phase: "loading", path: "other.md" });
    expect(run([{ type: "loaded", path: PATH, head: read(3, "x"), versions: THREE }])).toEqual(VIEWER_CLOSED);
  });

  it("fails with the host's code, and close clears it", () => {
    const failed = run([
      { type: "open", path: PATH },
      { type: "failed", path: PATH, code: "not_found" },
    ]);
    expect(failed).toEqual({ phase: "failed", path: PATH, code: "not_found" });
    expect(viewerReducer(failed, { type: "close" })).toEqual(VIEWER_CLOSED);
  });
});

describe("looking at an older version", () => {
  it("asks for its text once, shows it when it lands, and keeps it", () => {
    const picked = viewerReducer(ready(), { type: "pick", version: 1 });
    expect(picked).toMatchObject({ viewing: 1 });
    expect(shownText(picked)).toBeNull();
    expect(versionToFetch(picked)).toBe(1);
    expect(isViewingLatest(picked)).toBe(false);

    const loaded = viewerReducer(picked, { type: "versionLoaded", path: PATH, version: 1, read: read(1, "one") });
    expect(shownText(loaded)?.text).toBe("one");
    expect(versionToFetch(loaded)).toBeNull();

    const back = viewerReducer(viewerReducer(loaded, { type: "pick", version: 3 }), { type: "pick", version: 1 });
    expect(versionToFetch(back)).toBeNull();
    expect(shownText(back)?.text).toBe("one");
  });

  it("does not pick a version the history does not hold", () => {
    expect(viewerReducer(ready(), { type: "pick", version: 9 })).toEqual(ready());
  });

  it("holds a failed read as an error and stops asking for it", () => {
    const failed = run(
      [
        { type: "pick", version: 2 },
        { type: "versionFailed", path: PATH, version: 2, code: "not_found" },
      ],
      ready(),
    );
    expect(failed).toMatchObject({ viewing: 2, textError: "not_found" });
    expect(versionToFetch(failed)).toBeNull();
    // Picking another version clears it.
    expect(viewerReducer(failed, { type: "pick", version: 1 })).toMatchObject({ textError: null });
  });

  it("drops a late text for a version no longer in view when it failed", () => {
    const state = run([{ type: "pick", version: 1 }], ready());
    expect(viewerReducer(state, { type: "versionFailed", path: PATH, version: 2, code: "x" })).toEqual(state);
  });
});

describe("the questions", () => {
  it("offers restore only on an older version and delete anywhere", () => {
    expect(viewerReducer(ready(), { type: "ask", confirm: "restore" })).toMatchObject({ confirm: "none" });
    expect(viewerReducer(ready(), { type: "ask", confirm: "delete" })).toMatchObject({ confirm: "delete" });
    const older = viewerReducer(ready(), { type: "pick", version: 2 });
    const asked = viewerReducer(older, { type: "ask", confirm: "restore" });
    expect(asked).toMatchObject({ confirm: "restore" });
    expect(viewerReducer(asked, { type: "cancelConfirm" })).toMatchObject({ confirm: "none" });
  });

  it("closes a question when another version is picked", () => {
    const asked = run(
      [
        { type: "pick", version: 2 },
        { type: "ask", confirm: "restore" },
        { type: "pick", version: 1 },
      ],
      ready(),
    );
    expect(asked).toMatchObject({ viewing: 1, confirm: "none" });
  });
});

describe("loadFileViewer", () => {
  it("loads the head and the history together and fails if either fails", async () => {
    const api = fakeApi({
      content: async () => ({ ok: true, data: read(3, "three") }),
      versions: async () => ({ ok: true, data: THREE }),
    });
    expect(await loadFileViewer(api, PATH)).toEqual({ ok: true, head: read(3, "three"), versions: THREE });

    const noHead = fakeApi({
      content: async () => ({ ok: false, code: "not_found", status: 404 }),
      versions: async () => ({ ok: true, data: THREE }),
    });
    expect(await loadFileViewer(noHead, PATH)).toEqual({ ok: false, code: "not_found" });

    const noHistory = fakeApi({
      content: async () => ({ ok: true, data: read(3, "x") }),
      versions: async () => ({ ok: false, code: "root_unavailable", status: 503 }),
    });
    expect(await loadFileViewer(noHistory, PATH)).toEqual({ ok: false, code: "root_unavailable" });
  });
});

describe("restore", () => {
  it("sends the path and the version in view, not the head", async () => {
    const revert = vi.fn(async () => ({ ok: true, data: { path: PATH, version: 4 } }) as const);
    const api = fakeApi({ revert });
    const state = viewerReducer(ready(), { type: "pick", version: 2 });
    expect(restoreRequest(state)).toEqual({ path: PATH, version: 2 });
    const out = await restoreVersion(api, state);
    expect(revert).toHaveBeenCalledTimes(1);
    expect(revert).toHaveBeenCalledWith(PATH, 2);
    expect(out).toEqual({ ok: true, data: { from: 2, saved: { path: PATH, version: 4 } } });
  });

  it("sends nothing when the newest version is in view or no file is open", async () => {
    const revert = vi.fn();
    const api = fakeApi({ revert });
    expect(restoreRequest(ready())).toBeNull();
    expect(restoreRequest(VIEWER_CLOSED)).toBeNull();
    expect(await restoreVersion(api, ready())).toMatchObject({ ok: false });
    expect(await restoreVersion(api, VIEWER_CLOSED)).toMatchObject({ ok: false });
    expect(revert).not.toHaveBeenCalled();
  });

  it("passes the host's refusal through", async () => {
    const api = fakeApi({ revert: async () => ({ ok: false, code: "storage_quota_exceeded", status: 403 }) });
    const state = viewerReducer(ready(), { type: "pick", version: 1 });
    expect(await restoreVersion(api, state)).toEqual({ ok: false, code: "storage_quota_exceeded", status: 403 });
  });
});
