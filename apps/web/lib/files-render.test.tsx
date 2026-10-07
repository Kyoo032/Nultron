/**
 * The Files section, rendered. `renderToStaticMarkup` against the real catalogs, in both locales:
 * the list grouped by folder, the empty state, the viewer showing a file as literal text, the version
 * list with the restore button on an old version only, the two questions, and the deep link's first
 * state. The environment has no DOM, so presses are covered where the rules live (`files-state.test.ts`
 * for the restore request, `files-api.test.ts` for the wire) and the wiring that joins them is read from
 * the source, as the other render tests here do.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeskFilesView, type DeskFilesActions, type DeskFilesViewProps } from "@/components/files/desk-files-view";
import { FileViewer } from "@/components/files/file-viewer";
import { fileFromSearch, type FileEntry, type FileRead, type FileVersion } from "./files-model";
import {
  FILES_LIST_LOADING,
  VIEWER_CLOSED,
  viewerReducer,
  type FilesListState,
  type ViewerAction,
  type ViewerState,
} from "./files-state";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const NOOP = () => undefined;
const ACTIONS: DeskFilesActions = {
  onOpen: NOOP,
  onRetry: NOOP,
  onToggleForm: NOOP,
  onCloseForm: NOOP,
  onSave: NOOP,
  onUpload: NOOP,
  onCloseViewer: NOOP,
  onPick: NOOP,
  onAsk: NOOP,
  onCancelConfirm: NOOP,
  onConfirmRestore: NOOP,
  onConfirmDelete: NOOP,
  onDownload: NOOP,
};

const PATH = "notes/plan.md";

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return { path, kind: "file", bytes: 2048, updatedAt: Date.UTC(2026, 9, 3, 9, 30), version: 3, ...over };
}

function version(n: number, over: Partial<FileVersion> = {}): FileVersion {
  return {
    version: n,
    bytes: 100 * n,
    sha256: `h${n}`,
    authorKind: "user",
    authorId: "u1",
    mode: null,
    createdAt: Date.UTC(2026, 9, n, 9, 30),
    ...over,
  };
}

function read(n: number, text: string): FileRead {
  return { path: PATH, text, sha256: `h${n}`, bytes: text.length, version: n };
}

const VERSIONS = [version(1), version(2, { authorKind: "agent", authorId: "run-1", mode: "research" }), version(3)];

function viewerOn(text: string, actions: readonly ViewerAction[] = []): ViewerState {
  const steps: ViewerAction[] = [
    { type: "open", path: PATH },
    { type: "loaded", path: PATH, head: read(3, text), versions: VERSIONS },
    ...actions,
  ];
  return steps.reduce(viewerReducer, VIEWER_CLOSED);
}

function view(over: Partial<DeskFilesViewProps> = {}): string {
  const list: FilesListState = { status: "ready", items: [] };
  return renderToStaticMarkup(
    <DeskFilesView
      list={list}
      viewer={VIEWER_CLOSED}
      selfUserId={null}
      formOpen={false}
      busy="none"
      notice={null}
      formError={null}
      uploadError={null}
      actionErrorCode={null}
      actions={ACTIONS}
      {...over}
    />,
  );
}

function viewer(state: ViewerState, selfUserId: string | null = null, downloading = false): string {
  return renderToStaticMarkup(
    <FileViewer
      state={state}
      selfUserId={selfUserId}
      busy={false}
      downloading={downloading}
      actionErrorCode={null}
      onClose={NOOP}
      onPick={NOOP}
      onAsk={NOOP}
      onCancelConfirm={NOOP}
      onConfirmRestore={NOOP}
      onConfirmDelete={NOOP}
      onDownload={NOOP}
    />,
  );
}

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the list", () => {
  const items: FileEntry[] = [
    entry("notes/plan.md"),
    entry("readme.md", { bytes: 12, version: 1 }),
    entry("notes/draft.md"),
  ];

  it("groups by folder, top level first, one row per file with size, version and time", () => {
    const html = view({ list: { status: "ready", items } });
    expect(count(html, "files-section")).toBe(1);
    expect(count(html, "files-list")).toBe(1);
    expect(count(html, "files-item")).toBe(3);
    expect(count(html, "files-empty")).toBe(0);
    const headings = [...html.matchAll(/data-testid="files-folder" data-folder="([^"]*)"/g)].map((m) => m[1]);
    expect(headings).toEqual(["", "notes"]);
    expect(html).toContain(t("files.list.topLevel"));
    expect(html).toContain("notes/");
    expect(html).toContain("2.0\u00a0KB");
    expect(html).toContain("12\u00a0B");
    expect(html).toContain("v3");
    expect(html).toContain("Oct 3, 2026");
    expect(html).toContain('data-testid="files-count"');
    expect(html).toContain("3 files");
    // Names are shown without their folder; the full path rides on the title and the accessible name.
    expect(html).toContain('title="notes/plan.md"');
    expect(html).toContain('aria-label="Open notes/plan.md"');
  });

  it("marks the open file's row as selected", () => {
    const html = view({ list: { status: "ready", items }, viewer: viewerOn("hello") });
    const selected = [...html.matchAll(/<button[^>]*data-testid="files-item"[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('aria-current="true"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('data-path="notes/plan.md"');
  });

  it("scrolls the list on its own and lets a keyboard reach it", () => {
    const html = view({ list: { status: "ready", items } });
    const tag = html.match(/<div[^>]*data-testid="files-list"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain("overflow-y-auto");
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain('role="region"');
  });

  it("explains an empty desk instead of drawing an empty list", () => {
    const html = view({ list: { status: "ready", items: [] } });
    expect(count(html, "files-empty")).toBe(1);
    expect(count(html, "files-list")).toBe(0);
    expect(html).toContain("No files yet");
    expect(html).toContain("Files your agents create land here");
    expect(count(html, "files-count")).toBe(0);
  });

  it("says it is loading, and when it could not load offers a retry", () => {
    expect(view({ list: FILES_LIST_LOADING })).toContain(t("files.list.loading"));
    const failed = view({ list: { status: "failed", code: "root_unavailable" } });
    expect(failed).toContain(t("files.errors.unavailable"));
    expect(failed).toContain('data-testid="files-retry"');
    expect(count(failed, "files-empty")).toBe(0);
  });

  it("has the New file button and a file picker", () => {
    const html = view();
    expect(html).toContain('data-testid="files-new"');
    expect(html).toContain('data-testid="files-upload"');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*data-testid="files-upload-input"/);
    expect(html).toContain(t("files.new.open"));
  });

  it("opens the new file form with a labelled path and text field, and shows a refusal", () => {
    const html = view({ formOpen: true, formError: "Nope" });
    expect(html).toContain('data-testid="files-new-form"');
    expect(html).toMatch(/<label[^>]*>File path<\/label>/);
    expect(html).toContain('data-testid="files-new-path"');
    expect(html).toContain('data-testid="files-new-content"');
    expect(html).toMatch(/role="alert"[^>]*data-testid="files-new-error"[^>]*>Nope</);
  });

  it("shows a refused upload and a success note as live regions", () => {
    const html = view({ uploadError: "Not text", notice: "Saved notes/plan.md as version 2." });
    expect(html).toMatch(/role="alert"[^>]*data-testid="files-upload-error"[^>]*>Not text</);
    expect(html).toMatch(/role="status"[^>]*data-testid="files-notice"[^>]*>Saved notes\/plan\.md as version 2\.</);
  });
});

describe("the viewer shows text, not markup", () => {
  const hostile = '<script>alert("x")</script>\n<img src=x onerror=alert(1)>\n**not bold** & <b>raw</b>';

  it("renders HTML-looking content as literal, escaped text", () => {
    const html = viewer(viewerOn(hostile));
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("**not bold** &amp; &lt;b&gt;raw&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>raw");
  });

  it("numbers the lines in a monospace, scrollable, keyboard-reachable pane", () => {
    const html = viewer(viewerOn("one\ntwo\nthree\n"));
    const pane = html.match(/<div[^>]*data-testid="file-viewer-text"[^>]*>/)?.[0] ?? "";
    expect(pane).toContain("font-mono");
    expect(pane).toContain("overflow-auto");
    expect(pane).toContain('tabindex="0"');
    expect(pane).toContain('aria-label="Text of notes/plan.md"');
    expect(html).toMatch(/aria-hidden="true"[^>]*data-testid="file-viewer-numbers"[^>]*>1\n2\n3<\/pre>/);
    expect(html).toMatch(/data-testid="file-viewer-lines"[^>]*>one\ntwo\nthree<\/pre>/);
  });

  it("says so for an empty file and for a file cut at the render cap", () => {
    expect(viewer(viewerOn(""))).toContain(t("files.viewer.empty"));
    const long = Array.from({ length: 5200 }, (_, i) => `l${i}`).join("\n");
    const html = viewer(viewerOn(long));
    expect(html).toContain('data-testid="file-viewer-truncated"');
    expect(html).toContain("Showing the first 5,000 of 5,200 lines.");
  });
});

describe("versions and restore", () => {
  it("lists the versions newest first with author, time and size, the one in view marked", () => {
    const html = viewer(viewerOn("three"));
    expect(count(html, "file-versions")).toBe(1);
    const order = [...html.matchAll(/data-testid="file-version" data-version="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([3, 2, 1]);
    const marked = [...html.matchAll(/<button[^>]*data-testid="file-version"[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('aria-current="true"'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('data-version="3"');
    expect(html).toContain("Agent in Research");
    expect(html).toContain("You");
    expect(html).toContain("Latest");
    expect(html).toContain("Oct 2, 2026");
  });

  it("tells a teammate from the signed-in person", () => {
    const html = viewer(viewerOn("three"), "someone-else");
    expect(html).toContain("A teammate");
  });

  it("offers Restore only on an older version", () => {
    expect(count(viewer(viewerOn("three")), "file-restore")).toBe(0);
    const older = viewer(
      viewerOn("three", [
        { type: "pick", version: 1 },
        { type: "versionLoaded", path: PATH, version: 1, read: read(1, "first draft") },
      ]),
    );
    expect(count(older, "file-restore")).toBe(1);
    expect(older).toContain("Restore this version");
    expect(older).toContain("first draft");
    expect(older).toContain("Version 1, not the latest");
    expect(older).toContain("Viewing version 1 of 3");
    expect(count(older, "file-delete")).toBe(1);
  });

  it("offers Download on the newest version only, because the host sends the newest", () => {
    const latest = viewer(viewerOn("three"));
    expect(count(latest, "file-download")).toBe(1);
    expect(latest).toContain(">Download</button>");
    expect(latest).toContain('aria-label="Download notes/plan.md to your computer"');
    const older = viewer(
      viewerOn("three", [
        { type: "pick", version: 1 },
        { type: "versionLoaded", path: PATH, version: 1, read: read(1, "first draft") },
      ]),
    );
    expect(count(older, "file-download")).toBe(0);
  });

  it("disables Download and says so while the file is being fetched", () => {
    const busy = viewer(viewerOn("three"), null, true);
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*data-testid="file-download"[^>]*>Downloading…<\/button>/);
  });

  it("says Download in Indonesian", () => {
    applyLocale("id");
    const html = viewer(viewerOn("three"));
    expect(html).toContain(">Unduh</button>");
    expect(html).toContain('aria-label="Unduh notes/plan.md ke komputer Anda"');
  });

  it("shows a loading line while an older version's text is on its way", () => {
    const html = viewer(viewerOn("three", [{ type: "pick", version: 2 }]));
    expect(html).toContain(t("files.viewer.versionLoading", { version: 2 }));
    expect(count(html, "file-viewer-text")).toBe(0);
  });

  it("asks before restoring, naming the version, and before deleting, naming the file", () => {
    const restore = viewer(
      viewerOn("three", [
        { type: "pick", version: 2 },
        { type: "ask", confirm: "restore" },
      ]),
    );
    expect(restore).toContain('data-testid="file-restore-confirm"');
    expect(restore).toContain('role="alertdialog"');
    expect(restore).toContain("Restore version 2?");
    expect(restore).toContain('data-testid="file-restore-confirm-yes"');
    expect(count(restore, "file-delete-confirm")).toBe(0);

    const del = viewer(viewerOn("three", [{ type: "ask", confirm: "delete" }]));
    expect(del).toContain('data-testid="file-delete-confirm"');
    expect(del).toContain("Delete notes/plan.md?");
    expect(del).toContain("Deleting does not free storage space.");
    expect(count(del, "file-restore-confirm")).toBe(0);
  });

  it("shows a failed restore or delete as an alert", () => {
    const html = renderToStaticMarkup(
      <FileViewer
        state={viewerOn("three")}
        selfUserId={null}
        busy={false}
        downloading={false}
        actionErrorCode="storage_quota_exceeded"
        onClose={NOOP}
        onPick={NOOP}
        onAsk={NOOP}
        onCancelConfirm={NOOP}
        onConfirmRestore={NOOP}
        onConfirmDelete={NOOP}
        onDownload={NOOP}
      />,
    );
    expect(html).toMatch(
      /role="alert"[^>]*data-testid="file-viewer-action-error"[^>]*>This account has no storage space left/,
    );
  });
});

describe("the deep link", () => {
  it("turns ?file= into a loading viewer for that path", () => {
    const path = fileFromSearch("?file=notes%2Fplan.md");
    expect(path).toBe("notes/plan.md");
    const state = viewerReducer(VIEWER_CLOSED, { type: "open", path: path ?? "" });
    const html = view({ viewer: state });
    expect(html).toMatch(/data-testid="file-viewer" data-path="notes\/plan\.md" data-phase="loading"/);
    expect(html).toContain(t("files.viewer.loading"));
  });

  it("says plainly when the linked file is not on the desk", () => {
    const steps: ViewerAction[] = [
      { type: "open", path: "gone.md" },
      { type: "failed", path: "gone.md", code: "not_found" },
    ];
    const state = steps.reduce(viewerReducer, VIEWER_CLOSED);
    const html = viewer(state);
    expect(html).toContain(t("files.viewer.missing"));
    expect(html).toContain('data-testid="file-viewer-close"');
  });

  it("is read from the address by the section and mounted inside the Knowledge Base's Sources tab", () => {
    const section = source("../components/files/desk-files.tsx");
    expect(section).toContain("fileFromSearch(location.search)");
    expect(section).toContain("[deepLink, location.key]");
    expect(section).toContain('dispatch({ type: "open", path: deepLink })');
    const page = source("../components/knowledge-page.tsx");
    expect(page).toContain('import { DeskFiles } from "@/components/files/desk-files";');
    const sources = page.indexOf('data-testid="knowledge-sources"');
    const mount = page.indexOf("<DeskFiles />");
    const soul = page.indexOf('{tab === "soul"');
    expect(sources).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(sources);
    expect(mount).toBeLessThan(soul);
  });
});

describe("the Download wiring", () => {
  it("asks the host for the open file's newest version and shows a refusal in the viewer's alert", () => {
    const text = source("../components/files/desk-files.tsx");
    const start = text.indexOf("async function onDownload()");
    expect(start).toBeGreaterThan(-1);
    const section = text.slice(start, text.indexOf("async function onConfirmDelete()"));
    expect(section).toContain('setBusy("download")');
    expect(section).toContain("await api.download(path)");
    expect(section).toContain("setActionErrorCode(outcome.code)");
    // A second press while one is running does nothing.
    expect(section).toContain('if (busy !== "none" || path === null)');
    expect(text).toContain("onDownload: () => void onDownload()");
    const view = source("../components/files/desk-files-view.tsx");
    expect(view).toContain('downloading={busy === "download"}');
    expect(view).toContain("onDownload={actions.onDownload}");
  });

  it("shows a failed download in the same alert as a failed restore", () => {
    const html = renderToStaticMarkup(
      <FileViewer
        state={viewerOn("three")}
        selfUserId={null}
        busy={false}
        downloading={false}
        actionErrorCode="not_found"
        onClose={NOOP}
        onPick={NOOP}
        onAsk={NOOP}
        onCancelConfirm={NOOP}
        onConfirmRestore={NOOP}
        onConfirmDelete={NOOP}
        onDownload={NOOP}
      />,
    );
    expect(html).toMatch(/data-testid="file-viewer-action-error"[^>]*>That file is not on this desk\./);
  });
});

describe("in Indonesian", () => {
  it("draws the same screens from the id catalog", () => {
    applyLocale("id");
    const html = view({
      list: { status: "ready", items: [entry("catatan/rencana.md")] },
      viewer: viewerOn("tiga", [{ type: "pick", version: 1 }]),
    });
    expect(html).toContain("Berkas");
    expect(html).toContain("Unggah berkas teks");
    expect(html).toContain("Pulihkan versi ini");
    expect(html).toContain("Versi 3");
    expect(html).toContain("Agen di Riset");
    expect(html).toContain("Melihat versi 1 dari 3");
    expect(html).not.toContain("Restore this version");
    expect(html).not.toContain("Upload text file");
  });
});

describe("no English literals in the Files JSX", () => {
  it("has no text node in the components that is not a t() call", () => {
    const files = ["desk-files", "desk-files-view", "file-viewer", "files-list", "files-new-form"].map((name) =>
      source(`../components/files/${name}.tsx`),
    );
    for (const text of files) {
      // A JSX text child that starts with a capital letter and has a space is prose, not a symbol.
      expect(text).not.toMatch(/>\s*[A-Z][a-z]+(?: [A-Za-z]+)+\s*</);
    }
  });
});
