import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ProductMode } from "@agentforge/core/product-modes";
import { BrandContext, DEFAULT_PRODUCT_BRAND, type ProductBrand, WEB_LOGO_SRC } from "./product-brand";
import type { VirtualAgentInfo } from "./virtual-agents";

type ViewProps = {
  agents: readonly VirtualAgentInfo[];
  loaded: boolean;
  activeId: ProductMode | null;
  pathname: string;
  productName: string;
  logoSrc: string;
  bundledMark: boolean;
  footer?: ReactNode;
  showBoard?: boolean;
  showProjects?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onDismiss?: () => void;
};

type ShellProps = { workspaceName: string; visibleModes: ProductMode[]; children: ReactNode };

export type RailImplementation = {
  AgentRailView: ComponentType<ViewProps>;
  AgentRail: ComponentType<{ visibleModes: ProductMode[] }>;
  AppShell: ComponentType<ShellProps>;
};

function agent(id: VirtualAgentInfo["id"]): VirtualAgentInfo {
  return {
    id,
    generalist: id === "chat",
    conversation: "harness",
    agentId: `agent_${id}`,
    loop: "agent",
    tools: [],
    budget: { maxSteps: 8, maxToolCalls: 8 },
    repairRounds: 0,
    skills: [],
  };
}

const AGENTS = [agent("chat"), agent("research"), agent("documents")];

const noop = () => undefined;

const VIEW_BASE: ViewProps = {
  agents: AGENTS,
  loaded: true,
  activeId: "research",
  pathname: "/chat",
  productName: "Acme Desk",
  logoSrc: "",
  bundledMark: false,
  showBoard: true,
  showProjects: true,
  footer: <span data-testid="footer-slot" />,
};

const WEB_BRAND: ProductBrand = { ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC };

function inRouter(path: string, node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

function withBrand(brand: ProductBrand, node: ReactNode): ReactNode {
  return <BrandContext.Provider value={brand}>{node}</BrandContext.Provider>;
}

export function renderOpcCases(impl: RailImplementation): Record<string, string> {
  const { AgentRailView, AgentRail, AppShell } = impl;
  const page = <div data-testid="page">page</div>;
  return {
    "view-collapsed": inRouter("/chat", <AgentRailView {...VIEW_BASE} />),
    "view-collapsed-toggle": inRouter("/chat", <AgentRailView {...VIEW_BASE} onToggle={noop} />),
    "view-expanded": inRouter("/chat", <AgentRailView {...VIEW_BASE} collapsed={false} onToggle={noop} />),
    "view-drawer": inRouter(
      "/chat",
      <AgentRailView {...VIEW_BASE} collapsed={false} onToggle={noop} onDismiss={noop} />,
    ),
    "view-waiting": inRouter("/chat", <AgentRailView {...VIEW_BASE} agents={[]} loaded={false} />),
    "view-bundled-mark": inRouter(
      "/chat",
      <AgentRailView {...VIEW_BASE} productName={WEB_BRAND.productName} logoSrc={WEB_LOGO_SRC} bundledMark />,
    ),
    "rail-no-shell": inRouter("/chat", <AgentRail visibleModes={[]} />),
    "rail-opc-shell": inRouter("/chat", withBrand({ ...WEB_BRAND, shell: "opc" }, <AgentRail visibleModes={[]} />)),
    "rail-agent-path": inRouter("/agents/research", <AgentRail visibleModes={[]} />),
    "shell-no-shell": inRouter(
      "/chat",
      <AppShell workspaceName="Desk" visibleModes={[]}>
        {page}
      </AppShell>,
    ),
    "shell-opc-shell": inRouter(
      "/chat",
      withBrand(
        { ...WEB_BRAND, shell: "opc" },
        <AppShell workspaceName="Desk" visibleModes={[]}>
          {page}
        </AppShell>,
      ),
    ),
  };
}
