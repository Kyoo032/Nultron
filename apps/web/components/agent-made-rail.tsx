"use client";

import { useState, type SyntheticEvent } from "react";
import { RailLink } from "@/components/agent-rail-parts";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";
import { madeAgentHref, type MadeAgent } from "@/lib/virtual-agents-made";

export const NEW_AGENT_PATH = "/agents/new";

type TipProps = {
  onTip: (label: string) => (event: SyntheticEvent<HTMLElement>) => void;
  onTipEnd: () => void;
};

export function MadeAgentRailRow({
  agent,
  active,
  collapsed,
  onRequestDelete,
  onTip,
  onTipEnd,
}: TipProps & {
  agent: MadeAgent;
  active: boolean;
  collapsed: boolean;
  onRequestDelete?: (agent: MadeAgent) => void;
}) {
  const [open, setOpen] = useState(false);
  const initial = agent.name.trim().charAt(0).toUpperCase() || "?";
  const showMore = agent.deletable && !collapsed && onRequestDelete !== undefined;

  return (
    <div
      className="agent-rail-made-row"
      data-testid={`made-agent-row-${agent.id}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      <RailLink
        href={madeAgentHref(agent.id)}
        label={agent.name}
        testId={`agent-made-${agent.id}`}
        mode="made"
        active={active}
        collapsed={collapsed}
        onTip={onTip}
        onTipEnd={onTipEnd}
      >
        <span className="agent-rail-tile agent-rail-made-tile" aria-hidden="true">
          {initial}
        </span>
      </RailLink>
      {showMore ? (
        <>
          <button
            type="button"
            className="agent-rail-made-more"
            data-testid={`made-agent-more-${agent.id}`}
            aria-label={t("agents.made.moreAria", { name: agent.name })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            ⋯
          </button>
          {open ? (
            <div className="agent-rail-made-menu" role="menu" data-testid={`made-agent-menu-${agent.id}`}>
              <button
                type="button"
                role="menuitem"
                className="agent-rail-made-menu-item"
                data-testid={`made-agent-delete-${agent.id}`}
                onClick={() => {
                  setOpen(false);
                  onRequestDelete?.(agent);
                }}
              >
                {t("agents.made.delete")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function NewAgentRailLink({ collapsed }: { collapsed: boolean }) {
  const label = t("agents.rail.newAgent");
  return (
    <Link
      href={NEW_AGENT_PATH}
      className="agent-rail-new-agent"
      aria-label={label}
      title={collapsed ? label : undefined}
      data-testid="rail-new-agent"
    >
      <span className="agent-rail-tile" aria-hidden="true">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      {collapsed ? null : <span className="agent-rail-label">{label}</span>}
    </Link>
  );
}
