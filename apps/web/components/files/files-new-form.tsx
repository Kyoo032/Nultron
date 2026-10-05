"use client";

import { useId, useState, type FormEvent } from "react";
import { formatBytes } from "@agentforge/core/format-bytes";
import { checkNewPath, FILES_MAX_BYTES, utf8Bytes } from "@/lib/files-model";
import { t } from "@/lib/i18n";

type Props = {
  /** A save is in flight: nothing in the form may be pressed. */
  readonly busy: boolean;
  /** The message for the last save that failed, already in the owner's language. */
  readonly error: string | null;
  readonly onSave: (path: string, content: string) => void;
  readonly onCancel: () => void;
};

/**
 * Path and text for a file made by hand. The path is checked for the common slips before anything is
 * sent; the host stays the authority and a refusal comes back as `error`. A save of an existing path
 * is not a mistake: it becomes the next version.
 */
export function FilesNewForm({ busy, error, onSave, onCancel }: Props) {
  const base = useId();
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const pathProblem = checkNewPath(path);
    if (pathProblem) {
      setProblem(t(`files.pathErrors.${pathProblem}`));
      return;
    }
    if (utf8Bytes(content) > FILES_MAX_BYTES) {
      setProblem(t("files.upload.tooLarge", { name: path.trim(), max: formatBytes(FILES_MAX_BYTES) }));
      return;
    }
    setProblem(null);
    onSave(path.trim(), content);
  }

  const shown = problem ?? error;

  return (
    <form
      className="mt-4 space-y-3 rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3"
      aria-label={t("files.new.formAria")}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
      data-testid="files-new-form"
    >
      <div className="space-y-1">
        <label htmlFor={`${base}-path`} className="block text-sm font-medium text-[var(--text)]">
          {t("files.new.pathLabel")}
        </label>
        <input
          id={`${base}-path`}
          className="input"
          value={path}
          placeholder={t("files.new.pathPlaceholder")}
          onChange={(event) => setPath(event.target.value)}
          aria-describedby={`${base}-hint`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
          data-testid="files-new-path"
        />
        <p id={`${base}-hint`} className="text-xs text-[var(--text-2)]">
          {t("files.new.pathHint")}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${base}-content`} className="block text-sm font-medium text-[var(--text)]">
          {t("files.new.contentLabel")}
        </label>
        <textarea
          id={`${base}-content`}
          className="input font-mono text-xs leading-5"
          rows={8}
          value={content}
          placeholder={t("files.new.contentPlaceholder")}
          onChange={(event) => setContent(event.target.value)}
          spellCheck={false}
          disabled={busy}
          data-testid="files-new-content"
        />
      </div>
      {shown ? (
        <p className="text-sm text-[var(--danger)]" role="alert" data-testid="files-new-error">
          {shown}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy} data-testid="files-new-save">
          {busy ? t("files.new.saving") : t("files.new.save")}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={onCancel}
          data-testid="files-new-cancel"
        >
          {t("files.new.cancel")}
        </button>
      </div>
    </form>
  );
}
