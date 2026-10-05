import { FolderProposalRow } from "@/components/folder/folder-proposal-row";
import type { Decision, FolderState } from "@/lib/folder-state";
import { t } from "@/lib/i18n";

type Props = {
  state: Pick<FolderState, "pending" | "decided" | "expanded" | "diffs" | "busy" | "rowErrors">;
  onToggle: (id: string) => void;
  onDecide: (id: string, decision: Decision) => void;
  onDismiss: (id: string) => void;
};

/**
 * The changes the agent proposed to the open folder, waiting for the owner. Nothing here has been
 * written: a row is a proposal until Approve, and Approve is the only thing that touches a file.
 *
 * Compact on purpose, because it sits between the conversation and the composer: the list scrolls
 * inside itself past 45% of the window instead of pushing the composer off the screen.
 */
export function FolderProposals({ state, onToggle, onDecide, onDismiss }: Props) {
  if (state.pending.length === 0 && state.decided.length === 0) {
    return null;
  }
  const shared = { onToggle, onDecide, onDismiss };
  const isOpen = (id: string) => state.expanded.includes(id);
  return (
    <section
      className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
      aria-labelledby="folder-proposals-title"
      data-testid="folder-proposals"
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 id="folder-proposals-title" className="text-sm font-semibold text-[var(--text)]">
          {t("folder.proposals.title")}
        </h2>
        {state.pending.length > 0 ? (
          <span
            className="rounded-pill bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--text)]"
            data-testid="folder-proposals-count"
          >
            {state.pending.length}
          </span>
        ) : null}
      </div>
      <ul className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto" aria-label={t("folder.proposals.list")}>
        {state.pending.map((proposal) => (
          <FolderProposalRow
            key={proposal.id}
            id={proposal.id}
            path={proposal.path}
            kind={proposal.kind}
            expanded={isOpen(proposal.id)}
            diff={state.diffs[proposal.id]}
            busy={state.busy[proposal.id]}
            errorCode={state.rowErrors[proposal.id]}
            {...shared}
          />
        ))}
        {state.decided.map((row) => (
          <FolderProposalRow
            key={row.id}
            id={row.id}
            path={row.path}
            kind={row.kind}
            outcome={row.outcome}
            expanded={isOpen(row.id)}
            diff={state.diffs[row.id]}
            {...shared}
          />
        ))}
      </ul>
    </section>
  );
}
