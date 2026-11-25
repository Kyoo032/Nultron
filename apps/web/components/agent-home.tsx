"use client";

import "./agent-harness.css";
import { ModeIcon } from "@/components/mode-icons";
import { skillLabel } from "@/lib/harness-copy";
import { t } from "@/lib/i18n";
import { type VirtualAgentInfo, virtualAgentTagline } from "@/lib/virtual-agents";

/** Skills shown as chips before the rest fold into "+N"; the harness panel lists them all. */
const MAX_SKILL_CHIPS = 6;

/**
 * The empty state of an agent's conversation. It says who the agent is, what its own harness does,
 * and that it does everything else as well (owner, 2026-10-09: every agent is a full chat). An agent
 * whose own harness still runs from its studio gets one quiet note with the way in; it is the caller
 * that knows (`onOpenStudio`), and without it no note is drawn.
 * The default agent keeps the Chat hero in the caller; this still draws sensibly for it.
 */
export function AgentHome({
  agent,
  name,
  onOpenStudio,
}: {
  agent: VirtualAgentInfo;
  name: string;
  onOpenStudio?: () => void;
}) {
  const offered = agent.skills.filter((skill) => skill.status !== "off");
  const shown = offered.slice(0, MAX_SKILL_CHIPS);
  const hidden = offered.length - shown.length;
  const offersStudio = !agent.generalist && typeof onOpenStudio === "function";

  return (
    <section className="agent-home" data-testid="agent-home" data-mode={agent.id}>
      <div className="agent-home-tile" aria-hidden="true">
        <ModeIcon name={agent.id} size={30} strokeWidth={1.75} />
      </div>
      <h1 className="agent-home-greeting">{t("agents.home.greeting", { name })}</h1>
      <p className="agent-home-tagline">{virtualAgentTagline(agent)}</p>
      {/* Only true of an agent whose own harness is a tool of this chat; the studio note says the rest. */}
      {agent.conversation === "harness" ? (
        <span className="agent-home-badge" data-testid="agent-home-badge">
          {t("agents.home.badge")}
        </span>
      ) : null}

      {shown.length > 0 ? (
        <div className="agent-home-skills">
          <h2 className="agent-home-skills-title">{t("agents.home.skills")}</h2>
          <ul className="agent-harness-chips agent-home-chips" data-testid="agent-home-skills">
            {shown.map((skill) => (
              <li key={skill.id} className="agent-harness-chip">
                {skillLabel(agent.id, skill)}
              </li>
            ))}
            {hidden > 0 ? <li className="agent-harness-chip agent-harness-chip-more">{`+${hidden}`}</li> : null}
          </ul>
        </div>
      ) : null}

      <p className="agent-home-everything" data-testid="agent-home-everything">
        {t("agents.home.everything")}
      </p>

      {offersStudio ? (
        <div className="agent-home-studio" data-testid="agent-home-studio">
          <h2 className="agent-home-studio-title">{t("agents.home.studioTitle", { name })}</h2>
          <p className="agent-home-studio-note">{t("agents.home.studioNote", { name })}</p>
          <button type="button" className="btn btn-secondary" onClick={onOpenStudio} data-testid="agent-open-studio">
            {t("agents.home.openStudio", { name })}
          </button>
        </div>
      ) : null}
    </section>
  );
}
