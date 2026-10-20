/**
 * The chat-first rail's drawing, through its pure view: the agents the host named in the order it
 * named them, the active one, the account links with the test ids the recipes use, and the skeleton
 * drawn before the host has answered. Layout (the 64 px column, the tooltip, the scroller) is CSS a
 * node run cannot measure; it is checked live.
 */
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { VirtualAgentInfo } from "./virtual-agents";

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

const AGENTS = [agent("chat"), agent("research"), agent("documents", { conversation: "studio", agentId: null })];

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
        {...over}
      />
    </MemoryRouter>,
  );
}

/** Every `<a ...>` opening tag in the markup, in order. */
function links(html: string): string[] {
  return html.match(/<a [^>]*>/g) ?? [];
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

/** What a person can read or hear: the text nodes and the aria-label and title values, not test ids. */
function wording(html: string): string {
  const labels = [...html.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((match) => match[1]);
  return [html.replace(/<[^>]*>/g, " "), ...labels].join(" ");
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("AgentRailView agents", () => {
  it("draws one link per agent in the given order, the generalist first", () => {
    const html = markup();
    const agentLinks = links(html.slice(0, html.indexOf('data-testid="rail-account-group"')));
    expect(agentLinks.map((tag) => attr(tag, "data-testid"))).toEqual([
      "mode-chat",
      "agent-research",
      "agent-documents",
    ]);
    expect(agentLinks.map((tag) => attr(tag, "href"))).toEqual([
      "/chat",
      "/chat?agent=research",
      "/chat?agent=documents",
    ]);
  });

  it("names each agent: the product name for the generalist, the mode's name for the rest", () => {
    const html = markup();
    const byId = (id: string) => links(html).find((tag) => attr(tag, "data-testid") === id) ?? "";
    expect(attr(byId("mode-chat"), "aria-label")).toBe("Acme Desk");
    expect(attr(byId("mode-chat"), "title")).toBeNull();
    const strip = links(markup({ collapsed: true })).find((tag) => attr(tag, "data-testid") === "mode-chat") ?? "";
    expect(attr(strip, "title")).toBe("Acme Desk");
    expect(attr(byId("agent-research"), "aria-label")).toBe("Research");
  });

  it("marks only the active agent as the current page", () => {
    const current = links(markup()).filter((tag) => attr(tag, "aria-current") === "page");
    expect(current.map((tag) => attr(tag, "data-testid"))).toEqual(["agent-research"]);
  });

  it("marks the generalist when it is the active one", () => {
    const current = links(markup({ activeId: "chat" })).filter((tag) => attr(tag, "aria-current") === "page");
    expect(current.map((tag) => attr(tag, "data-testid"))).toEqual(["mode-chat"]);
  });

  it("tags each conversation kind and sets the mode colour hook", () => {
    const html = markup();
    const byId = (id: string) => links(html).find((tag) => attr(tag, "data-testid") === id) ?? "";
    expect(attr(byId("agent-research"), "data-conversation")).toBe("harness");
    expect(attr(byId("agent-documents"), "data-conversation")).toBe("studio");
    expect(attr(byId("agent-documents"), "data-mode")).toBe("documents");
  });

  it("draws the generalist even when the host's list lacks it", () => {
    const tags = links(markup({ agents: [agent("research")] }));
    expect(tags.map((tag) => attr(tag, "data-testid")).slice(0, 2)).toEqual(["mode-chat", "agent-research"]);
  });

  it("draws the bundled mark for the generalist when the brand uses it, else a monogram", () => {
    expect(markup({ bundledMark: true })).toContain("agent-rail-mark");
    expect(markup({ bundledMark: false })).toContain("AD");
    expect(markup({ bundledMark: false, logoSrc: "/flavor.png" })).toContain('src="/flavor.png"');
  });
});

describe("AgentRailView before the host answers", () => {
  it("draws the generalist and three skeleton tiles, no other agent", () => {
    const html = markup({ agents: [], loaded: false, activeId: null });
    expect(html.match(/data-testid="agent-rail-skeleton"/g)).toHaveLength(3);
    expect(links(html).some((tag) => attr(tag, "data-testid") === "mode-chat")).toBe(true);
    expect(html).toContain('aria-busy="true"');
  });

  it("draws no skeleton once loaded, or when a cached list is on hand", () => {
    expect(markup()).not.toContain("agent-rail-skeleton");
    expect(markup({ loaded: false })).not.toContain("agent-rail-skeleton");
  });
});

describe("AgentRailView account group", () => {
  it("lists the five account pages in order with the published test ids", () => {
    const html = markup({ pathname: "/settings", activeId: null });
    const group = html.slice(
      html.indexOf('data-testid="rail-account-group"'),
      html.indexOf('data-testid="rail-footer"'),
    );
    const tags = links(group);
    expect(tags.map((tag) => attr(tag, "data-testid"))).toEqual([
      "mode-knowledge",
      "channels-link",
      "workspaces-link",
      "usage-link",
      "settings-link",
    ]);
    expect(tags.map((tag) => attr(tag, "href"))).toEqual([
      "/knowledge",
      "/channels",
      "/workspaces",
      "/usage",
      "/settings",
    ]);
    expect(tags.filter((tag) => attr(tag, "aria-current") === "page").map((tag) => attr(tag, "data-testid"))).toEqual([
      "settings-link",
    ]);
  });

  it("calls the manage page Virtual agents, and never says Workspaces", () => {
    const html = markup();
    const tag = links(html).find((entry) => attr(entry, "data-testid") === "workspaces-link") ?? "";
    expect(attr(tag, "aria-label")).toBe("Virtual agents");
    expect(wording(html)).not.toMatch(/Workspaces/i);
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const html = markup();
    const tag = links(html).find((entry) => attr(entry, "data-testid") === "workspaces-link") ?? "";
    expect(attr(tag, "aria-label")).toBe("Agen virtual");
    expect(wording(html)).not.toMatch(/Workspaces|Ruang kerja/i);
  });

  it("carries the landmarks the first-run tour and the recipes look for", () => {
    const html = markup({ footer: <span data-testid="footer-stub" /> });
    expect(html).toContain('data-testid="agent-rail"');
    expect(html).toContain('data-tour="rail-modes"');
    expect(html).toContain("data-rail=");
    expect(html).toContain('data-testid="rail-footer"><span data-testid="footer-stub"');
  });
});
