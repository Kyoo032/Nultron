/**
 * The agent home and the harness panel, rendered to markup (the renderer's vitest has no DOM, so a
 * press is read from the source: the studio button hands `onOpenStudio` straight to `onClick`).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHarnessPanel } from "@/components/agent-harness-panel";
import { AgentHome } from "@/components/agent-home";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import type { VirtualAgentInfo } from "@/lib/virtual-agents";

const here = dirname(fileURLToPath(import.meta.url));

const RESEARCH: VirtualAgentInfo = {
  id: "research",
  generalist: false,
  conversation: "harness",
  agentId: "agent-research",
  loop: "pipeline",
  tools: ["research_dossier", "datetime"],
  budget: { maxSteps: 4, maxToolCalls: 4 },
  repairRounds: 1,
  skills: [
    { id: "plan-queries", name: "Plan the queries", status: "has" },
    { id: "search", name: "Search", status: "has" },
    { id: "read-pages", name: "Read the pages", status: "has" },
    { id: "verbatim-passages", name: "Pull verbatim passages", status: "has" },
    { id: "write-dossier", name: "Write the dossier", status: "has" },
    { id: "extra-a", name: "Extra A", status: "new" },
    { id: "extra-b", name: "Extra B", status: "new" },
    { id: "hidden", name: "Hidden skill", status: "off" },
  ],
};

const LEGAL: VirtualAgentInfo = {
  id: "legal",
  generalist: false,
  conversation: "studio",
  agentId: null,
  loop: "pipeline",
  tools: [],
  budget: { maxSteps: 6, maxToolCalls: 60 },
  repairRounds: 0,
  skills: [
    { id: "open-matter", name: "Open the matter", status: "has" },
    { id: "verify-then-edit", name: "Verify, then edit", status: "has" },
  ],
};

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("AgentHome", () => {
  it("greets by name with the agent's colour and tagline, and shows the skills", () => {
    const html = renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Research" />);
    expect(html).toContain('data-testid="agent-home"');
    expect(html).toContain('data-mode="research"');
    expect(html).toContain("Hi, I&#x27;m Research.");
    expect(html).toContain("Researches a question on the web");
    expect(html).toContain("Runs on its own harness");
    expect(html).toContain("Plan the queries");
    expect(html).toContain("Write the dossier");
  });

  it("shows at most six skill chips, folds the rest into +N and skips a skill that is off", () => {
    const html = renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Research" />);
    expect(html).toContain("Extra A");
    expect(html).not.toContain("Extra B");
    expect(html).toContain("+1<");
    expect(html).not.toContain("Hidden skill");
  });

  it("has no studio card or button for an agent that takes messages", () => {
    const html = renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Research" />);
    expect(html).not.toContain("agent-open-studio");
    expect(html).not.toContain("agent-home-studio");
  });

  it("shows the studio note and a secondary button for a studio agent that can open its studio", () => {
    const html = renderToStaticMarkup(<AgentHome agent={LEGAL} name="Legal" onOpenStudio={() => {}} />);
    expect(html).toContain('data-mode="legal"');
    expect(html).toContain('data-testid="agent-home-studio"');
    expect(html).toContain("The Legal studio runs its own checks");
    expect(html).toContain('data-testid="agent-open-studio"');
    expect(html).toMatch(/class="btn btn-secondary"[^>]*data-testid="agent-open-studio"/);
    expect(html).toContain("Open the Legal studio");
    expect(html).toContain("Open the matter");
  });

  it("draws no studio note and no button for a studio agent without onOpenStudio", () => {
    const html = renderToStaticMarkup(<AgentHome agent={LEGAL} name="Legal" />);
    expect(html).not.toContain("agent-home-studio");
    expect(html).not.toContain("agent-open-studio");
    expect(html).not.toContain("studio runs its own checks");
  });

  it("draws no studio note for a harness agent even when handed onOpenStudio", () => {
    const html = renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Research" onOpenStudio={() => {}} />);
    expect(html).not.toContain("agent-open-studio");
  });

  it("says on every agent that it does everything else too", () => {
    const chat: VirtualAgentInfo = { ...LEGAL, id: "chat", generalist: true, conversation: "harness" };
    for (const agent of [RESEARCH, LEGAL, chat]) {
      const html = renderToStaticMarkup(<AgentHome agent={agent} name="Name" />);
      expect(html, agent.id).toContain('data-testid="agent-home-everything"');
      expect(html, agent.id).toContain("Ask me anything.");
    }
  });

  it("draws the harness badge only for an agent whose own harness runs in the chat", () => {
    expect(renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Research" />)).toContain(
      'data-testid="agent-home-badge"',
    );
    expect(renderToStaticMarkup(<AgentHome agent={LEGAL} name="Legal" />)).not.toContain("agent-home-badge");
  });

  it("wires the studio button to onOpenStudio", () => {
    const source = readFileSync(resolve(here, "../components/agent-home.tsx"), "utf8");
    expect(source).toMatch(/onClick=\{onOpenStudio\}[\s\S]*data-testid="agent-open-studio"/);
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<AgentHome agent={RESEARCH} name="Riset" />);
    expect(html).toContain("Menulis laporan");
  });

  it("draws the generalist with the chat icon without throwing", () => {
    const chat: VirtualAgentInfo = { ...LEGAL, id: "chat", generalist: true, conversation: "harness" };
    const html = renderToStaticMarkup(<AgentHome agent={chat} name="Assistant" />);
    expect(html).toContain('data-mode="chat"');
  });
});

describe("AgentHarnessPanel", () => {
  it("is a labelled complementary region with a close button", () => {
    const html = renderToStaticMarkup(<AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} />);
    expect(html).toContain('data-testid="agent-harness-panel"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-label="How Research works"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('title="Close"');
    expect(html).not.toContain("autofocus");
  });

  it("lists every skill, including the ones that are new or off, with their marks", () => {
    const html = renderToStaticMarkup(<AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} />);
    expect(html).toContain("Plan the queries");
    expect(html).toContain("Extra B");
    expect(html).toContain("Hidden skill");
    expect(html).toContain(">New<");
    expect(html).toContain(">Not offered<");
  });

  it("names the tools, the limits and the checks", () => {
    const html = renderToStaticMarkup(<AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} />);
    expect(html).toContain("Research dossier");
    expect(html).toContain("Date and time");
    expect(html).toContain("4 model steps a turn");
    expect(html).toContain("4 tool calls a turn");
    expect(html).toContain("1 repair round before it stops");
    expect(html).toContain("The app runs fixed stages");
    expect(html).toContain("A prompt cannot change them.");
  });

  /** The text of one of the panel's two parts, by its test id, up to the next part or the end. */
  function part(html: string, testId: string): string {
    const start = html.indexOf(`data-testid="${testId}"`);
    expect(start, testId).toBeGreaterThan(-1);
    const next = html.indexOf('class="agent-harness-part"', start);
    return next === -1 ? html.slice(start) : html.slice(start, next);
  }

  it("says 'enforced' only of the chat's tools and limits, never of the agent's own skills and checks", () => {
    const html = renderToStaticMarkup(<AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} />);
    const inChat = part(html, "agent-harness-in-chat");
    const own = part(html, "agent-harness-own");
    // What this chat may do: the tools, the limits, and the sentence that they are enforced.
    expect(inChat).toContain("In this chat");
    expect(inChat).toContain('data-testid="agent-harness-tools"');
    expect(inChat).toContain('data-testid="agent-harness-limits"');
    expect(inChat).toContain("The app enforces these tools and limits on every run of this chat.");
    expect(inChat).not.toContain('data-testid="agent-harness-skills"');
    // The agent's own harness: how it works, its skills and its checks, and no claim of enforcement.
    expect(own).toContain("The Research harness");
    expect(own).toContain('data-testid="agent-harness-skills"');
    expect(own).toContain('data-testid="agent-harness-checks"');
    expect(own).toContain('data-testid="agent-harness-loop"');
    expect(own).not.toContain("enforces");
  });

  it("says where the agent's own harness runs: in this chat, or in its studio without these checks", () => {
    const wired = renderToStaticMarkup(<AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} />);
    expect(wired).toContain('data-runs="chat"');
    expect(wired).toContain("Runs in this chat, with its checks.");
    expect(wired).not.toContain("studio");

    const studio = renderToStaticMarkup(<AgentHarnessPanel agent={LEGAL} name="Legal" onClose={() => {}} />);
    expect(studio).toContain('data-runs="studio"');
    expect(studio).toContain(
      "Runs in the Legal studio. In this chat the work is done with the tools above, without these checks.",
    );
    expect(studio).not.toContain("Runs in this chat, with its checks.");
  });

  it("keeps the way into the studio in the panel, where it outlasts the empty conversation", () => {
    const withWay = renderToStaticMarkup(
      <AgentHarnessPanel agent={LEGAL} name="Legal" onClose={() => {}} onOpenStudio={() => {}} />,
    );
    expect(withWay).toContain('data-testid="agent-harness-open-studio"');
    expect(withWay).toContain("Open the Legal studio");
    // No way in is drawn when the caller has none, or for an agent whose harness runs in the chat.
    const without = renderToStaticMarkup(<AgentHarnessPanel agent={LEGAL} name="Legal" onClose={() => {}} />);
    expect(without).not.toContain('data-testid="agent-harness-open-studio"');
    const wired = renderToStaticMarkup(
      <AgentHarnessPanel agent={RESEARCH} name="Research" onClose={() => {}} onOpenStudio={() => {}} />,
    );
    expect(wired).not.toContain('data-testid="agent-harness-open-studio"');
  });

  it("says so when the agent binds no tools and repairs nothing", () => {
    const html = renderToStaticMarkup(<AgentHarnessPanel agent={LEGAL} name="Legal" onClose={() => {}} />);
    expect(html).toContain("No tools to call: the app does the work in fixed stages.");
    expect(html).not.toContain('data-testid="agent-harness-tools"');
    // A step and call budget bounds a tool loop: with no tools there is nothing to bound, so no numbers.
    expect(html).not.toContain('data-testid="agent-harness-limits"');
    expect(html).not.toContain("model steps a turn");
    expect(html).not.toContain("tool calls a turn");
    expect(html).toContain("Checks report; nothing is repaired automatically.");
  });
});
