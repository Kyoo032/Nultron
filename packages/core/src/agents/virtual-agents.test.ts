import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_PROMPT, DEFAULT_CHAT_SLUG, DEFAULT_CHAT_TOOLS } from "./default-chat";
import { FIRST_RUN_MODES, PRODUCT_MODE_IDS, productModeLabel } from "./product-modes";
import { MODE_HARNESS_SPECS } from "../harness/specs";
import {
  CHAT_IDENTITY_SENTENCE,
  GENERALIST_WORKER_PROMPT,
  GENERALIST_WORKER_TOOLS,
  VIRTUAL_AGENTS,
  isVirtualAgentSlug,
  toolKeysWithinVirtualAgent,
  virtualAgentBySlug,
  virtualAgentFor,
  virtualAgentMayCall,
  virtualAgentsForDesk,
} from "./virtual-agents";

describe("virtual agents", () => {
  it("yields exactly one agent per harness spec, and adds none", () => {
    expect(VIRTUAL_AGENTS.map((agent) => agent.id).sort()).toEqual(Object.keys(MODE_HARNESS_SPECS).sort());
    expect(VIRTUAL_AGENTS).toHaveLength(PRODUCT_MODE_IDS.length);
    expect(new Set(VIRTUAL_AGENTS.map((agent) => agent.slug)).size).toBe(VIRTUAL_AGENTS.length);
  });

  it("puts the generalist first, on the default chat's own row and tools", () => {
    const first = VIRTUAL_AGENTS[0];
    expect(first?.id).toBe("chat");
    expect(first?.generalist).toBe(true);
    expect(first?.slug).toBe(DEFAULT_CHAT_SLUG);
    expect(first?.tools).toEqual([...DEFAULT_CHAT_TOOLS, ...GENERALIST_WORKER_TOOLS]);
    expect(VIRTUAL_AGENTS.filter((agent) => agent.generalist)).toHaveLength(1);
  });

  it("lets the default agent run every worker harness, hired or not", () => {
    const generalist = virtualAgentFor("chat");
    // A mode's agent gives its work its own conversations. It is never what makes the work possible.
    expect(GENERALIST_WORKER_TOOLS.length).toBeGreaterThan(0);
    for (const key of GENERALIST_WORKER_TOOLS) {
      expect(generalist.tools, key).toContain(key);
      expect(generalist.prompt, key).toContain(key);
      expect(generalist.budget.perTool?.[key], key).toBeGreaterThan(0);
    }
    // Pictures, clips and decks are its own tools already, with no agent to hire first.
    for (const key of ["image_generate", "video_generate", "build_deck"]) {
      expect(generalist.tools).toContain(key);
    }
  });

  it("gives every agent the same full tool set and budget, so none has to be hired to do a job", () => {
    const generalist = virtualAgentFor("chat");
    expect(generalist.tools).toEqual([...DEFAULT_CHAT_TOOLS, ...GENERALIST_WORKER_TOOLS]);
    for (const agent of VIRTUAL_AGENTS) {
      expect(agent.tools, agent.id).toEqual(generalist.tools);
      expect(agent.budget, agent.id).toEqual(generalist.budget);
      expect(agent.budget.perTool?.research_dossier, agent.id).toBe(2);
      for (const key of [
        "image_generate",
        "video_generate",
        "build_deck",
        "write_file",
        "run_code",
        "web_search",
        "research_dossier",
      ]) {
        expect(agent.tools, `${agent.id} ${key}`).toContain(key);
      }
    }
  });

  it("keeps the published Chat prompt and budget whole, and only adds to them", () => {
    const generalist = virtualAgentFor("chat");
    expect(generalist.prompt.startsWith(DEFAULT_CHAT_PROMPT)).toBe(true);
    expect(generalist.prompt.slice(DEFAULT_CHAT_PROMPT.length)).toBe(GENERALIST_WORKER_PROMPT);
    const spec = MODE_HARNESS_SPECS.chat;
    expect(generalist.budget.maxSteps).toBe(spec.budget.maxSteps);
    expect(generalist.budget.maxToolCalls).toBe(spec.budget.maxToolCalls);
    for (const [key, cap] of Object.entries(spec.budget.perTool ?? {})) {
      expect(generalist.budget.perTool?.[key], key).toBe(cap);
    }
  });

  it("carries each spec's skills and repair rounds unchanged", () => {
    for (const agent of VIRTUAL_AGENTS) {
      const spec = MODE_HARNESS_SPECS[agent.id];
      expect(agent.skills).toBe(spec.skills);
      expect(agent.repairRounds).toBe(spec.repairRounds);
      expect(agent.loop).toBe(spec.loop);
    }
  });

  it("says where an agent's own harness runs: chat and research in the conversation, the rest in a studio", () => {
    for (const agent of VIRTUAL_AGENTS) {
      expect(agent.conversation, agent.id).toBe(agent.id === "chat" || agent.id === "research" ? "harness" : "studio");
    }
  });

  it("gives a studio agent a conversation like every other: the full tools and a prompt", () => {
    const studio = VIRTUAL_AGENTS.filter((agent) => agent.conversation === "studio");
    expect(studio.length).toBeGreaterThan(0);
    for (const agent of studio) {
      expect(agent.tools, agent.id).toEqual(virtualAgentFor("chat").tools);
      expect(agent.prompt, agent.id).not.toBe("");
    }
  });

  it("gives every agent a prompt that names every tool it binds", () => {
    for (const agent of VIRTUAL_AGENTS) {
      expect(agent.tools.length).toBeGreaterThan(0);
      for (const key of agent.tools) {
        expect(agent.prompt, `${agent.id} ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
      }
    }
  });

  it("opens the published Chat prompt with the identity sentence a mode agent swaps for its own", () => {
    // If the published prompt stops opening this way, a mode agent's prompt would carry two identities.
    expect(DEFAULT_CHAT_PROMPT.startsWith(CHAT_IDENTITY_SENTENCE)).toBe(true);
  });

  it("introduces each mode agent in its own words, not as the general assistant", () => {
    for (const agent of VIRTUAL_AGENTS.filter((entry) => !entry.generalist)) {
      const label = productModeLabel(agent.id);
      expect(agent.prompt.startsWith(`You are the ${label} agent on the owner's desk.`), agent.id).toBe(true);
      expect(agent.prompt, agent.id).toContain("You are not limited to your specialty");
      expect(agent.prompt, agent.id).toContain("A Soul block may follow");
      expect(agent.prompt, agent.id).not.toContain(CHAT_IDENTITY_SENTENCE);
      expect(agent.prompt, agent.id).toContain(GENERALIST_WORKER_PROMPT);
    }
  });

  it("gives a mode agent the last word on who is speaking, and the default agent none", () => {
    expect(virtualAgentFor("chat").closing).toBe("");
    for (const agent of VIRTUAL_AGENTS.filter((entry) => !entry.generalist)) {
      const label = productModeLabel(agent.id);
      expect(agent.closing.startsWith(`\n\nWho is speaking: in this chat you are the ${label} agent.`), agent.id).toBe(
        true,
      );
    }
  });

  it("tells a studio agent its studio runs the checked work, and a harness agent nothing of the kind", () => {
    for (const agent of VIRTUAL_AGENTS.filter((entry) => !entry.generalist)) {
      const note = agent.prompt.includes("never say its checks ran here");
      expect(note, agent.id).toBe(agent.conversation === "studio");
    }
  });

  it("an agent can call exactly the tools its entry lists", () => {
    const research = virtualAgentFor("research");
    expect(virtualAgentMayCall(research, "research_dossier")).toBe(true);
    expect(virtualAgentMayCall(research, "write_file")).toBe(true);
    expect(virtualAgentMayCall(research, "run_code")).toBe(true);
    expect(virtualAgentMayCall(research, "not_a_tool")).toBe(false);
    expect(toolKeysWithinVirtualAgent(research, ["write_file", "research_dossier", "not_a_tool"])).toEqual([
      "write_file",
      "research_dossier",
    ]);
    const legal = virtualAgentFor("legal");
    expect(toolKeysWithinVirtualAgent(legal, [...DEFAULT_CHAT_TOOLS])).toEqual([...DEFAULT_CHAT_TOOLS]);
  });

  it("finds an agent by its row slug and tells mode agents from built ones", () => {
    expect(virtualAgentBySlug("va-research")?.id).toBe("research");
    expect(virtualAgentBySlug(DEFAULT_CHAT_SLUG)?.id).toBe("chat");
    expect(virtualAgentBySlug("my-own-agent")).toBeUndefined();
    expect(isVirtualAgentSlug("va-research")).toBe(true);
    expect(isVirtualAgentSlug("va-nothing")).toBe(false);
    expect(isVirtualAgentSlug(DEFAULT_CHAT_SLUG)).toBe(false);
  });

  it("shows a desk its own modes as agents, the generalist always first", () => {
    expect(virtualAgentsForDesk([...FIRST_RUN_MODES]).map((agent) => agent.id)).toEqual([
      "chat",
      "research",
      "images",
      "videos",
      "presentations",
    ]);
    expect(virtualAgentsForDesk(["legal"]).map((agent) => agent.id)).toEqual(["chat", "legal"]);
    expect(virtualAgentsForDesk([]).map((agent) => agent.id)).toEqual(["chat"]);
  });
});
