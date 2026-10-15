"use client";

import { BrandMonogram } from "@/components/brand-monogram";
import { RailLink, RailToggle, type RailLinkProps } from "@/components/agent-rail-parts";
import { Link } from "@/lib/nav";
import { t } from "@/lib/i18n";
import {
  railWorkspaceHref,
  WORKSPACES_PAGE_PATH,
  workspaceInitial,
  workspaceTone,
  type RailWorkspacesState,
} from "@/lib/rail-workspaces";

type TipProps = Pick<RailLinkProps, "onTip" | "onTipEnd">;

const SKELETON_ROWS = ["a", "b"] as const;

function BrandTile({
  name,
  logoSrc,
  bundledMark,
  size = 32,
}: {
  name: string;
  logoSrc: string;
  bundledMark: boolean;
  size?: number;
}) {
  if (logoSrc && !bundledMark) {
    return <img src={logoSrc} alt="" width={size} height={size} className="agent-rail-logo" />;
  }
  return <BrandMonogram name={name} size={size} className="agent-rail-brand-monogram" />;
}

type HeaderProps = {
  name: string;
  logoSrc: string;
  bundledMark: boolean;
  collapsed: boolean;
  onToggle?: () => void;
};

export function EnterpriseRailHeader({ name, logoSrc, bundledMark, collapsed, onToggle }: HeaderProps) {
  return (
    <div className="agent-rail-brand" data-testid="rail-brand">
      <BrandTile name={name} logoSrc={logoSrc} bundledMark={bundledMark} />
      {collapsed ? null : (
        <span className="agent-rail-brand-text">
          <span className="agent-rail-brand-name" data-testid="rail-brand-name">
            {name}
          </span>
          <span className="agent-rail-badge" data-testid="rail-badge">
            {t("agents.rail.enterpriseBadge")}
          </span>
        </span>
      )}
      {onToggle ? <RailToggle collapsed={collapsed} onToggle={onToggle} /> : null}
    </div>
  );
}

export function SectionHeading({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="agent-rail-section-title" data-testid={testId}>
      {label}
    </div>
  );
}

function PlusGlyph() {
  return (
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
  );
}

type WorkspacesProps = TipProps & {
  state: RailWorkspacesState;
  activeId: string | null;
  collapsed: boolean;
};

export function WorkspacesSection({ state, activeId, collapsed, onTip, onTipEnd }: WorkspacesProps) {
  const waiting = !state.loaded && state.items.length === 0;
  const newLabel = t("agents.rail.newWorkspace");
  return (
    <section
      className="agent-rail-workspaces"
      aria-label={t("agents.rail.workspacesAria")}
      aria-busy={waiting || undefined}
      data-testid="rail-workspaces"
    >
      {collapsed ? null : <SectionHeading label={t("agents.rail.workspacesHeading")} testId="rail-workspaces-title" />}
      <div className="agent-rail-workspace-list">
        {state.items.map((item) => (
          <RailLink
            key={item.id}
            href={railWorkspaceHref(item.id)}
            label={item.name}
            testId={`workspace-${item.id}`}
            mode="workspaces"
            active={activeId === item.id}
            collapsed={collapsed}
            className="agent-rail-workspace"
            trailing={<span className="agent-rail-ws-count">{item.memberCount}</span>}
            onTip={onTip}
            onTipEnd={onTipEnd}
          >
            <span className="agent-rail-ws-chip" data-tone={workspaceTone(item.id)} aria-hidden="true">
              {workspaceInitial(item.name)}
            </span>
          </RailLink>
        ))}
        {waiting
          ? SKELETON_ROWS.map((key) => (
              <span
                key={key}
                className="agent-rail-skeleton"
                data-testid="rail-workspaces-skeleton"
                aria-hidden="true"
              />
            ))
          : null}
        <Link
          href={WORKSPACES_PAGE_PATH}
          className="agent-rail-new-workspace"
          aria-label={newLabel}
          title={collapsed ? newLabel : undefined}
          data-testid="rail-new-workspace"
        >
          <PlusGlyph />
          {collapsed ? null : <span className="agent-rail-label">{newLabel}</span>}
        </Link>
      </div>
    </section>
  );
}
