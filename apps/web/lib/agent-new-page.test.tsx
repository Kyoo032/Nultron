import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentNewView,
  draftFields,
  toDraftState,
  type AgentNewViewProps,
  type DraftState,
} from "@/components/agent-new-page";
import { applyLocale, resetLocaleForTests } from "./i18n";

const DRAFT: DraftState = {
  name: "Invoice checker",
  description: "Checks invoices",
  instructions: "Compare each invoice with its order.",
  baseMode: "finance",
  tools: [
    { key: "calculator", on: true },
    { key: "web_search", on: false },
  ],
  source: "live",
};

function view(over: Partial<AgentNewViewProps> = {}): string {
  const props: AgentNewViewProps = {
    prompt: "",
    onPromptChange: () => undefined,
    onDraft: () => undefined,
    drafting: false,
    draft: null,
    onDraftChange: () => undefined,
    onToolToggle: () => undefined,
    canCreate: false,
    onCreate: () => undefined,
    creating: false,
    failure: null,
    ...over,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <AgentNewView {...props} />
    </MemoryRouter>,
  );
}

function tagOf(html: string, testId: string): string {
  return html.match(new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
}

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("toDraftState and draftFields", () => {
  it("turns every drafted tool on and keeps the draft's source", () => {
    const state = toDraftState({
      draft: {
        name: "Invoice checker",
        description: "Checks invoices",
        instructions: "Compare each invoice with its order.",
        baseMode: "finance",
        tools: ["calculator", "web_search"],
      },
      source: "stub",
    });
    expect(state.tools).toEqual([
      { key: "calculator", on: true },
      { key: "web_search", on: true },
    ]);
    expect(state.source).toBe("stub");
  });

  it("sends the trimmed fields and only the tools that are still on", () => {
    expect(
      draftFields({
        ...DRAFT,
        name: "  Invoice checker ",
        instructions: " Compare each invoice with its order. ",
        tools: [
          { key: "calculator", on: true },
          { key: "web_search", on: false },
        ],
      }),
    ).toEqual({
      name: "Invoice checker",
      description: "Checks invoices",
      instructions: "Compare each invoice with its order.",
      baseMode: "finance",
      tools: ["calculator"],
    });
  });

  it("keeps an empty description as an empty string", () => {
    expect(draftFields({ ...DRAFT, description: "  " })?.description).toBe("");
  });

  it("is null without a name or without instructions", () => {
    expect(draftFields({ ...DRAFT, name: "   " })).toBeNull();
    expect(draftFields({ ...DRAFT, instructions: "" })).toBeNull();
  });
});

describe("AgentNewView before a draft", () => {
  it("puts the one prompt box first and draws no draft yet", () => {
    const html = view();
    expect(html.indexOf('data-testid="agent-new-prompt"')).toBeGreaterThan(-1);
    expect(html).not.toContain('data-testid="agent-new-draft-section"');
    expect(html).not.toContain('data-testid="agent-new-create"');
  });

  it("keeps Draft disabled until the prompt has words", () => {
    expect(tagOf(view(), "agent-new-draft")).toContain("disabled");
    expect(tagOf(view({ prompt: "Check invoices" }), "agent-new-draft")).not.toContain("disabled");
  });

  it("shows Drafting and holds the page while the draft is on its way", () => {
    const html = view({ prompt: "Check invoices", drafting: true });
    expect(html).toContain("Drafting");
    expect(tagOf(html, "agent-new-draft")).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });
});

describe("AgentNewView draft", () => {
  it("lays the editable draft out in order: name, description, instructions, More, then Create", () => {
    const html = view({ draft: DRAFT, canCreate: true, prompt: "Check invoices" });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("agent-new-prompt")).toBeLessThan(at("agent-new-draft-section"));
    expect(at("agent-new-name")).toBeLessThan(at("agent-new-description"));
    expect(at("agent-new-description")).toBeLessThan(at("agent-new-instructions"));
    expect(at("agent-new-instructions")).toBeLessThan(at("agent-new-more"));
    expect(at("agent-new-more")).toBeLessThan(at("agent-new-create"));
  });

  it("fills the fields with the draft's words", () => {
    const html = view({ draft: DRAFT, canCreate: true });
    expect(tagOf(html, "agent-new-name")).toContain('value="Invoice checker"');
    expect(tagOf(html, "agent-new-description")).toContain('value="Checks invoices"');
    expect(html).toContain(">Compare each invoice with its order.</textarea>");
  });

  it("shows the base mode and each tool, with only the kept tools checked", () => {
    const html = view({ draft: DRAFT, canCreate: true });
    expect(html).toContain("Based on");
    expect(tagOf(html, "agent-new-tool-calculator")).toContain("checked");
    expect(tagOf(html, "agent-new-tool-web_search")).not.toContain("checked");
  });

  it("says the draft is only the person's own words when no model is connected", () => {
    expect(view({ draft: { ...DRAFT, source: "stub" } })).toContain('data-testid="agent-new-stub"');
    expect(view({ draft: DRAFT })).not.toContain('data-testid="agent-new-stub"');
  });

  it("keeps Create disabled until the draft has a name and instructions, and while it is saving", () => {
    expect(tagOf(view({ draft: DRAFT, canCreate: false }), "agent-new-create")).toContain("disabled");
    expect(tagOf(view({ draft: DRAFT, canCreate: true }), "agent-new-create")).not.toContain("disabled");
    const saving = view({ draft: DRAFT, canCreate: true, creating: true });
    expect(saving).toContain("Creating");
    expect(tagOf(saving, "agent-new-create")).toContain("disabled");
  });
});

describe("AgentNewView failures", () => {
  it("shows the gateway gate as the needs-key note, not as an alert", () => {
    const html = view({ prompt: "Check invoices", failure: { kind: "gateway" } });
    expect(html).toContain('data-testid="agent-new-needs-key"');
    expect(html).not.toContain('role="alert"');
  });

  it("shows any other failure as one alert with its catalog copy", () => {
    const html = view({ prompt: "Check invoices", failure: { kind: "message", key: "agents.made.error.create" } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not create the agent.");
  });
});
