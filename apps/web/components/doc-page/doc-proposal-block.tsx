import { Link } from "@/lib/nav";
import { t } from "@/lib/i18n";
import type { DocProposal, DocSection } from "@/lib/docs-client";
import { diffSections, type DiffSegment } from "@/lib/doc-word-diff";
import { initialsOf, personLabel, type DocPeople } from "./doc-format";
import type { ProposalFailure } from "./doc-proposal-flow";

export type ProposalAction = "keep" | "undo" | "retry";

type Props = {
  readonly proposal: DocProposal;
  readonly current: DocSection;
  readonly agentName: string;
  readonly people: DocPeople;
  readonly busy: ProposalAction | null;
  readonly failure: ProposalFailure | null;
  readonly onKeep: () => void;
  readonly onUndo: () => void;
  readonly onRetry: () => void;
};

export function failureText(failure: ProposalFailure): string {
  switch (failure) {
    case "gateway_blocked":
      return t("docpage.ask.gatewayBlocked");
    case "agent_not_in_workspace":
      return t("docpage.ask.agentNotInWorkspace");
    case "section_changed":
      return t("docpage.proposal.sectionChanged");
    case "gone":
      return t("docpage.proposal.gone");
    case "conflict":
      return t("docpage.versions.restoreConflict");
    case "failed":
      return t("docpage.proposal.failed");
  }
}

export function FailureNote({ failure }: { readonly failure: ProposalFailure }) {
  return (
    <p className="doc-error" role="alert" data-testid="docpage-failure" data-reason={failure}>
      {failureText(failure)}
      {failure === "gateway_blocked" ? (
        <>
          {" "}
          <Link to="/settings" className="doc-settings-link" data-testid="docpage-settings-link">
            {t("docpage.ask.openSettings")}
          </Link>
        </>
      ) : null}
    </p>
  );
}

function DiffPiece({ segment }: { readonly segment: DiffSegment }) {
  if (segment.kind === "removed") {
    return <del className="doc-diff-removed">{segment.text}</del>;
  }
  if (segment.kind === "added") {
    return <ins className="doc-diff-added">{segment.text}</ins>;
  }
  return <span>{segment.text}</span>;
}

function labelFor(action: ProposalAction, busy: ProposalAction | null): string {
  if (busy === action) {
    return t("docpage.proposal.working");
  }
  if (action === "keep") {
    return t("docpage.proposal.keep");
  }
  if (action === "undo") {
    return t("docpage.proposal.undo");
  }
  return t("docpage.proposal.retry");
}

export function ProposalBlock({ proposal, current, agentName, people, busy, failure, onKeep, onUndo, onRetry }: Props) {
  const segments = diffSections(current, proposal.section);
  const asker = personLabel(people, proposal.askedByUserId);
  return (
    <div
      className="doc-proposal"
      data-testid="docpage-proposal"
      data-proposal-id={proposal.id}
      data-section-id={proposal.sectionId}
    >
      <p className="doc-proposal-head">
        <span className="doc-proposal-mark" aria-hidden="true">
          {initialsOf(agentName)}
        </span>
        <span>{t("docpage.proposal.header", { agent: agentName, name: asker })}</span>
      </p>
      <p className="doc-proposal-text" data-testid="docpage-proposal-text">
        {segments.map((segment, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff segments have no id and are rendered once per proposal snapshot
          <DiffPiece key={index} segment={segment} />
        ))}
      </p>
      {failure ? <FailureNote failure={failure} /> : null}
      <div className="doc-proposal-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={onKeep}
          data-testid="docpage-proposal-keep"
        >
          {labelFor("keep", busy)}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy !== null}
          onClick={onUndo}
          data-testid="docpage-proposal-undo"
        >
          {labelFor("undo", busy)}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy !== null}
          onClick={onRetry}
          data-testid="docpage-proposal-retry"
        >
          {labelFor("retry", busy)}
        </button>
      </div>
    </div>
  );
}
