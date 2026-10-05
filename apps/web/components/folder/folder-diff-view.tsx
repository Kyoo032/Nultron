import { useMemo } from "react";
import { DIFF_MAX_LINES, diffLines, foldUnchanged, type DiffRow } from "@/lib/folder-diff";
import { t } from "@/lib/i18n";

type Props = {
  /** The path, for the scroll region's name. */
  path: string;
  before: string;
  after: string;
  /** True when the file is no longer the one the proposal was made against. */
  stale: boolean;
  /** Only a change still waiting for a decision can be stale in a way that matters. */
  pending: boolean;
};

const ROW_BASE = "flex gap-2 px-2 [overflow-wrap:anywhere] whitespace-pre-wrap";

/**
 * Tints, not text colours: the text stays `--text` on every row, so contrast is the desk's own in
 * both themes. The marker character and the screen-reader word carry the meaning; the tint is
 * only a second cue.
 */
const ROW_CLASS: Record<"add" | "remove" | "same", string> = {
  add: `${ROW_BASE} bg-[color-mix(in_srgb,var(--teal)_16%,var(--surface))] text-[var(--text)]`,
  remove: `${ROW_BASE} bg-[color-mix(in_srgb,var(--danger)_13%,var(--surface))] text-[var(--text)]`,
  same: `${ROW_BASE} text-[var(--text-2)]`,
};

const MARKER: Record<"add" | "remove" | "same", string> = { add: "+", remove: "-", same: " " };

function rowLabel(kind: "add" | "remove"): string {
  return t(kind === "add" ? "folder.diff.added" : "folder.diff.removed");
}

function DiffLineRow({ row }: { row: DiffRow }) {
  if (row.kind === "gap") {
    return (
      <div className="px-2 py-0.5 text-center text-[var(--text-3)]" data-kind="gap">
        {t("folder.diff.gap", { count: row.count })}
      </div>
    );
  }
  return (
    <div className={ROW_CLASS[row.kind]} data-kind={row.kind}>
      <span className="w-3 shrink-0 select-none" aria-hidden="true">
        {MARKER[row.kind]}
      </span>
      {row.kind === "same" ? null : <span className="sr-only">{rowLabel(row.kind)}: </span>}
      <span className="min-w-0 flex-1">{row.text === "" ? "​" : row.text}</span>
    </div>
  );
}

/**
 * A line diff of one proposal: the file as it is now against the file as it would become, long
 * unchanged runs folded away, capped at `DIFF_MAX_LINES` a side with a sentence when it bites.
 */
export function FolderDiffView({ path, before, after, stale, pending }: Props) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  const rows = useMemo(() => foldUnchanged(diff.lines), [diff]);
  const textUnchanged = diff.added + diff.removed === 0;
  return (
    <div className="flex flex-col gap-2">
      {pending && stale ? (
        <p className="text-xs text-[var(--danger)]" role="note" data-testid="folder-proposal-stale">
          {t("folder.diff.staleNow")}
        </p>
      ) : null}
      {diff.truncated ? (
        <p className="text-xs text-[var(--text-3)]" data-testid="folder-proposal-truncated">
          {t("folder.diff.truncated", { max: DIFF_MAX_LINES })}
        </p>
      ) : null}
      {diff.changed && textUnchanged && !diff.truncated ? (
        <p className="text-xs text-[var(--text-3)]">{t("folder.diff.noTextChange")}</p>
      ) : null}
      {rows.length > 0 && (!textUnchanged || diff.truncated) ? (
        <div
          className="max-h-[min(16rem,30vh)] overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface)] py-1 font-mono text-xs leading-5"
          // A scrolling box has to be reachable by keyboard.
          tabIndex={0}
          role="region"
          aria-label={path}
          data-testid="folder-proposal-lines"
        >
          {rows.map((row, index) => (
            // The rows are a derived, never-reordered list; position is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: derived rows have no id and are not reordered
            <DiffLineRow key={index} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
