import { t } from "@/lib/i18n";
import type { DocKind } from "@/lib/docs-client";
import { chosenSectionId, type AskAgent, type ProposalFailure } from "./doc-proposal-flow";
import { FailureNote } from "./doc-proposal-block";

export type AskDraft = {
  readonly agentId: string;
  readonly sectionId: string;
  readonly instruction: string;
};

export type AskSection = { readonly id: string; readonly heading: string | null };

type Props = {
  readonly kind: DocKind;
  readonly sections: readonly AskSection[];
  readonly agents: readonly AskAgent[];
  readonly draft: AskDraft;
  readonly working: boolean;
  readonly failure: ProposalFailure | null;
  readonly onDraft: (patch: Partial<AskDraft>) => void;
  readonly onSubmit: () => void;
};

function sectionLabel(section: AskSection, index: number): string {
  return section.heading ?? t("docpage.ask.sectionN", { n: index + 1 });
}

export function DocAskPanel({ kind, sections, agents, draft, working, failure, onDraft, onSubmit }: Props) {
  if (kind === "workbook") {
    return (
      <p className="doc-status" data-testid="docpage-ask-workbook">
        {t("docpage.ask.workbook")}
      </p>
    );
  }
  const sectionId = chosenSectionId(
    sections.map((section) => section.id),
    draft.sectionId,
  );
  const agentId = agents.some((agent) => agent.id === draft.agentId) ? draft.agentId : (agents[0]?.id ?? "");
  const canSend = !working && draft.instruction.trim() !== "" && sectionId !== "" && agentId !== "";
  return (
    <form
      className="doc-ask"
      data-testid="docpage-ask"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          onSubmit();
        }
      }}
    >
      {sections.length === 0 ? (
        <p className="doc-status" data-testid="docpage-ask-empty">
          {t("docpage.ask.noSections")}
        </p>
      ) : null}
      <textarea
        className="doc-ask-text"
        rows={3}
        value={draft.instruction}
        disabled={working || sections.length === 0}
        aria-label={t("docpage.ask.instruction")}
        placeholder={t("docpage.ask.placeholder")}
        onChange={(event) => onDraft({ instruction: event.target.value })}
        data-testid="docpage-ask-instruction"
      />
      <div className="doc-ask-row">
        <label className="doc-ask-field">
          <span className="doc-ask-label">{t("docpage.ask.agent")}</span>
          <select
            value={agentId}
            disabled={working}
            onChange={(event) => onDraft({ agentId: event.target.value })}
            data-testid="docpage-ask-agent"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="doc-ask-field">
          <span className="doc-ask-label">{t("docpage.ask.section")}</span>
          <select
            value={sectionId}
            disabled={working || sections.length === 0}
            onChange={(event) => onDraft({ sectionId: event.target.value })}
            data-testid="docpage-ask-section"
          >
            {sections.map((section, index) => (
              <option key={section.id} value={section.id}>
                {sectionLabel(section, index)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary" disabled={!canSend} data-testid="docpage-ask-send">
          {t("docpage.ask.send")}
        </button>
      </div>
      {working ? (
        <p className="doc-status" role="status" data-testid="docpage-ask-working">
          {t("docpage.ask.working")}
        </p>
      ) : null}
      {failure ? <FailureNote failure={failure} /> : null}
    </form>
  );
}
