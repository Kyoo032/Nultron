"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { authorOf, bytesLabel, filesErrorKey, formatWhen, numberLines, type FileVersion } from "@/lib/files-model";
import { isViewingLatest, latestVersion, shownText, type Confirm, type ViewerState } from "@/lib/files-state";
import { t } from "@/lib/i18n";
import { labeled } from "@/lib/ui-copy";

export type FileViewerProps = {
  readonly state: ViewerState;
  /** The signed-in person on the hosted app, null on Personal. Decides "You" against "A teammate". */
  readonly selfUserId: string | null;
  /** A restore or a delete is in flight: nothing in the viewer may be pressed. */
  readonly busy: boolean;
  /** The newest version is being fetched to save: Download waits for it. */
  readonly downloading: boolean;
  /** The host's code for the last restore, delete or download that failed. */
  readonly actionErrorCode: string | null;
  readonly onClose: () => void;
  readonly onDownload: () => void;
  readonly onPick: (version: number) => void;
  readonly onAsk: (confirm: "restore" | "delete") => void;
  readonly onCancelConfirm: () => void;
  readonly onConfirmRestore: () => void;
  readonly onConfirmDelete: () => void;
};

const dangerButtonClass =
  "inline-flex items-center justify-center rounded-md bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-[var(--surface)] shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40";

/** Who saved a version, in words. */
export function authorLabel(version: FileVersion, selfUserId: string | null): string {
  const author = authorOf(version, selfUserId);
  if (author.who === "agent") {
    return author.mode
      ? t("files.author.agentIn", { mode: labeled(`rail.${author.mode}`, author.mode) })
      : t("files.author.agent");
  }
  return t(author.who === "you" ? "files.author.you" : "files.author.teammate");
}

type ConfirmProps = {
  readonly testId: string;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly danger: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
};

/** Restore and Delete both ask first. An alert dialog that is not modal: Escape or Cancel closes it. */
export function ConfirmPanel({ testId, title, body, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmProps) {
  const base = useId();
  const titleId = `${base}-title`;
  const bodyId = `${base}-body`;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={`space-y-3 rounded-md border p-3 ${danger ? "border-[var(--danger)] bg-[var(--danger)]/5" : "border-[var(--line)] bg-[var(--bg)]"}`}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <h5
        id={titleId}
        className={`break-words text-sm font-semibold [overflow-wrap:anywhere] ${danger ? "text-[var(--danger)]" : "text-[var(--text)]"}`}
      >
        {title}
      </h5>
      <p id={bodyId} className="text-xs text-[var(--text-2)]">
        {body}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={danger ? dangerButtonClass : "btn btn-primary"}
          disabled={busy}
          onClick={onConfirm}
          data-testid={`${testId}-yes`}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={onCancel}
          data-testid={`${testId}-cancel`}
          // The safe choice has the focus when the question opens.
          autoFocus
        >
          {t("files.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The text, one row per line, as text only: the content is never parsed as HTML or Markdown. */
export function NumberedText({ text, path }: { readonly text: string; readonly path: string }) {
  const { lines, total, truncated } = numberLines(text);
  if (total === 0) {
    return (
      <p
        className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-3 py-4 text-sm text-[var(--text-2)]"
        data-testid="file-viewer-empty"
      >
        {t("files.viewer.empty")}
      </p>
    );
  }
  const numbers = lines.map((_, index) => index + 1).join("\n");
  return (
    <div>
      <div
        role="region"
        aria-label={t("files.viewer.textAria", { path })}
        tabIndex={0}
        className="max-h-[28rem] overflow-auto rounded-md border border-[var(--line)] bg-[var(--bg)] font-mono text-xs leading-5"
        data-testid="file-viewer-text"
      >
        <div className="flex min-w-max">
          <pre
            aria-hidden="true"
            className="sticky left-0 shrink-0 select-none border-r border-[var(--line)] bg-[var(--bg)] px-2 py-2 text-right text-[var(--text-3)]"
            data-testid="file-viewer-numbers"
          >
            {numbers}
          </pre>
          <pre className="px-3 py-2 text-[var(--text)]" data-testid="file-viewer-lines">
            {lines.join("\n")}
          </pre>
        </div>
      </div>
      {truncated ? (
        <p className="mt-1 text-xs text-[var(--text-2)]" data-testid="file-viewer-truncated">
          {t("files.viewer.truncated", { shown: lines.length.toLocaleString(), total: total.toLocaleString() })}
        </p>
      ) : null}
    </div>
  );
}

function VersionList({
  versions,
  viewing,
  selfUserId,
  disabled,
  onPick,
}: {
  readonly versions: readonly FileVersion[];
  readonly viewing: number;
  readonly selfUserId: string | null;
  readonly disabled: boolean;
  readonly onPick: (version: number) => void;
}) {
  const newest = latestVersion(versions);
  return (
    <div data-testid="file-versions">
      <h5 className="panel-label">{t("files.versions.title")}</h5>
      <ul
        className="mt-2 max-h-[28rem] divide-y divide-[var(--line)] overflow-y-auto rounded-md border border-[var(--line)]"
        aria-label={t("files.versions.aria")}
      >
        {[...versions]
          .sort((a, b) => b.version - a.version)
          .map((entry) => (
            <li key={entry.version}>
              <button
                type="button"
                disabled={disabled}
                aria-current={entry.version === viewing ? "true" : undefined}
                data-on={entry.version === viewing ? "true" : "false"}
                data-testid="file-version"
                data-version={entry.version}
                className="block w-full px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] disabled:opacity-60 data-[on=true]:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:[outline-offset:-2px]"
                onClick={() => onPick(entry.version)}
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-[var(--text)]">
                    {t("files.versions.version", { version: entry.version })}
                  </span>
                  {entry.version === newest ? (
                    <span className="tag tag-accent">{t("files.versions.latest")}</span>
                  ) : null}
                </span>
                <span className="block text-xs text-[var(--text-2)]">{authorLabel(entry, selfUserId)}</span>
                <span className="block text-xs text-[var(--text-2)]">
                  {[formatWhen(entry.createdAt), bytesLabel(entry.bytes)].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * The open file: its text in a numbered, scrollable, monospace pane; its history; and Restore and
 * Delete behind a question. A pure function of its props, so it renders in a test.
 */
export function FileViewer(props: FileViewerProps) {
  const { state, selfUserId, busy, actionErrorCode } = props;
  const restoreRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const lastConfirm = useRef<Confirm>("none");
  const confirm = state.phase === "ready" ? state.confirm : "none";

  // Focus goes back to the button that asked once the question is answered or cancelled.
  useEffect(() => {
    const previous = lastConfirm.current;
    lastConfirm.current = confirm;
    if (confirm === "none" && previous === "restore") {
      restoreRef.current?.focus();
    } else if (confirm === "none" && previous === "delete") {
      deleteRef.current?.focus();
    }
  }, [confirm]);

  if (state.phase === "closed") {
    return null;
  }

  const closeButton = (
    <button type="button" className="btn btn-secondary" onClick={props.onClose} data-testid="file-viewer-close">
      {t("files.viewer.close")}
    </button>
  );

  const header = (actions: ReactNode, meta?: string) => (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-3 py-3">
      <div className="min-w-0 flex-1 basis-48">
        <h4
          className="break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
          data-testid="file-viewer-path"
        >
          {state.path}
        </h4>
        {meta ? <p className="mt-0.5 text-xs text-[var(--text-2)]">{meta}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </header>
  );

  const shell = (children: ReactNode) => (
    <section
      className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface)]"
      aria-label={t("files.viewer.aria")}
      data-testid="file-viewer"
      data-path={state.path}
      data-phase={state.phase}
    >
      {children}
    </section>
  );

  if (state.phase === "loading") {
    return shell(
      <>
        {header(closeButton)}
        <p className="px-3 py-4 text-sm text-[var(--text-2)]" role="status" data-testid="file-viewer-loading">
          {t("files.viewer.loading")}
        </p>
      </>,
    );
  }

  if (state.phase === "failed") {
    return shell(
      <>
        {header(closeButton)}
        <p className="px-3 py-4 text-sm text-[var(--danger)]" role="alert" data-testid="file-viewer-error">
          {state.code === "not_found" ? t("files.viewer.missing") : t(filesErrorKey(state.code))}
        </p>
      </>,
    );
  }

  const latest = isViewingLatest(state);
  const read = shownText(state);
  const meta = [
    latest ? t("files.viewer.latest") : t("files.viewer.oldVersion", { version: state.viewing }),
    read ? bytesLabel(read.bytes) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = (
    <>
      {latest ? null : (
        <button
          ref={restoreRef}
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => props.onAsk("restore")}
          aria-expanded={confirm === "restore"}
          data-testid="file-restore"
        >
          {t("files.restore.button")}
        </button>
      )}
      {latest ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || props.downloading}
          onClick={props.onDownload}
          aria-label={t("files.download.aria", { path: state.path })}
          data-testid="file-download"
        >
          {props.downloading ? t("files.download.working") : t("files.download.button")}
        </button>
      ) : null}
      <button
        ref={deleteRef}
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() => props.onAsk("delete")}
        aria-expanded={confirm === "delete"}
        data-testid="file-delete"
      >
        {t("files.delete.button")}
      </button>
      {closeButton}
    </>
  );

  return shell(
    <>
      {header(actions, meta)}
      <div className="space-y-3 p-3">
        {confirm === "restore" ? (
          <ConfirmPanel
            testId="file-restore-confirm"
            title={t("files.restore.title", { version: state.viewing })}
            body={t("files.restore.body", { version: state.viewing })}
            confirmLabel={busy ? t("files.restore.working") : t("files.restore.confirm")}
            danger={false}
            busy={busy}
            onConfirm={props.onConfirmRestore}
            onCancel={props.onCancelConfirm}
          />
        ) : null}
        {confirm === "delete" ? (
          <ConfirmPanel
            testId="file-delete-confirm"
            title={t("files.delete.title", { path: state.path })}
            body={t("files.delete.body")}
            confirmLabel={busy ? t("files.delete.working") : t("files.delete.confirm")}
            danger
            busy={busy}
            onConfirm={props.onConfirmDelete}
            onCancel={props.onCancelConfirm}
          />
        ) : null}
        {actionErrorCode ? (
          <p className="text-sm text-[var(--danger)]" role="alert" data-testid="file-viewer-action-error">
            {t(filesErrorKey(actionErrorCode))}
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0 space-y-2">
            <p className="text-xs text-[var(--text-2)]" data-testid="file-viewer-which">
              {t("files.viewer.viewing", { version: state.viewing, total: latestVersion(state.versions) })}
            </p>
            {read ? (
              <NumberedText text={read.text} path={state.path} />
            ) : state.textError ? (
              <p className="text-sm text-[var(--danger)]" role="alert" data-testid="file-viewer-text-error">
                {t(filesErrorKey(state.textError))}
              </p>
            ) : (
              <p className="text-sm text-[var(--text-2)]" role="status" data-testid="file-viewer-version-loading">
                {t("files.viewer.versionLoading", { version: state.viewing })}
              </p>
            )}
          </div>
          <VersionList
            versions={state.versions}
            viewing={state.viewing}
            selfUserId={selfUserId}
            disabled={busy}
            onPick={props.onPick}
          />
        </div>
      </div>
    </>,
  );
}
