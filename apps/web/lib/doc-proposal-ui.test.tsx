import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DocAskPanel, type AskDraft } from "@/components/doc-page/doc-ask-panel";
import { ProposalBlock } from "@/components/doc-page/doc-proposal-block";
import { DocPageView, type PageState } from "@/components/doc-page/doc-view";
import type { DocPeople } from "@/components/doc-page/doc-format";
import type { ProposalFailure } from "@/components/doc-page/doc-proposal-flow";
import { VersionsList, type RestoreControls } from "@/components/doc-page/doc-versions";
import { BrandContext, type ProductBrand } from "@/lib/product-brand";
import { parseDocPage, type DocProposal, type DocSection, type DocVersion } from "@/lib/docs-client";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

afterEach(() => {
  resetLocaleForTests();
});

const NEUTRAL_BRAND: ProductBrand = {
  productName: "Desk",
  gatewayName: "Gateway",
  gatewayBaseUrl: "https://gateway.example/v1",
  logoSrc: "",
  assistantName: "Ada",
};

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <BrandContext.Provider value={NEUTRAL_BRAND}>
      <MemoryRouter>{node}</MemoryRouter>
    </BrandContext.Provider>,
  );
}

const PEOPLE: DocPeople = {
  me: "user_me",
  nameOf: (userId) => (userId === "user_budi" ? "Budi" : null),
};

const CURRENT: DocSection = {
  id: "s2",
  heading: "2. What competitors charge",
  blocks: [{ type: "paragraph", text: "Competitors charge roughly the same." }],
};

const PROPOSAL: DocProposal = {
  id: "p1",
  artifactId: "art_1",
  sectionId: "s2",
  section: {
    id: "s2",
    heading: "2. What competitors charge",
    blocks: [{ type: "paragraph", text: "Competitor A lists Pro at 49." }],
  },
  baseVersion: 5,
  agentId: "research",
  askedByUserId: "user_budi",
  status: "pending",
  keptVersion: null,
  createdAt: 1_000,
  updatedAt: 1_000,
};

const DRAFT: AskDraft = { agentId: "chat", sectionId: "s2", instruction: "" };

const AGENTS = [
  { id: "chat", label: "Ada" },
  { id: "research", label: "Research" },
];

const SECTIONS = [
  { id: "s1", heading: "1. Summary" },
  { id: "s2", heading: null },
];

function blockProps(overrides: Partial<Parameters<typeof ProposalBlock>[0]> = {}) {
  return {
    proposal: PROPOSAL,
    current: CURRENT,
    agentName: "Research",
    people: PEOPLE,
    busy: null,
    failure: null as ProposalFailure | null,
    onKeep: () => undefined,
    onUndo: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
}

const DOC = parseDocPage({
  artifactId: "art_1",
  title: "Pricing memo",
  kind: "document",
  headVersion: 5,
  spec: {
    kind: "document",
    title: "Q4 pricing",
    theme: "plain",
    titlePage: false,
    sections: [
      { id: "s1", heading: "1. Summary", blocks: [{ type: "paragraph", text: "We hold Basic." }] },
      { id: "s2", heading: "2. What competitors charge", blocks: CURRENT.blocks },
    ],
  },
  sectionAuthors: {},
  proposals: [PROPOSAL],
});

const VERSIONS: DocVersion[] = [
  {
    version: 5,
    kind: "document",
    changedSectionIds: ["s2"],
    baseVersion: 4,
    note: null,
    author: { kind: "agent", agentId: "research", askedByUserId: "user_budi" },
    createdAt: 1_000,
  },
  {
    version: 4,
    kind: "document",
    changedSectionIds: ["s1"],
    baseVersion: 3,
    note: null,
    author: { kind: "person", userId: "user_budi" },
    createdAt: 500,
  },
];

const RESTORE: RestoreControls = { headVersion: 5, busy: false, failure: null, onRestore: () => undefined };

describe("the proposal block", () => {
  it("draws the header, the diff and the three buttons in English", () => {
    applyLocale("en");
    const html = render(<ProposalBlock {...blockProps()} />);
    expect(html).toContain("Research rewrote this section · asked by Budi");
    expect(html).toMatch(/<del[^>]*>Competitors charge roughly the same\.<\/del>/);
    expect(html).toMatch(/<ins[^>]*>Competitor A lists Pro at 49\.<\/ins>/);
    expect(html).toContain(">Keep<");
    expect(html).toContain(">Undo<");
    expect(html).toContain(">Try again<");
  });

  it("shows the working state on the button that is busy and disables the others", () => {
    applyLocale("en");
    const html = render(<ProposalBlock {...blockProps({ busy: "keep" })} />);
    expect(html).toContain("Working…");
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  it("says the section changed since the agent read it, on a 409 section_changed", () => {
    applyLocale("en");
    const html = render(<ProposalBlock {...blockProps({ failure: "section_changed" })} />);
    expect(html).toContain("This section changed since the agent read it.");
    expect(html).toContain(">Try again<");
  });

  it("says models are off and links to Settings on a gateway refusal", () => {
    applyLocale("en");
    const html = render(<ProposalBlock {...blockProps({ failure: "gateway_blocked" })} />);
    expect(html).toContain("Models are off until a key is added.");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Open Settings");
  });
});

describe("the Ask an agent panel", () => {
  it("offers the general assistant under the brand's name and the brought-in agents", () => {
    applyLocale("en");
    const html = render(
      <DocAskPanel
        kind="document"
        sections={SECTIONS}
        agents={AGENTS}
        draft={DRAFT}
        working={false}
        failure={null}
        onDraft={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain(">Ada<");
    expect(html).toContain(">Research<");
    expect(html).toContain(">1. Summary<");
    expect(html).toContain(">Section 2<");
    expect(html).toMatch(/disabled=""[^>]*data-testid="docpage-ask-send"/);
  });

  it("shows the working state while an ask is in flight", () => {
    applyLocale("en");
    const html = render(
      <DocAskPanel
        kind="document"
        sections={SECTIONS}
        agents={AGENTS}
        draft={{ ...DRAFT, instruction: "Use the brochure." }}
        working
        failure={null}
        onDraft={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("The agent is working on this section…");
  });

  it("says models are off, with a link to Settings, on a gateway refusal", () => {
    applyLocale("en");
    const html = render(
      <DocAskPanel
        kind="document"
        sections={SECTIONS}
        agents={AGENTS}
        draft={{ ...DRAFT, instruction: "Use the brochure." }}
        working={false}
        failure="gateway_blocked"
        onDraft={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Models are off until a key is added.");
    expect(html).toContain('href="/settings"');
  });

  it("says the agent is not in the Workspace on agent_not_in_workspace", () => {
    applyLocale("en");
    const html = render(
      <DocAskPanel
        kind="document"
        sections={SECTIONS}
        agents={AGENTS}
        draft={{ ...DRAFT, instruction: "Use the brochure." }}
        working={false}
        failure="agent_not_in_workspace"
        onDraft={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("This agent is not in this Workspace.");
  });

  it("explains that a workbook takes no proposals, and draws no form", () => {
    applyLocale("en");
    const html = render(
      <DocAskPanel
        kind="workbook"
        sections={[]}
        agents={AGENTS}
        draft={DRAFT}
        working={false}
        failure={null}
        onDraft={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("Agents rewrite one section of a document, not a workbook.");
    expect(html).not.toContain("docpage-ask-send");
  });
});

describe("the Versions tab restore action", () => {
  it("offers Restore on every version except the head", () => {
    applyLocale("en");
    const html = render(
      <VersionsList
        state={{ status: "ready", items: VERSIONS }}
        people={PEOPLE}
        busy={false}
        onDownload={() => undefined}
        restore={RESTORE}
      />,
    );
    expect(html.match(/aria-label="Restore version 4"/g)?.length).toBe(1);
    expect(html).not.toContain('aria-label="Restore version 5"');
  });

  it("says the document changed since it was opened on a conflict", () => {
    applyLocale("en");
    const html = render(
      <VersionsList
        state={{ status: "ready", items: VERSIONS }}
        people={PEOPLE}
        busy={false}
        onDownload={() => undefined}
        restore={{ ...RESTORE, failure: "conflict" }}
      />,
    );
    expect(html).toContain("The document changed since you opened it.");
  });
});

describe("the document page with proposals", () => {
  const page: PageState = { status: "ready", doc: DOC };

  it("mounts the ask panel, the proposal in its section, and the restore action, with no Nultron text anywhere", () => {
    applyLocale("en");
    const html = render(
      <DocPageView
        page={page}
        people={PEOPLE}
        workspace={{ id: "ws_1", name: "Launch" }}
        tab="ask"
        onTab={() => undefined}
        versions={{ status: "ready", items: VERSIONS }}
        download={{ busy: false, failed: false }}
        onDownload={() => undefined}
        onDownloadVersion={() => undefined}
        onRetry={() => undefined}
        agentPanel={
          <DocAskPanel
            kind="document"
            sections={SECTIONS}
            agents={AGENTS}
            draft={DRAFT}
            working={false}
            failure={null}
            onDraft={() => undefined}
            onSubmit={() => undefined}
          />
        }
        renderSectionActions={(sectionId) => (sectionId === "s2" ? <ProposalBlock {...blockProps()} /> : null)}
        restore={RESTORE}
      />,
    );
    expect(html).toContain('data-testid="docpage-proposal"');
    expect(html).toContain("Research rewrote this section");
    expect(html).toContain(">Ada<");
    expect(html).not.toMatch(/nultron/i);
  });

  it("the proposal block and the ask panel contain no Nultron text in any language", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      const html = render(
        <>
          <ProposalBlock {...blockProps({ failure: "section_changed" })} />
          <DocAskPanel
            kind="document"
            sections={SECTIONS}
            agents={AGENTS}
            draft={DRAFT}
            working
            failure="gateway_blocked"
            onDraft={() => undefined}
            onSubmit={() => undefined}
          />
          <VersionsList
            state={{ status: "ready", items: VERSIONS }}
            people={PEOPLE}
            busy={false}
            onDownload={() => undefined}
            restore={{ ...RESTORE, failure: "failed" }}
          />
        </>,
      );
      expect(html, locale).not.toMatch(/nultron/i);
    }
  });
});
