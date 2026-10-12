/**
 * The Virtual agents page: the list arithmetic behind Hire and Let go, and the page body in node.
 *
 * Node has no DOM, so presses are not simulated. `nextDeskModes` is the decision a press makes and is
 * tested as a pure function; `VirtualAgentsView` is the markup with the data handed in, which holds the
 * contract a person sees: the generalist cannot be let go, every other desk agent can, every available
 * agent can be hired, and no desk create, switch, rename or delete control is drawn. The wiring to the
 * host (the `PATCH` the Workspaces page also sends) is read from the source.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_MODES, type ProductMode } from "@agentforge/core/product-modes";
import { nextDeskModes, VirtualAgentsView, type VirtualAgentsViewProps } from "@/components/virtual-agents-page";
import { applyLocale, resetLocaleForTests } from "./i18n";
import type { VirtualAgentInfo } from "./virtual-agents";

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(here, "../components/virtual-agents-page.tsx"), "utf8").replace(/\r\n/g, "\n");

function agent(id: ProductMode, over: Partial<VirtualAgentInfo> = {}): VirtualAgentInfo {
  return {
    id,
    generalist: id === "chat",
    conversation: "harness",
    agentId: id === "chat" ? "agent-chat" : `agent-${id}`,
    loop: "agent",
    tools: [],
    budget: { maxSteps: 8, maxToolCalls: 8 },
    repairRounds: 1,
    skills: [
      { id: "a", name: "A", status: "has" },
      { id: "b", name: "B", status: "off" },
    ],
    ...over,
  };
}

function view(over: Partial<VirtualAgentsViewProps> = {}): string {
  const props: VirtualAgentsViewProps = {
    agents: [agent("chat"), agent("research"), agent("documents", { conversation: "studio", agentId: null })],
    available: [agent("finance", { agentId: null }), agent("legal", { agentId: null })],
    busyId: null,
    error: null,
    productName: "Acme",
    onHire: () => undefined,
    onLetGo: () => undefined,
    ...over,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <VirtualAgentsView {...props} />
    </MemoryRouter>,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

beforeEach(() => applyLocale("en"));
afterEach(() => resetLocaleForTests());

describe("nextDeskModes", () => {
  const order = PRODUCT_MODES.map((mode) => mode.id);

  it("hires in catalog order, wherever the mode lands", () => {
    const next = nextDeskModes(["chat", "presentations"], "research", "hire");
    expect(next).toEqual(order.filter((id) => ["chat", "research", "presentations"].includes(id)));
    expect(next.indexOf("research")).toBeLessThan(next.indexOf("presentations"));
  });

  it("lets go by removing the mode and nothing else", () => {
    expect(nextDeskModes(["chat", "research", "documents"], "research", "letGo")).toEqual(
      order.filter((id) => id === "chat" || id === "documents"),
    );
  });

  it("never removes chat", () => {
    expect(nextDeskModes(["chat", "research"], "chat", "letGo")).toEqual(["chat", "research"]);
    expect(nextDeskModes(["research"], "research", "letGo")).toEqual(["chat"]);
  });

  it("adds chat when the desk's list lacks it", () => {
    expect(nextDeskModes(["research"], "documents", "hire")).toContain("chat");
  });

  it("is a no-op when the agent is already there (hire) or already gone (let go)", () => {
    expect(nextDeskModes(["chat", "research"], "research", "hire")).toEqual(["chat", "research"]);
    expect(nextDeskModes(["chat", "research"], "finance", "letGo")).toEqual(["chat", "research"]);
  });

  it("does not change the list it was given", () => {
    const current: ProductMode[] = ["chat", "research"];
    nextDeskModes(current, "finance", "hire");
    nextDeskModes(current, "research", "letGo");
    expect(current).toEqual(["chat", "research"]);
  });
});

describe("VirtualAgentsView", () => {
  it("is the Virtual agents page, with its lede", () => {
    const html = view();
    expect(html).toContain('data-testid="virtual-agents-page"');
    expect(html).toContain('data-mode="workspaces"');
    expect(html).toContain("Virtual agents");
    expect(html).toContain("Hire the ones your work needs.");
  });

  it("gives the generalist no let-go button and every other desk agent one", () => {
    const html = view();
    expect(count(html, 'data-testid="agent-let-go"')).toBe(2);
    expect(count(html, 'data-testid="agent-always"')).toBe(1);
    expect(html).toContain("Always on your desk");
    expect(html).not.toContain('aria-label="Let Acme go"');
    expect(html).toContain('aria-label="Let Research go"');
    expect(html).toContain('aria-label="Let Documents go"');
  });

  it("names the generalist after the product, not a brand typed in the page", () => {
    const html = view();
    expect(html).toContain("Acme");
    expect(pageSource).not.toMatch(/Nultron|Toko Token|TokenKu|HYP AI|Hypey/);
  });

  it("gives every available agent a hire button", () => {
    const html = view();
    expect(count(html, 'data-testid="agent-hire"')).toBe(2);
    expect(html).toContain('aria-label="Hire Finance"');
    expect(html).toContain('aria-label="Hire Legal"');
  });

  it("draws one card per agent, each in its own mode colour", () => {
    const html = view();
    expect(count(html, 'data-testid="agent-card"')).toBe(5);
    expect(html).toContain('data-agent="research"');
    expect(html).toContain('data-mode="research"');
    expect(html).toContain('data-mode="finance"');
  });

  it("says whether an agent converses or opens a studio, and how many skills it has", () => {
    const html = view();
    expect(html).toContain(">Own harness in chat<");
    expect(html).toContain(">Own harness in studio<");
    // One of the two fixture skills is off.
    expect(html).toContain("1 skill");
  });

  it("labels every Open link as a message to the agent, a studio agent included", () => {
    const html = view();
    expect(html).toContain('aria-label="Message Documents"');
    expect(html).toContain('aria-label="Message Research"');
    expect(html).not.toContain("Open the Documents studio");
  });

  it("links each desk agent to its conversation", () => {
    const html = view();
    expect(html).toContain('href="/chat"');
    expect(html).toContain('href="/chat?agent=research"');
  });

  it("shows the empty line when nothing is left to hire", () => {
    const html = view({ available: [] });
    expect(html).toContain("Every agent is already on your desk.");
    expect(html).not.toContain('data-testid="agent-hire"');
  });

  it("holds back both lists until the catalog has answered", () => {
    const html = view({ loaded: false, agents: [], available: [] });
    expect(html).not.toContain("Every agent is already on your desk.");
    expect(html).not.toContain('data-testid="agent-card"');
  });

  it("shows the busy word on the pressed button and disables every button", () => {
    const html = view({ busyId: "finance" });
    expect(html).toContain(">Hiring<");
    expect(count(html, "disabled")).toBe(4);
    const letting = view({ busyId: "research" });
    expect(letting).toContain(">Letting go<");
  });

  it("shows a failure as an alert", () => {
    const html = view({ error: "Could not update your agents." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not update your agents.");
  });

  it("offers no desk create, switch, rename or delete control", () => {
    const html = view();
    expect(html).not.toContain("Workspaces");
    expect(html).not.toMatch(
      /create-new-workspace|open-workspace|edit-workspace-modes|workspace-name|delete-workspace/,
    );
  });
});

describe("the page's request", () => {
  it("saves with the PATCH the Workspaces page sends, keeping the desk's name", () => {
    expect(pageSource).toMatch(/apiFetch\(`\/api\/v1\/workspaces\/\$\{desk\.id\}`/);
    expect(pageSource).toContain('method: "PATCH"');
    expect(pageSource).toContain("JSON.stringify({ name: desk.name, productModes: modes })");
  });

  it("reads the catalog again, tells the rail and refreshes the shell after a save", () => {
    expect(pageSource).toContain("await loadCatalog()");
    expect(pageSource).toContain("notifyVirtualAgentsChanged()");
    expect(pageSource).toContain("router.refresh()");
  });
});
