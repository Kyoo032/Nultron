"use client";

import "./agent-harness.css";
import { callsLine, loopLine, repairLine, skillLabel, stepsLine, toolLabel } from "@/lib/harness-copy";
import { t } from "@/lib/i18n";
import type { VirtualAgentInfo } from "@/lib/virtual-agents";

/**
 * What an agent is made of, as a panel beside its conversation. It is in two parts, because they are
 * true in different ways:
 *
 * - **In this chat**: the tools the agent may call and its limits. The host enforces these on every
 *   run of the conversation, and that sentence sits on this part only.
 * - **Its own harness**: how the agent's specialty works, its skills and its checks, with where that
 *   harness runs. For an agent whose harness is a tool of the chat that is here; for the rest it is
 *   the agent's studio, and the panel says the chat does that work without those checks. Listing a
 *   studio's skills and checks under "enforced on every run" would claim a run that does not happen.
 *
 * The host decides all of it; this only says it. Escape and placement belong to the caller.
 */
export function AgentHarnessPanel({
  agent,
  name,
  onClose,
  onOpenStudio,
  detailsRef,
}: {
  agent: VirtualAgentInfo;
  name: string;
  onClose: () => void;
  /**
   * The way into the agent's studio, for an agent whose own harness runs there. The empty
   * conversation offers it too, but that is gone after the first message; this stays.
   */
  onOpenStudio?: () => void;
  detailsRef?: (node: HTMLDivElement | null) => void;
}) {
  const title = t("harness.panel.title", { name });
  const ownRunsHere = agent.conversation === "harness";
  return (
    <aside
      className="agent-harness-panel"
      data-testid="agent-harness-panel"
      data-mode={agent.id}
      role="complementary"
      aria-label={title}
    >
      <header className="agent-harness-head">
        <h2 className="agent-harness-title">{title}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon agent-harness-close"
          onClick={onClose}
          aria-label={t("harness.panel.close")}
          title={t("harness.panel.close")}
          data-testid="agent-harness-close"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="agent-harness-body">
        {detailsRef ? <div ref={detailsRef} className="agent-harness-details-slot" /> : null}
        <div className="agent-harness-part" data-testid="agent-harness-in-chat">
          <h3 className="agent-harness-part-title">{t("harness.panel.inChat")}</h3>

          <section className="agent-harness-section" aria-labelledby="agent-harness-tools">
            <h4 className="agent-harness-heading" id="agent-harness-tools">
              {t("harness.panel.tools")}
            </h4>
            {agent.tools.length === 0 ? (
              <p className="agent-harness-note" data-testid="agent-harness-no-tools">
                {t("harness.panel.noTools")}
              </p>
            ) : (
              <ul className="agent-harness-chips" data-testid="agent-harness-tools">
                {agent.tools.map((key) => (
                  <li key={key} className="agent-harness-chip" data-tool={key}>
                    {toolLabel(key)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* A step and call budget bounds a tool loop. An agent that binds no tools has none to bound. */}
          {agent.tools.length > 0 ? (
            <section className="agent-harness-section" aria-labelledby="agent-harness-limits">
              <h4 className="agent-harness-heading" id="agent-harness-limits">
                {t("harness.panel.limits")}
              </h4>
              <ul className="agent-harness-facts" data-testid="agent-harness-limits">
                <li>{stepsLine(agent.budget.maxSteps)}</li>
                <li>{callsLine(agent.budget.maxToolCalls)}</li>
              </ul>
            </section>
          ) : null}

          <p className="agent-harness-enforced" data-testid="agent-harness-enforced">
            {t("harness.panel.enforced")}
          </p>
        </div>

        <div className="agent-harness-part" data-testid="agent-harness-own" data-runs={ownRunsHere ? "chat" : "studio"}>
          <h3 className="agent-harness-part-title">{t("harness.panel.ownHarness", { name })}</h3>
          <p className="agent-harness-where" data-testid="agent-harness-where">
            {ownRunsHere ? t("harness.panel.runsInChat") : t("harness.panel.runsInStudio", { name })}
          </p>
          {!ownRunsHere && onOpenStudio ? (
            <button
              type="button"
              className="btn btn-secondary agent-harness-open-studio"
              onClick={onOpenStudio}
              data-testid="agent-harness-open-studio"
            >
              {t("agents.home.openStudio", { name })}
            </button>
          ) : null}
          <p className="agent-harness-loop" data-testid="agent-harness-loop">
            {loopLine(agent.loop)}
          </p>

          <section className="agent-harness-section" aria-labelledby="agent-harness-skills">
            <h4 className="agent-harness-heading" id="agent-harness-skills">
              {t("harness.panel.skills")}
            </h4>
            <ul className="agent-harness-list" data-testid="agent-harness-skills">
              {agent.skills.map((skill) => (
                <li key={skill.id} className="agent-harness-skill" data-status={skill.status}>
                  <span className="agent-harness-skill-name">{skillLabel(agent.id, skill)}</span>
                  {skill.status === "new" ? (
                    <span className="agent-harness-mark">{t("harness.panel.statusNew")}</span>
                  ) : null}
                  {skill.status === "off" ? (
                    <span className="agent-harness-mark agent-harness-mark-off">{t("harness.panel.statusOff")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="agent-harness-section" aria-labelledby="agent-harness-checks">
            <h4 className="agent-harness-heading" id="agent-harness-checks">
              {t("harness.panel.checks")}
            </h4>
            <p className="agent-harness-note" data-testid="agent-harness-checks">
              {repairLine(agent.repairRounds)}
            </p>
          </section>
        </div>
      </div>
    </aside>
  );
}
