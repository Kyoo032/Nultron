import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  activeAgentId,
  agentIdFromSearch,
  readVirtualAgentCatalog,
  readVirtualAgents,
  studioHref,
  toVirtualAgent,
  virtualAgentHref,
  virtualAgentName,
} from "./virtual-agents";

const research = {
  id: "research",
  generalist: false,
  conversation: "harness",
  agentId: "row-1",
  loop: "pipeline",
  tools: ["research_dossier", "datetime"],
  budget: { maxSteps: 4, maxToolCalls: 4 },
  repairRounds: 1,
  skills: [{ id: "search", name: "Search", status: "has" }],
};

describe("reading the host's agents", () => {
  it("keeps a well-formed row as it is", () => {
    expect(toVirtualAgent(research)).toEqual(research);
  });

  it("drops a row whose id is not a product mode, and anything that is not a row", () => {
    expect(toVirtualAgent({ ...research, id: "payroll" })).toBeNull();
    expect(toVirtualAgent(null)).toBeNull();
    expect(toVirtualAgent("research")).toBeNull();
    expect(readVirtualAgents({ agents: [research, { id: "nope" }, 7] })).toHaveLength(1);
    expect(readVirtualAgents(null)).toEqual([]);
  });

  it("reads an unknown conversation as studio, so an agent never takes messages by mistake", () => {
    expect(toVirtualAgent({ ...research, conversation: "whatever" })?.conversation).toBe("studio");
    expect(toVirtualAgent({ id: "legal" })).toMatchObject({
      conversation: "studio",
      agentId: null,
      tools: [],
      skills: [],
      loop: "none",
    });
  });

  it("reads the desk's agents and the ones it could hire apart", () => {
    const catalog = readVirtualAgentCatalog({ agents: [research], available: [{ id: "legal" }, { id: "nope" }] });
    expect(catalog.agents.map((agent) => agent.id)).toEqual(["research"]);
    expect(catalog.available.map((agent) => agent.id)).toEqual(["legal"]);
  });
});

describe("where an agent lives", () => {
  it("is /chat for the generalist and /chat?agent= for the others", () => {
    expect(virtualAgentHref("chat")).toBe("/chat");
    expect(virtualAgentHref("chat", "t1")).toBe("/chat?thread=t1");
    expect(virtualAgentHref("research")).toBe("/chat?agent=research");
    expect(virtualAgentHref("research", "t1")).toBe("/chat?agent=research&thread=t1");
  });

  it("reads the agent a /chat address names, and falls back to the generalist", () => {
    expect(agentIdFromSearch(new URLSearchParams("agent=research&thread=t1"))).toBe("research");
    expect(agentIdFromSearch(new URLSearchParams("thread=t1"))).toBe("chat");
    expect(agentIdFromSearch(new URLSearchParams("agent=payroll"))).toBe("chat");
  });

  it("marks the agent whose conversation or studio is open, and none on an account page", () => {
    expect(activeAgentId("/chat", new URLSearchParams(""))).toBe("chat");
    expect(activeAgentId("/chat", new URLSearchParams("agent=finance"))).toBe("finance");
    expect(activeAgentId("/legal", new URLSearchParams(""))).toBe("legal");
    expect(activeAgentId("/legal/matters/3", new URLSearchParams(""))).toBe("legal");
    expect(activeAgentId("/settings", new URLSearchParams(""))).toBeNull();
    expect(activeAgentId("/knowledge", new URLSearchParams(""))).toBeNull();
    expect(studioHref("presentations")).toBe("/presentations");
  });
});

describe("an agent's name", () => {
  afterEach(() => resetLocaleForTests());

  it("is the product's own name for the generalist and the specialist role name for others", () => {
    applyLocale("en");
    expect(virtualAgentName({ id: "chat", generalist: true }, "Acme Desk")).toBe("Acme Desk");
    expect(virtualAgentName({ id: "research", generalist: false }, "Acme Desk")).toBe("Research Analyst");
    expect(virtualAgentName({ id: "images", generalist: false }, "Acme Desk")).toBe("Visual Designer");
    applyLocale("id");
    expect(virtualAgentName({ id: "research", generalist: false }, "Acme Desk")).toBe("Analis Riset");
    expect(virtualAgentName({ id: "images", generalist: false }, "Acme Desk")).toBe("Desainer Visual");
  });
});
