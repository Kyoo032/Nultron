"use client";

import { formatBytes } from "@agentforge/core/format-bytes";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { createFilesApi } from "@/lib/files-api";
import { checkNewPath, FILES_MAX_BYTES, fileFromSearch, filesErrorKey, readUploadText } from "@/lib/files-model";
import {
  FILES_LIST_LOADING,
  VIEWER_CLOSED,
  loadFileList,
  loadFileViewer,
  restoreVersion,
  versionToFetch,
  viewerPath,
  viewerReducer,
  type FilesListState,
} from "@/lib/files-state";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import { DeskFilesView, type DeskFilesActions, type DeskFilesBusy } from "./desk-files-view";

/**
 * The Knowledge Base's Files section: the desk's files, a viewer with version history, and restore.
 *
 * It owns the state and every call; `DeskFilesView` draws it. `/knowledge?file=<path>` opens that file
 * on arrival (and again on a repeat visit to the same link), which is how a tool-result chip in Chat
 * lands on its file. The URL is only read, never written: closing the viewer leaves the address as it
 * was. The host decides everything that matters (limits, tenancy, what a path may be); this only asks.
 */
export function DeskFiles() {
  const { id: workspaceId } = useWorkspaceScope();
  const { identity } = useSession();
  const location = useLocation();
  const deepLink = fileFromSearch(location.search);
  const api = useMemo(() => createFilesApi(), []);

  const [list, setList] = useState<FilesListState>(FILES_LIST_LOADING);
  const [viewer, dispatch] = useReducer(viewerReducer, VIEWER_CLOSED);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<DeskFilesBusy>("none");
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null);

  const viewerRef = useRef<HTMLDivElement>(null);
  const deskRef = useRef<string | null>(null);
  const listSeq = useRef(0);
  const scrollToViewer = useRef(false);

  const refreshList = useCallback(async () => {
    listSeq.current += 1;
    const mine = listSeq.current;
    const next = await loadFileList(api);
    if (mine === listSeq.current) {
      setList(next);
    }
  }, [api]);

  // A switch from one desk to another leaves nothing of the old desk open. The desk id arrives a
  // moment after first paint (null, then the id): that is not a switch, so a file opened by a deep link
  // survives it, and the list is simply asked for again.
  useEffect(() => {
    const previous = deskRef.current;
    deskRef.current = workspaceId;
    if (previous !== null && previous !== workspaceId) {
      setList(FILES_LIST_LOADING);
      dispatch({ type: "close" });
      setFormOpen(false);
      setNotice(null);
      setFormError(null);
      setUploadError(null);
      setActionErrorCode(null);
    }
    void refreshList();
  }, [workspaceId, refreshList]);

  // The deep link.
  // `location.key` makes a second click on the same link open the file again after it was closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger, not a value read inside
  useEffect(() => {
    if (deepLink) {
      scrollToViewer.current = true;
      dispatch({ type: "open", path: deepLink });
    }
  }, [deepLink, location.key]);

  const path = viewerPath(viewer);
  const phase = viewer.phase;

  useEffect(() => {
    if (phase !== "loading" || path === null) {
      return;
    }
    let live = true;
    void loadFileViewer(api, path).then((result) => {
      if (live) {
        dispatch(
          result.ok
            ? { type: "loaded", path, head: result.head, versions: result.versions }
            : { type: "failed", path, code: result.code },
        );
      }
    });
    return () => {
      live = false;
    };
  }, [api, phase, path]);

  const needed = versionToFetch(viewer);
  useEffect(() => {
    if (needed === null || path === null) {
      return;
    }
    let live = true;
    void api.version(path, needed).then((outcome) => {
      if (live) {
        dispatch(
          outcome.ok
            ? { type: "versionLoaded", path, version: needed, read: outcome.data }
            : { type: "versionFailed", path, version: needed, code: outcome.code },
        );
      }
    });
    return () => {
      live = false;
    };
  }, [api, needed, path]);

  // A file opened from the list or a link brings the viewer into sight once it has something to show.
  useEffect(() => {
    if (scrollToViewer.current && (phase === "ready" || phase === "failed")) {
      scrollToViewer.current = false;
      viewerRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [phase]);

  /** Save text under a path, then open it. Returns the host's code when it refused. */
  async function persist(target: string, content: string, kind: "save" | "upload"): Promise<string | null> {
    setBusy(kind);
    const outcome = await api.save(target, content);
    setBusy("none");
    if (!outcome.ok) {
      return outcome.code;
    }
    setNotice(t("files.saved", { path: outcome.data.path, version: outcome.data.version }));
    scrollToViewer.current = true;
    dispatch({ type: "open", path: outcome.data.path });
    void refreshList();
    return null;
  }

  async function onSave(target: string, content: string) {
    if (busy !== "none") {
      return;
    }
    setFormError(null);
    setNotice(null);
    const code = await persist(target, content, "save");
    if (code) {
      setFormError(t(filesErrorKey(code)));
      return;
    }
    setFormOpen(false);
  }

  async function onUpload(file: File) {
    if (busy !== "none") {
      return;
    }
    setUploadError(null);
    setNotice(null);
    const read = await readUploadText(file);
    if (!read.ok) {
      const key = { too_large: "tooLarge", binary: "binary", read_failed: "readFailed" }[read.reason];
      setUploadError(t(`files.upload.${key}`, { name: file.name, max: formatBytes(FILES_MAX_BYTES) }));
      return;
    }
    const problem = checkNewPath(file.name);
    if (problem) {
      setUploadError(t(`files.pathErrors.${problem}`));
      return;
    }
    const code = await persist(file.name, read.text, "upload");
    if (code) {
      setUploadError(t(filesErrorKey(code)));
    }
  }

  async function onConfirmRestore() {
    if (busy !== "none") {
      return;
    }
    setBusy("restore");
    setActionErrorCode(null);
    const outcome = await restoreVersion(api, viewer);
    setBusy("none");
    if (!outcome.ok) {
      setActionErrorCode(outcome.code);
      dispatch({ type: "cancelConfirm" });
      return;
    }
    setNotice(t("files.restore.done", { from: outcome.data.from, to: outcome.data.saved.version }));
    // Reload the head and the history: the restore is the newest version now.
    dispatch({ type: "open", path: outcome.data.saved.path });
    void refreshList();
  }

  async function onConfirmDelete() {
    if (busy !== "none" || path === null) {
      return;
    }
    setBusy("delete");
    setActionErrorCode(null);
    const outcome = await api.remove(path);
    setBusy("none");
    if (!outcome.ok) {
      setActionErrorCode(outcome.code);
      dispatch({ type: "cancelConfirm" });
      return;
    }
    setNotice(t("files.delete.done", { path }));
    dispatch({ type: "close" });
    void refreshList();
  }

  const actions: DeskFilesActions = {
    onOpen: (target) => {
      setNotice(null);
      setActionErrorCode(null);
      scrollToViewer.current = true;
      dispatch({ type: "open", path: target });
    },
    onRetry: () => {
      setList(FILES_LIST_LOADING);
      void refreshList();
    },
    onToggleForm: () => {
      setFormError(null);
      setFormOpen((open) => !open);
    },
    onCloseForm: () => setFormOpen(false),
    onSave: (target, content) => void onSave(target, content),
    onUpload: (file) => void onUpload(file),
    onCloseViewer: () => {
      setActionErrorCode(null);
      dispatch({ type: "close" });
    },
    onPick: (version) => {
      setActionErrorCode(null);
      dispatch({ type: "pick", version });
    },
    onAsk: (confirm) => {
      setActionErrorCode(null);
      dispatch({ type: "ask", confirm });
    },
    onCancelConfirm: () => dispatch({ type: "cancelConfirm" }),
    onConfirmRestore: () => void onConfirmRestore(),
    onConfirmDelete: () => void onConfirmDelete(),
  };

  return (
    <DeskFilesView
      list={list}
      viewer={viewer}
      selfUserId={identity?.userId ?? null}
      formOpen={formOpen}
      busy={busy}
      notice={notice}
      formError={formError}
      uploadError={uploadError}
      actionErrorCode={actionErrorCode}
      actions={actions}
      viewerRef={viewerRef}
    />
  );
}
