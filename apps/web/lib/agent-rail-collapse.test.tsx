import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRail, AgentRailView, type AgentRailViewProps } from "@/components/agent-rail";
import {
  AGENT_RAIL_STATE_KEY,
  RAIL_PHONE_QUERY,
  readStoredRailCollapsed,
  type RailStorage,
  writeStoredRailCollapsed,
} from "./agent-rail-state";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { VirtualAgentInfo } from "./virtual-agents";

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

const AGENTS = [agent("chat"), agent("research")];

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

function memoryStorage(initial: Record<string, string> = {}): RailStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwingStorage: RailStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("rail state storage", () => {
  it("reads nothing as no preference", () => {
    expect(readStoredRailCollapsed(memoryStorage())).toBeNull();
    expect(readStoredRailCollapsed(null)).toBeNull();
  });

  it("round-trips collapsed and expanded", () => {
    const storage = memoryStorage();
    writeStoredRailCollapsed(true, storage);
    expect(readStoredRailCollapsed(storage)).toBe(true);
    writeStoredRailCollapsed(false, storage);
    expect(readStoredRailCollapsed(storage)).toBe(false);
    expect(Object.keys(storage.data)).toEqual([AGENT_RAIL_STATE_KEY]);
  });

  it("ignores a value it did not write", () => {
    expect(readStoredRailCollapsed(memoryStorage({ [AGENT_RAIL_STATE_KEY]: "1" }))).toBeNull();
  });

  it("never throws when the browser refuses storage", () => {
    expect(readStoredRailCollapsed(throwingStorage)).toBeNull();
    expect(() => writeStoredRailCollapsed(true, throwingStorage)).not.toThrow();
  });

  it("names the phone query the stylesheet uses", () => {
    expect(RAIL_PHONE_QUERY).toBe("(max-width: 480px)");
  });
});

describe("AgentRailView collapse", () => {
  it("is the icon strip by default, as the rail always was", () => {
    const html = markup();
    expect(html).toContain('data-rail="min"');
    expect(html).not.toContain("agent-rail-label");
    expect(html).not.toContain("rail-collapse");
    expect(html).not.toContain("rail-expand");
    expect(html).not.toContain("rail-scrim");
  });

  it("offers an Expand button with aria-expanded false when a toggle is given", () => {
    const html = markup({ onToggle: () => undefined });
    const button = html.match(/<button[^>]*data-testid="rail-expand"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="agent-rail-panel"');
    expect(button).toContain('aria-label="Expand navigation"');
    expect(html).toContain('id="agent-rail-panel"');
  });

  it("shows every name beside its icon when expanded, and offers Collapse", () => {
    const html = markup({ collapsed: false, onToggle: () => undefined });
    expect(html).toContain('data-rail="full"');
    const labels = [...html.matchAll(/<span class="agent-rail-label">([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(labels).toContain("Acme Desk");
    expect(labels).toContain("Research");
    expect(labels).toContain("Settings");
    const button = html.match(/<button[^>]*data-testid="rail-collapse"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('aria-expanded="true"');
    expect(button).toContain('aria-label="Collapse navigation"');
  });

  it("draws no title on a row whose name is already printed", () => {
    const html = markup({ collapsed: false });
    expect(html.match(/<a [^>]*>/g)?.some((tag) => tag.includes("title="))).toBe(false);
    const strip = markup();
    expect(strip.match(/<a [^>]*>/g)?.every((tag) => tag.includes("title="))).toBe(true);
  });

  it("keeps every link and test id the same in both states", () => {
    const ids = (html: string) =>
      (html.match(/<a [^>]*>/g) ?? []).map((tag) => tag.match(/data-testid="([^"]*)"/)?.[1]);
    expect(ids(markup({ collapsed: false }))).toEqual(ids(markup()));
  });

  it("draws the drawer's backdrop only for an expanded rail that can be dismissed", () => {
    expect(markup({ collapsed: false })).not.toContain("rail-scrim");
    expect(markup({ onDismiss: () => undefined })).not.toContain("rail-scrim");
    expect(markup({ collapsed: false, onDismiss: () => undefined })).toContain('data-testid="rail-scrim"');
  });
});

describe("AgentRail container", () => {
  it("starts as the icon strip with a toggle", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentRail visibleModes={[]} />
      </MemoryRouter>,
    );
    expect(html).toContain('data-rail="min"');
    expect(html).toContain('data-testid="rail-expand"');
    expect(html).not.toContain("rail-scrim");
  });
});
