import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRail, AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import { AppShell } from "@/components/app-shell";
import { BrandMark } from "@/components/brand-mark";
import { ChatLauncher } from "@/components/chat-launcher";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { publishGate, resetGateStateForTests } from "./gate-state";
import type { GatewayGatePayload } from "./gateway-gate";
import { renderOpcCases } from "./opc-shell-cases";
import { BrandContext, DEFAULT_PRODUCT_BRAND, type ProductBrand, WEB_LOGO_SRC } from "./product-brand";
import type { RailWorkspacesState } from "./rail-workspaces";
import type { VirtualAgentInfo } from "./virtual-agents";

const GOLDEN = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "opc-shell.golden.json"), "utf8"),
) as Record<string, string>;

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

const WORKSPACES: RailWorkspacesState = {
  loaded: true,
  items: [
    { id: "ws_alpha", name: "Finance team", memberCount: 4 },
    { id: "ws_beta", name: "Legal", memberCount: 2 },
  ],
};

const ENTERPRISE_BRAND: ProductBrand = {
  ...DEFAULT_PRODUCT_BRAND,
  productName: "Acme Desk",
  logoSrc: WEB_LOGO_SRC,
  shell: "enterprise",
};

const VIEW: AgentRailViewProps = {
  agents: [agent("chat"), agent("research"), agent("documents")],
  loaded: true,
  activeId: "research",
  pathname: "/chat",
  productName: "Acme Desk",
  logoSrc: WEB_LOGO_SRC,
  bundledMark: true,
  showBoard: true,
  showProjects: true,
  onToggle: () => undefined,
};

function inRouter(path: string, node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

function enterpriseView(over: Partial<AgentRailViewProps> = {}): string {
  return inRouter(
    "/chat",
    <AgentRailView {...VIEW} look="enterprise" workspaces={WORKSPACES} collapsed={false} {...over} />,
  );
}

function enterpriseShell(brand: ProductBrand, path = "/chat"): string {
  return inRouter(
    path,
    <BrandContext.Provider value={brand}>
      <AppShell workspaceName="Desk" visibleModes={[]}>
        <div>page</div>
      </AppShell>
    </BrandContext.Provider>,
  );
}

function testIds(html: string): string[] {
  return [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1] as string);
}

function hrefOf(html: string, id: string): string | undefined {
  return html.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*data-testid="${id}"`))?.[1];
}

const MODE_AGENT_IDS = ["agent-research", "agent-documents"];

const COVERED_BY_WORKSPACES_SECTION: Record<string, string> = { "projects-link": "rail-new-workspace" };

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("the default shell is held to the byte", () => {
  const cases = renderOpcCases({ AgentRailView, AgentRail, AppShell });

  it("covers every case in the committed rail and shell", () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it.each(Object.keys(GOLDEN))("renders %s exactly as the committed rail and shell did", (name) => {
    expect(cases[name]).toBe(GOLDEN[name]);
  });

  it("draws no enterprise marker without the enterprise shell", () => {
    for (const html of Object.values(cases)) {
      expect(html).not.toContain("data-look");
      expect(html).not.toContain("data-product-shell");
      expect(html).not.toContain("rail-workspaces");
      expect(html).not.toContain("rail-badge");
    }
  });

  it("starts collapsed to the icon strip, as the rail always did", () => {
    expect(cases["rail-no-shell"]).toContain('data-rail="min"');
    expect(cases["rail-opc-shell"]).toContain('data-rail="min"');
  });

  it("treats an unknown shell as the default shell", () => {
    expect(cases["shell-no-shell"]).toBe(cases["shell-opc-shell"]);
    expect(cases["rail-no-shell"]).toBe(cases["rail-opc-shell"]);
  });
});

describe("the enterprise shell keeps every tool of the rail", () => {
  it("offers every link the default rail offers, the Workspaces link through its section", () => {
    const base = inRouter("/chat", <AgentRailView {...VIEW} />);
    const enterpriseLinks = testIds(enterpriseView());
    for (const id of testIds(base).filter((name) => name !== "rail-expand" && !MODE_AGENT_IDS.includes(name))) {
      expect(enterpriseLinks, id).toContain(COVERED_BY_WORKSPACES_SECTION[id] ?? id);
    }
  });

  it("points each of them at the same route", () => {
    const base = inRouter("/chat", <AgentRailView {...VIEW} />);
    const enterprise = enterpriseView();
    for (const id of ["mode-chat", "board-link", "mode-knowledge", "settings-link"]) {
      expect(hrefOf(enterprise, id), id).toBe(hrefOf(base, id));
    }
    for (const [id, cover] of Object.entries(COVERED_BY_WORKSPACES_SECTION)) {
      expect(hrefOf(enterprise, cover), id).toBe(hrefOf(base, id));
    }
  });

  it("keeps the footer slot", () => {
    const html = enterpriseView({ footer: <span data-testid="footer-slot" /> });
    expect(html).toContain('data-testid="footer-slot"');
  });
});

describe("the enterprise rail", () => {
  it("lists the default agent only, never the built-in mode agents", () => {
    const ids = testIds(enterpriseView());
    expect(ids).toContain("mode-chat");
    expect(ids.filter((id) => MODE_AGENT_IDS.includes(id))).toEqual([]);
    expect(ids).toContain("workspaces-link");
  });

  it("names the product from the brand and badges it Enterprise", () => {
    const html = enterpriseView();
    expect(html).toContain('data-look="enterprise"');
    expect(html).toMatch(/data-testid="rail-brand-name"[^>]*>Acme Desk</);
    expect(html).toMatch(/data-testid="rail-badge"[^>]*>Enterprise</);
  });

  it("puts the Workspaces section above the agents", () => {
    const html = enterpriseView();
    const workspaces = html.indexOf('data-testid="rail-workspaces"');
    expect(workspaces).toBeGreaterThan(html.indexOf('data-testid="rail-brand"'));
    expect(workspaces).toBeLessThan(html.indexOf('data-testid="rail-agents-title"'));
    expect(html.indexOf('data-testid="rail-agents-title"')).toBeLessThan(html.indexOf('data-tour="rail-modes"'));
  });

  it("lists each Workspace with its member count and a link that opens it", () => {
    const html = enterpriseView();
    expect(html).toContain('href="/projects?open=ws_alpha"');
    expect(html).toContain('data-testid="workspace-ws_beta"');
    expect(html).toMatch(/Finance team<\/span><span class="agent-rail-ws-count">4</);
  });

  it("offers New Workspace on the Workspaces page", () => {
    const html = enterpriseView();
    const link = html.match(/<a[^>]*data-testid="rail-new-workspace"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('href="/projects"');
    expect(link).toContain('aria-label="New Workspace"');
  });

  it("marks the open Workspace as the current page", () => {
    const html = enterpriseView({ activeWorkspaceId: "ws_beta", activeId: null, pathname: "/projects" });
    const row = html.match(/<a[^>]*data-testid="workspace-ws_beta"[^>]*>/)?.[0] ?? "";
    expect(row).toContain('aria-current="page"');
  });

  it("draws no Workspaces section when the host has none to give", () => {
    const html = enterpriseView({ workspaces: null });
    expect(html).not.toContain("rail-workspaces");
    expect(html).toContain("rail-badge");
  });

  it("shows quiet placeholders while the Workspaces load", () => {
    const html = enterpriseView({ workspaces: { items: [], loaded: false } });
    expect(html).toContain("rail-workspaces-skeleton");
  });

  it("shrinks to chips and icons, with no headings, when collapsed", () => {
    const html = enterpriseView({ collapsed: true });
    expect(html).toContain('data-rail="min"');
    expect(html).not.toContain("rail-badge");
    expect(html).not.toContain("rail-workspaces-title");
    expect(html).not.toContain("rail-agents-title");
    expect(html).toContain('data-testid="workspace-ws_alpha"');
  });

  it("moves the collapse toggle to the header", () => {
    const html = enterpriseView();
    const header = html.slice(html.indexOf('data-testid="rail-brand"'), html.indexOf('data-testid="rail-workspaces"'));
    expect(header).toContain('data-testid="rail-collapse"');
    expect(html.match(/data-testid="rail-collapse"/g)).toHaveLength(1);
  });

  it("starts expanded in the container, where the default shell starts collapsed", () => {
    const html = enterpriseShell(ENTERPRISE_BRAND);
    expect(html).toContain('data-rail="full"');
    expect(html).toContain('data-product-shell="enterprise"');
  });

  it("names the character from the brand setting, not from the product", () => {
    expect(enterpriseShell({ ...ENTERPRISE_BRAND, assistantName: "Hana" })).toContain("Hana");
  });
});

describe.each([
  ["en", "Workspaces"],
  ["id", "Ruang kerja"],
] as const)("the enterprise rail's Workspaces links (%s)", (locale, accountLabel) => {
  beforeEach(() => {
    applyLocale(locale);
  });

  it("has one link to the Workspaces page itself, from New Workspace; the rows open one Workspace each", () => {
    for (const collapsed of [false, true]) {
      const html = enterpriseView({ collapsed });
      const toPage = html.match(/<a\b[^>]*\shref="\/projects"[^>]*>/g) ?? [];
      expect(toPage, `collapsed=${collapsed}`).toHaveLength(1);
      expect(toPage[0], `collapsed=${collapsed}`).toContain('data-testid="rail-new-workspace"');
      const section = html.slice(html.indexOf('data-testid="rail-workspaces"'), html.indexOf('data-tour="rail-modes"'));
      expect(section, `collapsed=${collapsed}`).toContain('data-testid="rail-new-workspace"');
      expect(html, `collapsed=${collapsed}`).not.toContain('data-testid="projects-link"');
      const labelled = html.match(new RegExp(`<a\\b[^>]*aria-label="${accountLabel}"`, "g")) ?? [];
      expect(labelled, `collapsed=${collapsed}`).toHaveLength(0);
      expect(html.toLowerCase(), `collapsed=${collapsed}`).not.toContain("nultron");
    }
  });
});

describe("the enterprise shell carries nothing of the default brand", () => {
  const forbidden = [
    "nultron",
    "brand-art",
    "/brand/logo",
    "mark-24",
    "mark-32",
    "desk-buddy",
    "chat-mascot",
    "mascot",
  ];

  function expectClean(html: string) {
    const lower = html.toLowerCase();
    for (const word of forbidden) {
      expect(lower, word).not.toContain(word);
    }
    for (const img of html.match(/<img[^>]*>/g) ?? []) {
      expect(img.toLowerCase()).not.toMatch(/nultron|brand|mark-/);
    }
  }

  it("can see the default brand in the default shell, so a clean result means something", () => {
    const html = inRouter("/chat", <AgentRail visibleModes={[]} />).toLowerCase();
    expect(html).toContain("desk-buddy");
    expect(renderToStaticMarkup(<BrandMark size={32} />).toLowerCase()).toContain("mark-32");
  });

  it("draws the whole shell without it, in English", () => {
    expectClean(enterpriseShell(ENTERPRISE_BRAND));
  });

  it("draws the whole shell without it, in Indonesian", () => {
    applyLocale("id");
    expectClean(enterpriseShell(ENTERPRISE_BRAND));
  });

  it("draws the rail with Workspaces without it", () => {
    expectClean(enterpriseView());
    expectClean(enterpriseView({ collapsed: true }));
  });

  it("falls back to a neutral monogram when the logo is the bundled one", () => {
    const html = enterpriseView();
    expect(html).toContain("agent-rail-brand-monogram");
    expect(html).not.toContain("<img");
  });

  it("shows the brand's own logo when it supplies one", () => {
    const html = enterpriseView({ logoSrc: "https://cdn.example.test/acme.png", bundledMark: false });
    expect(html).toContain('src="https://cdn.example.test/acme.png"');
    expect(html).not.toContain("agent-rail-brand-monogram");
  });

  it("does not print the default product name when the host never set one", () => {
    const html = enterpriseShell({ ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC, shell: "enterprise" });
    expectClean(html);
    expect(html).toMatch(/data-testid="rail-brand-name"[^>]*>Company</);
  });

  it("hides the character and the brand mark wherever they would have been drawn", () => {
    const inEnterprise = (node: ReactNode) =>
      renderToStaticMarkup(<BrandContext.Provider value={ENTERPRISE_BRAND}>{node}</BrandContext.Provider>);
    expect(inEnterprise(<NultronMascot state="idle" />)).toBe("");
    const mark = inEnterprise(<BrandMark size={32} testId="mark" alt="Acme Desk" />);
    expect(mark).not.toContain("<img");
    expect(mark).toContain("AD");
  });

  it("still draws the character and the mark in the default shell", () => {
    expect(renderToStaticMarkup(<NultronMascot state="idle" />)).toContain("chat-mascot");
    expect(renderToStaticMarkup(<BrandMark size={32} />)).toContain("<img");
  });
});

const CLOSED_GATE: GatewayGatePayload = {
  status: "needs_key",
  allowed: false,
  grace: false,
  endpoint: "https://gateway.example.test/v1",
  endpointLocked: true,
  checkedAt: null,
  lastOkAt: null,
};

function enterpriseChat(brand: ProductBrand = ENTERPRISE_BRAND): string {
  return inRouter(
    "/chat",
    <BrandContext.Provider value={brand}>
      <ChatLauncher />
    </BrandContext.Provider>,
  );
}

function headingCount(html: string): number {
  return (html.match(/<h1[\s>]/g) ?? []).length;
}

function greetingOf(html: string): string {
  return html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] ?? "";
}

describe("the enterprise empty chat is one heading and the composer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGateStateForTests();
  });

  it("draws the greeting and nothing else while the gate is open", () => {
    const html = enterpriseChat();
    expect(testIds(html)).toEqual(["chat-empty", "chat-empty-greeting"]);
    expect(headingCount(html)).toBe(1);
  });

  it("draws no ideas grid, speech bubble, hero, mascot or orb", () => {
    const ids = testIds(enterpriseChat());
    for (const id of [
      "chat-suggestions",
      "chat-suggestion",
      "chat-ideas-hint",
      "chat-hero",
      "chat-hero-bubble",
      "chat-hero-mascot",
      "chat-hero-orb",
      "chat-mascot",
    ]) {
      expect(ids, id).not.toContain(id);
    }
    expect(enterpriseChat()).not.toMatch(/class="[^"]*\bchat-hero-orb\b/);
    expect(enterpriseChat()).not.toContain("confetti");
  });

  it("shows the key status only while the gate is closed", () => {
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
    publishGate(CLOSED_GATE);
    const html = enterpriseChat();
    expect(testIds(html)).toEqual([
      "chat-empty",
      "chat-empty-greeting",
      "chat-key-status",
      "chat-empty-settings",
      "chat-whats-this",
    ]);
    expect(html).toContain('data-needs-key="true"');
    expect(headingCount(html)).toBe(1);
  });

  it("names the greeting after the brand's character when it has one", () => {
    expect(greetingOf(enterpriseChat({ ...ENTERPRISE_BRAND, assistantName: "Hana" }))).toContain("Hana");
  });

  it("falls back to the enterprise name, never to the default product's", () => {
    const html = enterpriseChat({ ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC, shell: "enterprise" });
    expect(greetingOf(html)).toContain("Company");
    expect(html.toLowerCase()).not.toContain("nultron");
    applyLocale("id");
    expect(greetingOf(enterpriseChat({ ...DEFAULT_PRODUCT_BRAND, shell: "enterprise" }))).toContain("Perusahaan");
  });

  it("keeps the ideas, the hero and the character in the default shell", () => {
    const ids = testIds(enterpriseChat(DEFAULT_PRODUCT_BRAND));
    expect(ids).toContain("chat-suggestions");
    expect(ids).toContain("chat-hero");
    expect(ids).toContain("chat-hero-mascot");
  });
});

describe("the enterprise chat column and rail are CSS scoped to the enterprise look", () => {
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const globals = readFileSync(join(webDir, "app", "globals.css"), "utf8").replace(/\r\n/g, "\n");
  const rail = readFileSync(join(webDir, "components", "agent-rail.css"), "utf8").replace(/\r\n/g, "\n");

  function ruleBody(source: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(source)?.[1] ?? "";
  }

  it("centres the message list in a 760px column, keeping the scrollbar at the pane edge", () => {
    const body = ruleBody(
      globals,
      'html[data-product-shell="enterprise"] .agent-chat-main [data-testid="message-list"]',
    );
    expect(body).toContain("padding-inline: max(var(--chat-gutter), calc((100% - 760px) / 2));");
  });

  it("centres the composer on the same 760px column", () => {
    const body = ruleBody(globals, 'html[data-product-shell="enterprise"] .agent-chat-main .chat-composer-ledge');
    expect(body).toContain("max-width: calc(760px + 2 * var(--chat-gutter));");
    expect(body).toContain("margin-inline: auto;");
  });

  it("draws the enterprise workspace chips as quiet rows, not one tone each", () => {
    expect(ruleBody(rail, '.agent-rail[data-look="enterprise"] .agent-rail-ws-chip')).toContain(
      "background: var(--rail-hover);",
    );
  });

  it("draws the active generalist without the mode ring in the enterprise rail", () => {
    expect(ruleBody(rail, '.agent-rail[data-look="enterprise"] .agent-rail-generalist[aria-current="page"]')).toContain(
      "box-shadow: none;",
    );
  });
});
