import { t } from "@/lib/i18n";

type Props = {
  /** The open folder's name (never its path), or null when none is open. */
  name: string | null;
  mounted: boolean;
  /** The shell's folder dialog is open, or the host is taking the folder. */
  busy: boolean;
  /** Changes waiting for approval; closing the folder drops them, and the tooltip says so. */
  pendingCount: number;
  onOpen: () => void;
  onClose: () => void;
};

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

/**
 * "Open folder" before a folder is open, the folder's name and a close action after. The desk's
 * folder is where Chat may read files and propose changes; the owner picks it in the shell's own
 * dialog, and the path goes to the host once and is not shown again, only the last segment.
 */
export function FolderControl({ name, mounted, busy, pendingCount, onOpen, onClose }: Props) {
  const shown = name?.trim() ? name : t("folder.control.unnamed");
  return (
    <div
      className="flex min-w-0 flex-col"
      data-testid="folder-control"
      role="group"
      aria-label={t("folder.control.label")}
    >
      {mounted ? (
        <div
          className="inline-flex max-w-full items-center gap-2 self-start rounded-pill border border-[var(--line)] bg-[var(--surface)] py-1 pl-3 pr-1 text-sm text-[var(--text)]"
          data-testid="folder-chip"
        >
          <FolderIcon />
          <span className="min-w-0 max-w-[14rem] truncate" title={shown}>
            {shown}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-icon !h-6 !w-6 shrink-0 !rounded-pill"
            aria-label={t("folder.control.closeNamed", { name: shown })}
            title={pendingCount > 0 ? t("folder.control.closeWithPending", { name: shown }) : t("folder.control.close")}
            onClick={onClose}
            data-testid="folder-close"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary self-start !rounded-pill !py-1.5"
          disabled={busy}
          title={t("folder.control.openHint")}
          onClick={onOpen}
          data-testid="folder-open"
        >
          <FolderIcon />
          {t(busy ? "folder.control.opening" : "folder.control.open")}
        </button>
      )}
    </div>
  );
}
