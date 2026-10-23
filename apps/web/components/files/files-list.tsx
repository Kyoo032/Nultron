"use client";

import { baseName, bytesLabel, filesErrorKey, formatWhen, groupByFolder } from "@/lib/files-model";
import type { FilesListState } from "@/lib/files-state";
import { t } from "@/lib/i18n";

type Props = {
  readonly state: FilesListState;
  /** The file open in the viewer, so its row reads as selected. */
  readonly selectedPath: string | null;
  readonly onOpen: (path: string) => void;
  readonly onRetry: () => void;
};

const rowClass =
  "flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] data-[on=true]:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:[outline-offset:-2px]";

/** The desk's files grouped by folder, or the one line that says why there is no list. */
export function FilesList({ state, selectedPath, onOpen, onRetry }: Props) {
  if (state.status === "loading") {
    return (
      <p className="text-sm text-[var(--text-2)]" role="status" data-testid="files-loading">
        {t("files.list.loading")}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="files-load-error">
        <p className="text-sm text-[var(--danger)]" role="alert">
          {t(filesErrorKey(state.code))}
        </p>
        <button type="button" className="btn btn-secondary text-xs" onClick={onRetry} data-testid="files-retry">
          {t("files.list.retry")}
        </button>
      </div>
    );
  }
  const groups = groupByFolder(state.items);
  if (groups.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed border-[var(--line)] px-4 py-6 text-center"
        data-testid="files-empty"
      >
        <p className="text-sm font-medium text-[var(--text)]">{t("files.empty.title")}</p>
        <p className="mx-auto mt-1 max-w-[40ch] text-xs text-[var(--text-2)]">{t("files.empty.body")}</p>
      </div>
    );
  }
  return (
    <div
      className="max-h-72 overflow-y-auto rounded-lg border border-[var(--line)]"
      role="region"
      aria-label={t("files.list.aria")}
      tabIndex={0}
      data-testid="files-list"
    >
      {groups.map((group) => (
        <section key={group.folder === "" ? "." : group.folder}>
          <h4
            className="sticky top-0 z-[1] break-words border-b border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text-2)] [overflow-wrap:anywhere]"
            data-testid="files-folder"
            data-folder={group.folder}
          >
            {group.folder === "" ? t("files.list.topLevel") : `${group.folder}/`}
          </h4>
          <ul className="divide-y divide-[var(--line)]">
            {group.items.map((item) => (
              <li key={item.path}>
                <button
                  type="button"
                  className={rowClass}
                  title={item.path}
                  aria-label={t("files.list.open", { path: item.path })}
                  aria-current={item.path === selectedPath ? "true" : undefined}
                  data-on={item.path === selectedPath ? "true" : "false"}
                  data-testid="files-item"
                  data-path={item.path}
                  onClick={() => onOpen(item.path)}
                >
                  <span className="min-w-0 flex-1 basis-40 break-words text-sm font-medium text-[var(--text)] [overflow-wrap:anywhere]">
                    {baseName(item.path)}
                  </span>
                  <span className="text-xs text-[var(--text-2)]">{bytesLabel(item.bytes)}</span>
                  {item.version !== null ? (
                    <span className="text-xs text-[var(--text-2)]">
                      {t("files.list.version", { version: item.version })}
                    </span>
                  ) : null}
                  {item.updatedAt > 0 ? (
                    <span className="text-xs text-[var(--text-2)]">
                      {t("files.list.updated", { when: formatWhen(item.updatedAt) })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
