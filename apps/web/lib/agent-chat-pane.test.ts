import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * How the agent pane is wired, pinned against its source (the pane is JSX with hooks and this package's
 * vitest run is node-only, so the wiring is read as text, as `chat-tier-wiring.test.ts` does).
 *
 * The rule (owner, 2026-10-09): every virtual agent is a full chat. There is no separate studio pane;
 * an agent whose own harness runs from its studio gets a way in on its empty conversation, nothing more.
 */
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const pane = readFileSync(join(web, "components/agent-chat-pane.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("the agent pane", () => {
  it("renders one chat session for every agent, with no studio pane of its own", () => {
    expect(pane.match(/<ChatSession\b/g)).toHaveLength(1);
    expect(pane).not.toContain("agent-studio");
    expect(pane).not.toContain("StudioAgent");
  });

  it("names the default agent for the brand's character and every other agent for its mode", () => {
    expect(pane).toContain("virtualAgentName(agent, assistantNameOf(brand))");
  });

  it("hands over the studio way in only for a studio agent that is not the default one", () => {
    expect(pane).toMatch(/const openStudio =\s*agent\.conversation === "studio" && !agent\.generalist\s*\?/);
    expect(pane).toContain("studioHref(agentKey)");
    // The same way in goes to the empty conversation and to the panel, which stays after the first message.
    expect(pane).toContain("onOpenStudio: openStudio");
    // Lazy, not `[^>]*`: the panel's `onClose` is an arrow function, and its `>` is not the tag's end.
    expect(pane).toMatch(/<AgentHarnessPanel[\s\S]*?onOpenStudio=\{openStudio\}[\s\S]*?\/>/);
  });

  it("keys the session by agent, so each agent keeps its own threads and live state", () => {
    expect(pane).toMatch(/key=\{agent\.id\}/);
  });
});
