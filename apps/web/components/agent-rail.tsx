"use client";

import { useState, type ReactNode, type SyntheticEvent } from "react";
import type { ProductMode } from "@agentforge/core/product-modes";
import { usePathname, useRouter, useSearchParams } from "@/lib/nav";
import { AppUpdatesButton } from "@/components/app-updates";
import { AgentDeleteDialog } from "@/components/agent-delete-dialog";
import { MadeAgentRailRow, NewAgentRailLink } from "@/components/agent-made-rail";
import { EnterpriseRailHeader, SectionHeading, WorkspacesSection } from "@/components/agent-rail-enterprise";
import { RAIL_PANEL_ID, RailLink, RailToggle, type Tip } from "@/components/agent-rail-parts";
import { BrandMark } from "@/components/brand-mark";
import { DeskBuddyChip, DeskBuddyDock } from "@/components/desk-buddy";
import { ModeIcon, isModeIconName, type ModeIconName } from "@/components/mode-icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { productMonogram } from "@/components/app-shell";
import { buddyAllowedAt } from "@/lib/buddy-routes";
import { enterpriseBrandName } from "@/lib/enterprise-brand";
import { isHostedBuild } from "@/lib/hosted-build";
import { t } from "@/lib/i18n";
import { assistantNameOf, useProductBrand, usesBundledMark, useShellLook, type ShellLook } from "@/lib/product-brand";
import { activeWorkspaceIdOf, useRailWorkspaces, type RailWorkspacesState } from "@/lib/rail-workspaces";
import type { ShellModesSource } from "@/lib/shell-modes";
import { RAIL_PHONE_QUERY, useMatchMedia, useRailCollapse, useRailDrawer } from "@/lib/agent-rail-state";
import {
  activeAgentId,
  useVirtualAgents,
  virtualAgentHref,
  virtualAgentName,
  type VirtualAgentInfo,
} from "@/lib/virtual-agents";
import { madeAgentIdFromSearch, useMadeAgents, type MadeAgent } from "@/lib/virtual-agents-made";
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
    // The product mark is already a tile with its own corners, so it is not set inside a second one.
    return <BrandMark size={32} className="agent-rail-mark" />;
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
  /** The team board's entry. Hosted only (`isHostedBuild()`): the board does not exist on Personal. */
  showBoard?: boolean;
  /** The Workspaces entry (K-D20). Hosted only (`isHostedBuild()`), like the board. */
  showProjects?: boolean;
  /** The icon strip when true (the default, the rail as it was); icons with their names when false. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** A phone only: the expanded rail is a drawer over the page, and this is what closes it. */
  onDismiss?: () => void;
  /** The enterprise shell (`AGENTFORGE_SHELL`): the same rail, with the brand header and the Workspaces section. */
  look?: ShellLook;
  /** Hosted enterprise only: the person's Workspaces, drawn above the agents. Null draws no section. */
  workspaces?: RailWorkspacesState | null;
  activeWorkspaceId?: string | null;
  made?: readonly MadeAgent[];
  activeMadeId?: string | null;
  onRequestDelete?: (agent: MadeAgent) => void;
};

type AccountLink = { href: string; icon: ModeIconName; testId: string; labelKey: string };

/** The team board (tester lane, K0): an account page beside Knowledge and Settings (team-board-spec.md section 14). */
const BOARD_LINK: AccountLink = { href: "/board", icon: "board", testId: "board-link", labelKey: "board.rail.label" };

/** The Workspaces page (tester lane, K-D20): the same account group, after the board. */
const PROJECTS_LINK: AccountLink = {
  href: "/projects",
  icon: "workspaces",
  testId: "projects-link",
  labelKey: "projects.rail.label",
};

const ACCOUNT_LINKS: ReadonlyArray<AccountLink> = [
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
  showBoard = false,
  showProjects = false,
  collapsed = true,
  onToggle,
  onDismiss,
  look = "opc",
  workspaces = null,
  activeWorkspaceId = null,
  made = [],
  activeMadeId = null,
  onRequestDelete,
}: AgentRailViewProps) {
  const enterprise = look === "enterprise";
  const sectionCoversProjects = enterprise && workspaces !== null;
  const hostedLinks = [
    ...(showBoard ? [BOARD_LINK] : []),
    ...(showProjects && !sectionCoversProjects ? [PROJECTS_LINK] : []),
  ];
  const accountLinks = [...hostedLinks, ...ACCOUNT_LINKS];
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
  const withGeneralist = agents.some((agent) => agent.generalist) ? agents : [FALLBACK_GENERALIST, ...agents];
  const list = enterprise ? withGeneralist.filter((agent) => agent.generalist) : withGeneralist;

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
      {agent.generalist && !enterprise ? (
        <GeneralistTile productName={productName} logoSrc={logoSrc} bundled={bundledMark} />
      ) : (
        <span className="agent-rail-tile">
          <ModeIcon name={isModeIconName(agent.id) ? agent.id : "documents"} size={20} strokeWidth={2} />
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
      data-look={enterprise ? "enterprise" : undefined}
    >
      <div className="agent-rail-inner" id={RAIL_PANEL_ID}>
        {enterprise ? (
          <EnterpriseRailHeader
            name={productName}
            logoSrc={logoSrc}
            bundledMark={bundledMark}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ) : null}
        {enterprise && workspaces ? (
          <WorkspacesSection
            state={workspaces}
            activeId={activeWorkspaceId}
            collapsed={collapsed}
            onTip={onTip}
            onTipEnd={onTipEnd}
          />
        ) : null}
        {enterprise && !collapsed ? (
          <SectionHeading label={t("agents.rail.agentsHeading")} testId="rail-agents-title" />
        ) : null}
        <nav
          className="agent-rail-agents"
          aria-label={t("agents.rail.agentsAria")}
          aria-busy={waiting || undefined}
          data-tour="rail-modes"
          onScroll={onTipEnd}
        >
          {list.filter((agent) => agent.generalist).map(renderAgent)}
          {made.map((agent) => (
            <MadeAgentRailRow
              key={agent.id}
              agent={agent}
              active={activeMadeId === agent.id}
              collapsed={collapsed}
              onRequestDelete={onRequestDelete}
              onTip={onTip}
              onTipEnd={onTipEnd}
            />
          ))}
          {list.filter((agent) => !agent.generalist).map(renderAgent)}
          <NewAgentRailLink collapsed={collapsed} />
          {waiting && !enterprise
            ? SKELETON_KEYS.map((key) => (
                <span key={key} className="agent-rail-skeleton" data-testid="agent-rail-skeleton" aria-hidden="true" />
              ))
            : null}
        </nav>

        <div className="agent-rail-divider" aria-hidden="true" />

        <div className="agent-rail-account" data-testid="rail-account-group">
          {accountLinks.map((item) => (
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
                <ModeIcon name={item.icon} size={20} strokeWidth={2} />
              </span>
            </RailLink>
          ))}
        </div>

        <div className="agent-rail-footer" data-testid="rail-footer">
          {onToggle && !enterprise ? <RailToggle collapsed={collapsed} onToggle={onToggle} /> : null}
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
  const router = useRouter();
  const brand = useProductBrand();
  const enterprise = useShellLook() === "enterprise";
  const { agents, loaded } = useVirtualAgents();
  const made = useMadeAgents();
  const [pendingDelete, setPendingDelete] = useState<MadeAgent | null>(null);
  const phone = useMatchMedia(RAIL_PHONE_QUERY);
  const desk = useRailCollapse(!enterprise);
  const drawer = useRailDrawer(phone, `${pathname}?${searchParams.toString()}`);
  const collapsed = phone ? !drawer.open : desk.collapsed;
  const hosted = isHostedBuild();
  const workspaces = useRailWorkspaces(enterprise && hosted, pathname);
  const buddy = !enterprise && buddyAllowedAt(pathname);
  const productName = enterprise ? enterpriseBrandName(brand.productName) : brand.productName;
  const assistantName = enterprise ? brand.assistantName?.trim() || productName : assistantNameOf(brand);
  const openMadeId = pathname === "/chat" ? madeAgentIdFromSearch(searchParams) : null;

  function onDeleted(agentId: string) {
    setPendingDelete(null);
    if (madeAgentIdFromSearch(searchParams) === agentId) {
      router.push(virtualAgentHref("chat"));
    }
  }

  return (
    <>
      <AgentRailView
        agents={agents}
        loaded={loaded}
        activeId={activeAgentId(pathname, searchParams)}
        made={made.agents}
        activeMadeId={openMadeId}
        onRequestDelete={setPendingDelete}
        pathname={pathname}
        productName={productName}
        assistantName={assistantName}
        logoSrc={brand.logoSrc}
        bundledMark={usesBundledMark(brand)}
        showBoard={hosted}
        showProjects={hosted}
        collapsed={collapsed}
        onToggle={phone ? drawer.toggle : desk.toggle}
        onDismiss={phone ? drawer.close : undefined}
        look={enterprise ? "enterprise" : "opc"}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceIdOf(pathname, searchParams)}
        footer={
          <>
            {/* The character lives here in this shell, as the small head: the rail is the one place on
              screen where nothing a person or a model wrote ever scrolls under it. The dock is what
              tells the buddy it has a home; it is given no room (`agent-rail.css`), so the buddy is
              always the head and never a body standing over the rail's icons. */}
            {buddy ? (
              <div className="agent-rail-buddy-dock" aria-hidden="true">
                <DeskBuddyDock collapsed={false} />
              </div>
            ) : null}
            {buddy ? <DeskBuddyChip /> : null}
            <ThemeToggle />
            {enterprise ? null : <AppUpdatesButton collapsed />}
          </>
        }
      />
      {pendingDelete ? (
        <AgentDeleteDialog agent={pendingDelete} onCancel={() => setPendingDelete(null)} onDeleted={onDeleted} />
      ) : null}
    </>
  );
}
