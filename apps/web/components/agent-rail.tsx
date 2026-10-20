"use client";

import { useState, type ReactNode, type SyntheticEvent } from "react";
import type { ProductMode } from "@agentforge/core/product-modes";
import { usePathname, useSearchParams } from "@/lib/nav";
import { AppUpdatesButton } from "@/components/app-updates";
import { RAIL_PANEL_ID, RailLink, RailMenuButton, RailToggle, type Tip } from "@/components/agent-rail-parts";
import { BrandMark } from "@/components/brand-mark";
import { DeskBuddyChip, DeskBuddyDock } from "@/components/desk-buddy";
import { ModeIcon, isModeIconName, type ModeIconName } from "@/components/mode-icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { productMonogram } from "@/components/app-shell";
import { t } from "@/lib/i18n";
import { assistantNameOf, useProductBrand, usesBundledMark } from "@/lib/product-brand";
import type { ShellModesSource } from "@/lib/shell-modes";
import { RAIL_PHONE_QUERY, useMatchMedia, useRailCollapse, useRailDrawer } from "@/lib/agent-rail-state";
import {
  activeAgentId,
  useVirtualAgents,
  virtualAgentHref,
  virtualAgentName,
  type VirtualAgentInfo,
} from "@/lib/virtual-agents";
import "./agent-rail.css";

type Props = {
  /** The desk's modes. The agents come from the host's own list, so this is only kept for the shell's signature. */
  visibleModes: ProductMode[];
  modesSource?: ShellModesSource;
};

/** How many quiet placeholders follow the generalist while the host has not answered. */
const SKELETON_KEYS = ["a", "b", "c"] as const;

function GeneralistTile({ productName, logoSrc, bundled }: { productName: string; logoSrc: string; bundled: boolean }) {
  if (bundled) {
    return <BrandMark size={24} className="agent-rail-mark" />;
  }
  if (logoSrc) {
    return <img src={logoSrc} alt="" className="agent-rail-logo" />;
  }
  return <span className="agent-rail-monogram">{productMonogram(productName)}</span>;
}

export type AgentRailViewProps = {
  agents: readonly VirtualAgentInfo[];
  /** False until the host has answered once. With nothing cached too, the list draws as a skeleton. */
  loaded: boolean;
  activeId: ProductMode | null;
  pathname: string;
  productName: string;
  /** The default agent's name: the brand's character (`assistantNameOf`). Left out, the product's name. */
  assistantName?: string;
  logoSrc: string;
  /** `usesBundledMark(brand)`: draw the mark that ships with the renderer instead of `logoSrc`. */
  bundledMark: boolean;
  /** The footer controls (theme, updates). A slot so the drawing stays free of the update bridge. */
  footer?: ReactNode;
  collapsed?: boolean;
  menu?: boolean;
  onToggle?: () => void;
  /** A phone only: the expanded rail is a drawer over the page, and this is what closes it. */
  onDismiss?: () => void;
};

const ACCOUNT_LINKS: ReadonlyArray<{ href: string; icon: ModeIconName; testId: string; labelKey: string }> = [
  { href: "/knowledge", icon: "knowledge", testId: "mode-knowledge", labelKey: "rail.knowledge" },
  { href: "/channels", icon: "channels", testId: "channels-link", labelKey: "rail.channels" },
  { href: "/workspaces", icon: "workspaces", testId: "workspaces-link", labelKey: "agents.rail.manage" },
  { href: "/usage", icon: "usage", testId: "usage-link", labelKey: "rail.usage" },
  { href: "/settings", icon: "settings", testId: "settings-link", labelKey: "rail.settings" },
];

/** The generalist is the one agent every desk has, so a host answer that lacks it still gets a tile. */
const FALLBACK_GENERALIST: VirtualAgentInfo = {
  id: "chat",
  generalist: true,
  conversation: "harness",
  agentId: null,
  loop: "agent",
  tools: [],
  budget: { maxSteps: 0, maxToolCalls: 0 },
  repairRounds: 0,
  skills: [],
};

export function AgentRailView({
  agents,
  loaded,
  activeId,
  pathname,
  productName,
  assistantName,
  logoSrc,
  bundledMark,
  footer,
  collapsed = false,
  menu = false,
  onToggle,
  onDismiss,
}: AgentRailViewProps) {
  /*
   * The name shows in one tooltip drawn by the rail itself, outside the scrolling column. A tooltip
   * inside that column would be clipped by it (a scroller clips both axes), and a CSS-only one cannot
   * know where its tile sits once the list has scrolled. `position: fixed` escapes the clip, and the
   * tile's own rectangle at hover or focus time is the anchor. `title` stays as the fallback.
   */
  const [tip, setTip] = useState<Tip | null>(null);
  const onTip = (label: string) => (event: SyntheticEvent<HTMLElement>) => {
    if (!collapsed) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const rail = event.currentTarget.closest("aside")?.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2, left: (rail?.right ?? rect.right) + 8 });
  };
  const onTipEnd = () => setTip(null);

  // Nothing cached and no answer yet: the generalist alone, so Chat is reachable from the first frame,
  // and quiet placeholders where the rest will land.
  const waiting = !loaded && agents.length === 0;
  const list = agents.some((agent) => agent.generalist) ? agents : [FALLBACK_GENERALIST, ...agents];
  const here = list.find((agent) => agent.id === activeId);
  const page = here ? undefined : ACCOUNT_LINKS.find((item) => pathname.startsWith(item.href));

  const renderAgent = (agent: VirtualAgentInfo) => (
    <RailLink
      key={agent.id}
      href={virtualAgentHref(agent.id)}
      label={virtualAgentName(agent, assistantName ?? productName)}
      testId={agent.generalist ? "mode-chat" : `agent-${agent.id}`}
      mode={agent.id}
      active={activeId === agent.id}
      collapsed={collapsed}
      className={agent.generalist ? "agent-rail-generalist" : undefined}
      conversation={agent.conversation}
      onTip={onTip}
      onTipEnd={onTipEnd}
    >
      {agent.generalist ? (
        <GeneralistTile productName={productName} logoSrc={logoSrc} bundled={bundledMark} />
      ) : (
        <span className="agent-rail-tile">
          <ModeIcon name={isModeIconName(agent.id) ? agent.id : "documents"} size={18} strokeWidth={1.75} />
        </span>
      )}
    </RailLink>
  );

  return (
    <aside
      className="agent-rail"
      aria-label={t("agents.rail.aria")}
      data-testid="agent-rail"
      data-rail={collapsed ? "min" : "full"}
      data-menu={menu ? "true" : undefined}
    >
      {menu ? (
        <div className="agent-rail-bar" data-testid="rail-bar">
          {onToggle ? <RailMenuButton open={!collapsed} onToggle={onToggle} /> : null}
          {here && !here.generalist ? (
            <span className="agent-rail-tile">
              <ModeIcon name={isModeIconName(here.id) ? here.id : "documents"} size={18} strokeWidth={1.75} />
            </span>
          ) : page ? (
            <span className="agent-rail-tile">
              <ModeIcon name={page.icon} size={18} strokeWidth={1.75} />
            </span>
          ) : (
            <GeneralistTile productName={productName} logoSrc={logoSrc} bundled={bundledMark} />
          )}
          <span className="agent-rail-bar-name" data-testid="rail-bar-name">
            {here ? virtualAgentName(here, assistantName ?? productName) : page ? t(page.labelKey) : productName}
          </span>
        </div>
      ) : null}
      <div className="agent-rail-inner" id={RAIL_PANEL_ID}>
        <nav
          className="agent-rail-agents"
          aria-label={t("agents.rail.agentsAria")}
          aria-busy={waiting || undefined}
          data-tour="rail-modes"
          onScroll={onTipEnd}
        >
          {list.filter((agent) => agent.generalist).map(renderAgent)}
          {list.filter((agent) => !agent.generalist).map(renderAgent)}
          {waiting
            ? SKELETON_KEYS.map((key) => (
                <span key={key} className="agent-rail-skeleton" data-testid="agent-rail-skeleton" aria-hidden="true" />
              ))
            : null}
        </nav>

        <div className="agent-rail-divider" aria-hidden="true" />

        <div className="agent-rail-account" data-testid="rail-account-group">
          {ACCOUNT_LINKS.map((item) => (
            <RailLink
              key={item.testId}
              href={item.href}
              label={t(item.labelKey)}
              testId={item.testId}
              mode={item.icon}
              active={pathname.startsWith(item.href)}
              collapsed={collapsed}
              onTip={onTip}
              onTipEnd={onTipEnd}
            >
              <span className="agent-rail-tile">
                <ModeIcon name={item.icon} size={18} strokeWidth={1.75} />
              </span>
            </RailLink>
          ))}
        </div>

        <div className="agent-rail-footer" data-testid="rail-footer">
          {onToggle && !(menu && collapsed) ? <RailToggle collapsed={collapsed} onToggle={onToggle} /> : null}
          {footer}
        </div>
      </div>

      {tip ? (
        <span className="agent-rail-tip" style={{ top: tip.top, left: tip.left }} aria-hidden="true">
          {tip.label}
        </span>
      ) : null}

      {onDismiss && !collapsed ? (
        <button
          type="button"
          className="agent-rail-scrim"
          tabIndex={-1}
          aria-label={t("rail.collapse")}
          data-testid="rail-scrim"
          onClick={onDismiss}
        />
      ) : null}
    </aside>
  );
}

export function AgentRail(_props: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const brand = useProductBrand();
  const { agents, loaded } = useVirtualAgents();
  const phone = useMatchMedia(RAIL_PHONE_QUERY);
  const desk = useRailCollapse(false);
  const drawer = useRailDrawer(phone, `${pathname}?${searchParams.toString()}`);
  const collapsed = phone ? !drawer.open : desk.collapsed;

  return (
    <AgentRailView
      agents={agents}
      loaded={loaded}
      activeId={activeAgentId(pathname, searchParams)}
      pathname={pathname}
      productName={brand.productName}
      assistantName={assistantNameOf(brand)}
      logoSrc={brand.logoSrc}
      bundledMark={usesBundledMark(brand)}
      collapsed={collapsed}
      menu={phone}
      onToggle={phone ? drawer.toggle : desk.toggle}
      onDismiss={phone ? drawer.close : undefined}
      footer={
        <>
          {/* The character lives here in this shell, as the small head: the rail is the one place on
            screen where nothing a person or a model wrote ever scrolls under it. The dock is what
            tells the buddy it has a home; it is given no room (`agent-rail.css`), so the buddy is
            always the head and never a body standing over the rail's icons. */}
          <div className="agent-rail-buddy-dock" aria-hidden="true">
            <DeskBuddyDock collapsed={false} />
          </div>
          <DeskBuddyChip />
          <ThemeToggle />
          <AppUpdatesButton collapsed />
        </>
      }
    />
  );
}
