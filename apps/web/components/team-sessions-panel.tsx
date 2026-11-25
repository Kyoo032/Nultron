"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";
import { isTeamBotParam, teamBotHref } from "@/lib/team";
import { virtualAgentHref } from "@/lib/virtual-agents";
import type { DelegatedSessionInfo, DelegatedSessionStatus } from "@/lib/team-sessions";
import type { ProductMode } from "@agentforge/core/product-modes";

function statusBadgeClass(status: DelegatedSessionStatus): string {
  switch (status) {
    case "running":
      return "bg-[var(--accent)]/15 text-[var(--accent)]";
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    default:
      return "bg-[var(--danger)]/15 text-[var(--danger)]";
  }
}

function sessionHref(session: DelegatedSessionInfo): string {
  if (session.agentKind === "bot" || isTeamBotParam(session.agentKey)) {
    return teamBotHref(session.agentKey, session.childThreadId);
  }
  return virtualAgentHref(session.agentKey as ProductMode, session.childThreadId);
}

export function TeamSessionsToggle({
  count,
  activeCount,
  open,
  onToggle,
}: {
  count: number;
  activeCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  const label = t("agents.teamSessions.toggle");
  return (
    <button
      type="button"
      className="agent-chat-btn relative"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={onToggle}
      data-testid="team-sessions-toggle"
      data-count={count}
      data-active={activeCount}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      {count > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold leading-4 text-white"
          data-testid="team-sessions-badge"
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function TeamSessionsPanel({
  sessions,
  onClose,
}: {
  sessions: readonly DelegatedSessionInfo[];
  onClose: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <aside
      className="agent-harness-panel"
      data-testid="team-sessions-panel"
      role="complementary"
      aria-label={t("agents.teamSessions.title")}
    >
      <header className="agent-harness-head">
        <div>
          <h2 className="agent-harness-title">{t("agents.teamSessions.title")}</h2>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon agent-harness-close"
          onClick={onClose}
          aria-label={t("harness.panel.close")}
          title={t("harness.panel.close")}
          data-testid="team-sessions-close"
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
        <p className="text-xs text-[var(--text-3)]" data-testid="team-sessions-hint">
          {t("agents.teamSessions.hint")}
        </p>

        {sessions.length === 0 ? (
          <p className="text-sm text-[var(--text-3)]" data-testid="team-sessions-empty">
            {t("agents.teamSessions.empty")}
          </p>
        ) : (
          <ul className="space-y-2.5" data-testid="team-sessions-list">
            {sessions.map((session) => {
              const expanded = expandedId === session.id;
              return (
                <li
                  key={session.id}
                  className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3"
                  data-testid="team-session-item"
                  data-status={session.status}
                  data-agent={session.agentKey}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--text)]">{session.agentName}</p>
                      <p className="mt-0.5 text-xs text-[var(--text-2)]">{session.task}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(session.status)}`}
                      data-testid="team-session-status"
                    >
                      {t(`agents.teamSessions.status.${session.status}`)}
                    </span>
                  </div>

                  {session.toolsUsed.length > 0 ? (
                    <p className="mt-1.5 text-[11px] text-[var(--text-3)]">
                      {t("agents.teamSessions.tools", { tools: session.toolsUsed.join(" · ") })}
                    </p>
                  ) : null}

                  {session.error ? (
                    <p className="mt-1.5 text-xs text-[var(--danger)]">{session.error}</p>
                  ) : null}

                  {expanded && session.summary ? (
                    <p
                      className="mt-2 break-words whitespace-pre-wrap border-t border-[var(--line)] pt-2 text-xs text-[var(--text-2)]"
                      data-testid="team-session-summary"
                    >
                      {session.summary}
                    </p>
                  ) : null}

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {session.summary ? (
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => setExpandedId(expanded ? null : session.id)}
                        data-testid="team-session-toggle-summary"
                      >
                        {expanded ? t("agents.delegate.hide") : t("agents.delegate.show")}
                      </button>
                    ) : null}
                    <Link
                      href={sessionHref(session)}
                      className="text-xs font-medium text-[var(--accent)] hover:underline"
                      data-testid="team-session-direct-link"
                    >
                      {t("agents.teamSessions.openDirect")}
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
