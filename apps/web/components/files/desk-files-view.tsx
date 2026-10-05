"use client";

import type { ChangeEvent, Ref } from "react";
import { formatBytes } from "@agentforge/core/format-bytes";
import { FILES_MAX_BYTES } from "@/lib/files-model";
import type { FilesListState, ViewerState } from "@/lib/files-state";
import { viewerPath } from "@/lib/files-state";
import { t } from "@/lib/i18n";
import { FileViewer } from "./file-viewer";
import { FilesList } from "./files-list";
import { FilesNewForm } from "./files-new-form";

export type DeskFilesBusy = "none" | "save" | "upload" | "restore" | "delete";

export type DeskFilesActions = {
  readonly onOpen: (path: string) => void;
  readonly onRetry: () => void;
  readonly onToggleForm: () => void;
  readonly onCloseForm: () => void;
  readonly onSave: (path: string, content: string) => void;
  readonly onUpload: (file: File) => void;
  readonly onCloseViewer: () => void;
  readonly onPick: (version: number) => void;
  readonly onAsk: (confirm: "restore" | "delete") => void;
  readonly onCancelConfirm: () => void;
  readonly onConfirmRestore: () => void;
  readonly onConfirmDelete: () => void;
};

export type DeskFilesViewProps = {
  readonly list: FilesListState;
  readonly viewer: ViewerState;
  readonly selfUserId: string | null;
  readonly formOpen: boolean;
  readonly busy: DeskFilesBusy;
  /** Success line for the last save, restore or delete, already in the owner's language. */
  readonly notice: string | null;
  /** The last failed save from the form, already in the owner's language. */
  readonly formError: string | null;
  /** The last refused upload, already in the owner's language. */
  readonly uploadError: string | null;
  /** The host's code for the last restore or delete that failed. */
  readonly actionErrorCode: string | null;
  readonly actions: DeskFilesActions;
  readonly viewerRef?: Ref<HTMLDivElement>;
};

const toolbarButton = "btn btn-secondary";

/**
 * The Files section, drawn from its state alone. `DeskFiles` owns the state and the calls; this is the
 * part a test can render. It sits inside the Knowledge Base's Sources tab and takes the same card
 * look as the "Add source" block beside it.
 */
export function DeskFilesView(props: DeskFilesViewProps) {
  const { list, viewer, busy, actions } = props;
  const total = list.status === "ready" ? list.items.length : null;
  const uploading = busy === "upload";
  const idle = busy === "none";

  function onPicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      actions.onUpload(file);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4" data-testid="files-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="panel-label">{t("files.title")}</h3>
            {total !== null && total > 0 ? (
              <span className="tag tag-neutral" data-testid="files-count">
                {total === 1 ? t("files.countOne") : t("files.count", { count: total })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--text-2)]">{t("files.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={toolbarButton}
            aria-expanded={props.formOpen}
            disabled={!idle && !props.formOpen}
            onClick={actions.onToggleForm}
            data-testid="files-new"
          >
            {t("files.new.open")}
          </button>
          <label
            className={`${toolbarButton} ${idle ? "cursor-pointer" : "cursor-not-allowed opacity-45"} focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--color-accent)]`}
            data-testid="files-upload"
          >
            {uploading ? t("files.new.saving") : t("files.upload.button")}
            <input
              className="sr-only"
              type="file"
              disabled={!idle}
              onChange={onPicked}
              data-testid="files-upload-input"
            />
          </label>
        </div>
      </div>
      <p className="mt-2 text-xs text-[var(--text-3)]">
        {t("files.upload.hint", { max: formatBytes(FILES_MAX_BYTES) })}
      </p>

      {props.notice ? (
        <p className="mt-3 text-sm text-[var(--text-2)]" role="status" data-testid="files-notice">
          {props.notice}
        </p>
      ) : null}
      {props.uploadError ? (
        <p className="mt-3 text-sm text-[var(--danger)]" role="alert" data-testid="files-upload-error">
          {props.uploadError}
        </p>
      ) : null}

      {props.formOpen ? (
        <FilesNewForm
          busy={busy === "save"}
          error={props.formError}
          onSave={actions.onSave}
          onCancel={actions.onCloseForm}
        />
      ) : null}

      <div className="mt-4">
        <FilesList state={list} selectedPath={viewerPath(viewer)} onOpen={actions.onOpen} onRetry={actions.onRetry} />
      </div>

      <div ref={props.viewerRef}>
        <FileViewer
          state={viewer}
          selfUserId={props.selfUserId}
          busy={busy === "restore" || busy === "delete"}
          actionErrorCode={props.actionErrorCode}
          onClose={actions.onCloseViewer}
          onPick={actions.onPick}
          onAsk={actions.onAsk}
          onCancelConfirm={actions.onCancelConfirm}
          onConfirmRestore={actions.onConfirmRestore}
          onConfirmDelete={actions.onConfirmDelete}
        />
      </div>
    </section>
  );
}
