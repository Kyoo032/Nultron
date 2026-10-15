"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { Link } from "@/lib/nav";
import { t } from "@/lib/i18n";
import type { VirtualAgentInfo } from "@/lib/virtual-agents";

export const RAIL_PANEL_ID = "agent-rail-panel";

export type Tip = { label: string; top: number; left: number };

export type RailLinkProps = {
  href: string;
  label: string;
  testId: string;
  mode: string;
  active: boolean;
  collapsed: boolean;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
  conversation?: VirtualAgentInfo["conversation"];
  onTip: (label: string) => (event: SyntheticEvent<HTMLElement>) => void;
  onTipEnd: () => void;
};

export function RailLink({
  href,
  label,
  testId,
  mode,
  active,
  collapsed,
  children,
  trailing,
  className,
  conversation,
  onTip,
  onTipEnd,
}: RailLinkProps) {
  const showTip = onTip(label);
  return (
    <Link
      href={href}
      className={`agent-rail-link${className ? ` ${className}` : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={collapsed ? label : undefined}
      data-testid={testId}
      data-mode={mode}
      data-active={active ? "true" : undefined}
      data-conversation={conversation}
      onMouseEnter={showTip}
      onFocus={showTip}
      onMouseLeave={onTipEnd}
      onBlur={onTipEnd}
    >
      {children}
      {collapsed ? null : <span className="agent-rail-label">{label}</span>}
      {collapsed ? null : trailing}
    </Link>
  );
}

function PanelGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

export function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? t("rail.expand") : t("rail.collapse");
  return (
    <button
      type="button"
      className="agent-rail-toggle btn btn-ghost btn-icon h-8 w-8 shrink-0 rounded-md wash"
      aria-expanded={!collapsed}
      aria-controls={RAIL_PANEL_ID}
      aria-label={label}
      title={label}
      data-testid={collapsed ? "rail-expand" : "rail-collapse"}
      onClick={onToggle}
    >
      <PanelGlyph />
    </button>
  );
}
