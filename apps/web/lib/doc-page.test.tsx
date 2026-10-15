import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DocBody } from "@/components/doc-page/doc-body";
import { DocPageView, type PageState } from "@/components/doc-page/doc-view";
import type { DocPeople } from "@/components/doc-page/doc-format";
import { parseDocPage, DocsError, type DocPage } from "@/lib/docs-client";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PAGE_DIR = resolve(here, "../components/doc-page");

const PEOPLE: DocPeople = {
  me: "user_me",
  nameOf: (userId) => (userId === "user_ana" ? "Ana" : userId === "user_budi" ? "Budi" : null),
};

const DOCUMENT: DocPage = parseDocPage({
  artifactId: "art_1",
  title: "Pricing memo",
  kind: "document",
  headVersion: 5,
  spec: {
    kind: "document",
    title: "Q4 pricing: recommendation",
    theme: "plain",
    titlePage: false,
    sections: [
      {
        id: "s1",
        heading: "1. Summary",
        blocks: [
          { type: "paragraph", text: "We hold the Basic tier." },
          { type: "bullets", items: ["Keep Basic", "Raise Pro"] },
          { type: "quote", text: "Keep it simple." },
          { type: "pageBreak" },
        ],
      },
      {
        id: "s2",
        heading: "2. What competitors charge",
        blocks: [{ type: "table", columns: ["Plan", "Now"], rows: [["Basic", 12]] }],
      },
      { id: "s3", heading: null, blocks: [{ type: "numbered", items: ["First"] }] },
    ],
  },
  sectionAuthors: {
    s1: { version: 4, author: { kind: "person", userId: "user_ana" } },
    s2: { version: 5, author: { kind: "agent", agentId: "research", askedByUserId: "user_budi" } },
  },
  proposals: [],
});

const WORKBOOK: DocPage = parseDocPage({
  artifactId: "art_2",
  title: "Price list",
  kind: "workbook",
  headVersion: 2,
  spec: {
    kind: "workbook",
    title: "Price list",
    theme: "plain",
    sheets: [
      {
        id: "sheet1",
        name: "Plans",
        columns: [
          { key: "plan", header: "Plan", type: "text" },
          { key: "price", header: "Price", type: "currency" },
        ],
        rows: [{ plan: "Basic", price: 12 }],
        totals: false,
        freezeHeader: true,
      },
    ],
  },
  sectionAuthors: { sheet1: { version: 2, author: { kind: "person", userId: "user_ana" } } },
  proposals: [],
});

function bodyMarkup(doc: DocPage): string {
  return renderToStaticMarkup(<DocBody doc={doc} people={PEOPLE} />);
}

function viewMarkup(page: PageState, workspace: { id: string; name: string } | null = null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DocPageView
        page={page}
        people={PEOPLE}
        workspace={workspace}
        tab="ask"
        onTab={() => undefined}
        versions={{ status: "idle", items: [] }}
        download={{ busy: false, failed: false }}
        onDownload={() => undefined}
        onDownloadVersion={() => undefined}
        onRetry={() => undefined}
      />
    </MemoryRouter>,
  );
}

function sourceFiles(): string[] {
  const names = readdirSync(DOC_PAGE_DIR).filter((name) => /\.(tsx?|css)$/.test(name));
  return names.map((name) => readFileSync(resolve(DOC_PAGE_DIR, name), "utf8"));
}

function catalogs(): string[] {
  return ["en", "id"].map((locale) => readFileSync(resolve(here, `../locales/${locale}/docpage.json`), "utf8"));
}

describe("document page body", () => {
  it("renders every section, the title and the blocks as elements", () => {
    const markup = bodyMarkup(DOCUMENT);
    expect(markup).toContain("<h1");
    expect(markup).toContain("Q4 pricing: recommendation");
    expect(markup).toContain("1. Summary");
    expect(markup).toContain("We hold the Basic tier.");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<blockquote");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain("<table");
    expect(markup).toContain("<ol");
  });

  it("marks a person's section with the initials and the Last edited by tooltip", () => {
    const markup = bodyMarkup(DOCUMENT);
    expect(markup).toContain('title="Last edited by Ana"');
    expect(markup).toContain(">AN<");
  });

  it("marks an agent's section with the agent name and who asked for it", () => {
    const markup = bodyMarkup(DOCUMENT);
    expect(markup).toContain("Research · asked by Budi");
    expect(markup).toContain('title="Last edited by Research, asked by Budi"');
    expect(markup).toContain('data-author="agent"');
  });

  it("keeps a clean action slot on every section for the next edit tools", () => {
    const markup = bodyMarkup(DOCUMENT);
    expect(markup.match(/data-slot="section-actions"/g)?.length).toBe(3);
    expect(markup.match(/data-section-id="s[123]"/g)?.length).toBe(3);
  });

  it("names an unnamed colleague by a code, never by an account id", () => {
    const unnamed: DocPeople = { me: null, nameOf: () => null };
    const markup = renderToStaticMarkup(<DocBody doc={DOCUMENT} people={unnamed} />);
    expect(markup).toContain('title="Last edited by Colleague USERAN"');
    expect(markup).not.toContain("user_ana");
  });

  it("shows a workbook as one table per sheet", () => {
    const markup = bodyMarkup(WORKBOOK);
    expect(markup).toContain('data-kind="workbook"');
    expect(markup).toContain("Plans");
    expect(markup).toContain("<th");
    expect(markup).toContain("Basic");
    expect(markup).toContain('class="doc-num"');
    expect(markup).toContain('title="Last edited by Ana"');
  });
});

describe("document page states", () => {
  it("shows loading", () => {
    expect(viewMarkup({ status: "loading" })).toContain("Opening the document…");
  });

  it("shows not found, or not a member, for a 404", () => {
    const markup = viewMarkup({ status: "failed", error: new DocsError("not_found", "x", 404) });
    expect(markup).toContain("Not found, or you are not a member of this Workspace.");
    expect(markup).not.toContain("Try again");
  });

  it("shows the not editable sentence for a 409", () => {
    const markup = viewMarkup({ status: "failed", error: new DocsError("not_editable", "x", 409) });
    expect(markup).toContain("This file can&#x27;t be opened as a document.");
  });

  it("offers a retry for any other failure", () => {
    const markup = viewMarkup({ status: "failed", error: null });
    expect(markup).toContain("The document could not be loaded.");
    expect(markup).toContain("Try again");
  });

  it("links back to the Workspace by name, and shows the version and the panel tabs", () => {
    const markup = viewMarkup({ status: "ready", doc: DOCUMENT }, { id: "ws_1", name: "Q4 pricing deck" });
    expect(markup).toContain("Back to Q4 pricing deck");
    expect(markup).toContain('href="/projects"');
    expect(markup).toContain("version 5");
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("Ask an agent");
    expect(markup).toContain("Versions");
    expect(markup).toContain('data-slot="agent-panel"');
  });

  it("without a Workspace, goes back to Chat", () => {
    const markup = viewMarkup({ status: "ready", doc: DOCUMENT });
    expect(markup).toContain("Back to Chat");
    expect(markup).toContain('href="/chat"');
  });
});

describe("document page leaves no Nultron on screen", () => {
  it("renders no Nultron in any text, alt, class, title or aria of the page", () => {
    const markups = [
      bodyMarkup(DOCUMENT),
      bodyMarkup(WORKBOOK),
      viewMarkup({ status: "ready", doc: DOCUMENT }, { id: "ws_1", name: "Q4 pricing deck" }),
      viewMarkup({ status: "loading" }),
      viewMarkup({ status: "failed", error: null }),
    ];
    for (const markup of markups) {
      expect(markup.toLowerCase()).not.toContain("nultron");
    }
  });

  it("names no Nultron in the page source, its styles or its catalogs", () => {
    for (const text of [...sourceFiles(), ...catalogs()]) {
      expect(text).not.toMatch(/nultron/i);
    }
  });

  it("the catalogs are registered and speak English", () => {
    resetLocaleForTests();
    applyLocale("en");
    expect(viewMarkup({ status: "loading" })).toContain("Opening the document");
  });
});
