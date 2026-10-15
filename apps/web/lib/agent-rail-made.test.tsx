import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { VirtualAgentInfo } from "./virtual-agents";
import type { MadeAgent } from "./virtual-agents-made";

function agent(id: VirtualAgentInfo["id"], over: Partial<VirtualAgentInfo> = {}): VirtualAgentInfo {
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
    ...over,
  };
}

const AGENTS = [agent("chat"), agent("research")];
const INVOICES: MadeAgent = { id: "ag_1", name: "Invoices", description: "Checks invoices", deletable: true };
const OLD: MadeAgent = { id: "ag_2", name: "Old", description: "", deletable: false };

function markup(over: Partial<AgentRailViewProps> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AgentRailView
        agents={AGENTS}
        loaded
        activeId="research"
        pathname="/chat"
        productName="Acme Desk"
        logoSrc=""
        bundledMark={false}
        collapsed={false}
        made={[INVOICES, OLD]}
        onRequestDelete={() => undefined}
        {...over}
      />
    </MemoryRouter>,
  );
}

function links(html: string): string[] {
  return html.match(/<a [^>]*>/g) ?? [];
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

function anchorOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) {
    return "";
  }
  const start = html.lastIndexOf("<a ", at);
  return html.slice(start, html.indexOf("</a>", at) + 4);
}

function agentLinkIds(html: string): Array<string | null> {
  return links(html.slice(0, html.indexOf('data-testid="rail-account-group"'))).map((tag) => attr(tag, "data-testid"));
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("AgentRailView made agents", () => {
  it("draws each made agent under the default agent and above the mode agents", () => {
    expect(agentLinkIds(markup())).toEqual([
      "mode-chat",
      "agent-made-ag_1",
      "agent-made-ag_2",
      "agent-research",
    ]);
  });

  it("draws no New agent entry on the default shell", () => {
    expect(markup()).not.toContain('data-testid="rail-new-agent"');
  });

  it("links each made agent to its own chat and names it for the agent", () => {
    const html = markup();
    const invoices = anchorOf(html, "agent-made-ag_1");
    expect(attr(invoices, "href")).toBe("/chat?made=ag_1");
    expect(attr(invoices, "aria-label")).toBe("Invoices");
    expect(invoices).toContain('agent-rail-label">Invoices</span>');
    expect(attr(anchorOf(html, "agent-made-ag_2"), "href")).toBe("/chat?made=ag_2");
  });

  it("marks the made agent whose chat is open as the current page, and no mode agent", () => {
    const html = markup({ activeId: null, activeMadeId: "ag_1" });
    const current = links(html)
      .filter((tag) => attr(tag, "aria-current") === "page")
      .map((tag) => attr(tag, "data-testid"));
    expect(current).toEqual(["agent-made-ag_1"]);
  });

  it("gives a deletable made agent a More button named for it, and a non-deletable one none", () => {
    const html = markup();
    expect(html).toContain('data-testid="made-agent-more-ag_1"');
    expect(html).toContain('aria-label="More for Invoices"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="made-agent-more-ag_2"');
  });

  it("draws no More button without a delete handler, or when the rail is collapsed", () => {
    expect(markup({ onRequestDelete: undefined })).not.toContain('data-testid="made-agent-more-ag_1"');
    expect(markup({ collapsed: true })).not.toContain('data-testid="made-agent-more-ag_1"');
  });

  it("keeps Delete out of the markup until the More menu is opened", () => {
    const html = markup();
    expect(html).not.toContain('data-testid="made-agent-menu-ag_1"');
    expect(html).not.toContain('data-testid="made-agent-delete-ag_1"');
  });
});

const ENTERPRISE: Partial<AgentRailViewProps> = { look: "enterprise" };

describe("AgentRailView New agent entry", () => {
  it("links New agent to /agents/new, after the mode agents", () => {
    const tag = anchorOf(markup(ENTERPRISE), "rail-new-agent");
    expect(attr(tag, "href")).toBe("/agents/new");
    expect(attr(tag, "aria-label")).toBe("New agent");
  });

  it("shows its words on the expanded rail and only its title when collapsed", () => {
    expect(anchorOf(markup(ENTERPRISE), "rail-new-agent")).toContain('agent-rail-label">New agent</span>');
    const collapsed = anchorOf(markup({ ...ENTERPRISE, collapsed: true }), "rail-new-agent");
    expect(collapsed).toContain('title="New agent"');
    expect(collapsed).not.toContain("agent-rail-label");
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    expect(attr(anchorOf(markup(ENTERPRISE), "rail-new-agent"), "aria-label")).toBe("Agen baru");
  });

  it("is drawn on an empty list too, so a person with no made agents can still make one", () => {
    expect(anchorOf(markup({ ...ENTERPRISE, made: [] }), "rail-new-agent")).not.toBe("");
  });
});
