import { FolderDiffView } from "@/components/folder/folder-diff-view";
import type { FolderErrorCode, ProposalKind } from "@/lib/folder-api";
import { folderErrorText, outcomeView } from "@/lib/folder-copy";
import type { Decision, DiffEntry, Outcome } from "@/lib/folder-state";
import { t } from "@/lib/i18n";

export type FolderProposalRowProps = {
  id: string;
  path: string;
  kind: ProposalKind;
  /** Set once the owner has decided; the row then shows this instead of the Approve and Reject buttons. */
  outcome?: Outcome;
  expanded: boolean;
  diff?: DiffEntry;
  /** The decision on its way to the host, if any. */
  busy?: Decision;
  /** Why the last decision did not go through. */
  errorCode?: FolderErrorCode;
  onToggle: (id: string) => void;
  onDecide: (id: string, decision: Decision) => void;
  onDismiss: (id: string) => void;
};

const TONE_CLASS = {
  good: "text-[var(--teal)]",
  warn: "text-[var(--danger)]",
  neutral: "text-[var(--text-2)]",
} as const;

function diffRegion(props: FolderProposalRowProps, regionId: string) {
  const { diff, outcome } = props;
  return (
    <div id={regionId} className="border-t border-[var(--line)] px-3 py-2" data-testid="folder-proposal-diff">
      {!diff || diff.phase === "loading" ? (
        <p className="text-xs text-[var(--text-3)]" role="status">
          {t("folder.diff.loading")}
        </p>
      ) : diff.phase === "failed" ? (
        <p className="text-xs text-[var(--danger)]" role="alert">
          {folderErrorText(diff.code)}
        </p>
      ) : (
        <FolderDiffView
          path={props.path}
          before={diff.diff.before}
          after={diff.diff.after}
          stale={diff.diff.stale}
          pending={outcome === undefined}
        />
      )}
    </div>
  );
}

/**
 * One change the agent proposed: what it does to which file, the diff on request, and either the
 * two buttons that decide it or the sentence saying how it was decided.
 */
export function FolderProposalRow(props: FolderProposalRowProps) {
  const { id, path, kind, outcome, expanded, busy, errorCode, onToggle, onDecide, onDismiss } = props;
  const regionId = `folder-diff-${id}`;
  const view = outcome ? outcomeView(outcome, kind) : null;
  // A decided row can show the diff the owner decided on, but only if it was ever loaded.
  const canToggle = outcome === undefined || props.diff?.phase === "ready";
  return (
    <li
      className="rounded-lg border border-[var(--line)] bg-[var(--surface)]"
      data-testid="folder-proposal"
      data-proposal-id={id}
      data-kind={kind}
      data-state={outcome ? "decided" : "pending"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 basis-full items-start gap-2 sm:flex-1 sm:basis-48">
          <span className="shrink-0 rounded-pill border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--text-2)]">
            {t(`folder.proposals.kind.${kind}`)}
          </span>
          <span className="mt-[3px] min-w-0 font-mono text-xs text-[var(--text)] [overflow-wrap:anywhere]" title={path}>
            {path}
          </span>
        </div>
        {canToggle ? (
          <button
            type="button"
            className="btn btn-ghost !px-2 !py-1.5"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => onToggle(id)}
            data-testid="folder-proposal-toggle"
          >
            {t(expanded ? "folder.proposals.hideDiff" : "folder.proposals.showDiff")}
          </button>
        ) : null}
        <div className="ml-auto flex items-center justify-end gap-2">
          {outcome ? (
            <button
              type="button"
              className="btn btn-secondary !py-1.5"
              aria-label={t("folder.proposals.dismissNamed", { path })}
              onClick={() => onDismiss(id)}
              data-testid="folder-proposal-dismiss"
            >
              {t("folder.proposals.dismiss")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary !py-1.5"
                disabled={busy !== undefined}
                aria-label={t("folder.proposals.rejectNamed", { path })}
                onClick={() => onDecide(id, "reject")}
                data-testid="folder-proposal-reject"
              >
                {t(busy === "reject" ? "folder.proposals.rejecting" : "folder.proposals.reject")}
              </button>
              <button
                type="button"
                className="btn btn-primary !py-1.5"
                disabled={busy !== undefined}
                aria-label={t("folder.proposals.approveNamed", { path })}
                onClick={() => onDecide(id, "approve")}
                data-testid="folder-proposal-approve"
              >
                {t(busy === "approve" ? "folder.proposals.approving" : "folder.proposals.approve")}
              </button>
            </>
          )}
        </div>
      </div>
      {errorCode ? (
        <p className="px-3 pb-2 text-xs text-[var(--danger)]" role="alert" data-testid="folder-proposal-error">
          {folderErrorText(errorCode)}
        </p>
      ) : null}
      {expanded ? diffRegion(props, regionId) : null}
      {view ? (
        <p
          className={`border-t border-[var(--line)] px-3 py-2 text-xs ${TONE_CLASS[view.tone]}`}
          role="status"
          data-testid="folder-proposal-outcome"
          data-outcome={outcome?.tag}
        >
          {view.text}
        </p>
      ) : null}
    </li>
  );
}
