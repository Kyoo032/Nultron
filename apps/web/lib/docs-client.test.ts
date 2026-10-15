import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-client";
import {
  DocsError,
  docVersionFilePath,
  errorFromPayload,
  importDocPage,
  parseDocPage,
  parseDocVersions,
} from "@/lib/docs-client";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

const DOCUMENT_RESPONSE = {
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
          { type: "chart", series: [1, 2] },
          { type: "bullets", items: ["one", "two"] },
          { type: "numbered", items: ["first"] },
          { type: "quote", text: "Quoted." },
          { type: "pageBreak" },
          {
            type: "table",
            columns: ["Plan", "Now"],
            rows: [
              ["Basic", 12],
              ["Pro", null],
            ],
          },
          { type: "paragraph", text: 7 },
        ],
      },
      { id: "s2", heading: null, blocks: [] },
    ],
  },
  sectionAuthors: {
    s1: { version: 4, author: { kind: "person", userId: "user_ana" } },
    s2: { version: 5, author: { kind: "agent", agentId: "research", askedByUserId: "user_budi" } },
  },
  proposals: [
    {
      id: "p1",
      artifactId: "art_1",
      sectionId: "s2",
      section: { id: "s2", heading: "2. Competitors", blocks: [{ type: "paragraph", text: "New text." }] },
      baseVersion: 5,
      agentId: "research",
      askedByUserId: "user_budi",
      status: "pending",
      keptVersion: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    },
  ],
};

const WORKBOOK_RESPONSE = {
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
          { key: "price", header: "Price", type: "currency", width: 14 },
        ],
        rows: [
          { plan: "Basic", price: 12 },
          { plan: "Pro", price: null },
        ],
        totals: false,
        freezeHeader: true,
      },
    ],
  },
  sectionAuthors: {},
  proposals: [],
};

describe("parseDocPage", () => {
  it("reads the spec, the head version, the section authors and the pending proposals", () => {
    const doc = parseDocPage(DOCUMENT_RESPONSE);
    expect(doc.headVersion).toBe(5);
    expect(doc.kind).toBe("document");
    expect(doc.spec.kind).toBe("document");
    expect(doc.sectionAuthors.s1?.author).toEqual({ kind: "person", userId: "user_ana" });
    expect(doc.sectionAuthors.s2?.author).toEqual({
      kind: "agent",
      agentId: "research",
      askedByUserId: "user_budi",
    });
    expect(doc.proposals.map((proposal) => proposal.id)).toEqual(["p1"]);
    expect(doc.proposals[0]?.section.blocks).toEqual([{ type: "paragraph", text: "New text." }]);
  });

  it("skips a block it does not know and a known block that is malformed, keeping the rest", () => {
    const doc = parseDocPage(DOCUMENT_RESPONSE);
    if (doc.spec.kind !== "document") {
      throw new Error("expected a document");
    }
    const blocks = doc.spec.sections[0]?.blocks ?? [];
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "bullets",
      "numbered",
      "quote",
      "pageBreak",
      "table",
    ]);
    expect(blocks[5]).toEqual({
      type: "table",
      columns: ["Plan", "Now"],
      rows: [
        ["Basic", 12],
        ["Pro", null],
      ],
    });
  });

  it("reads a section without a heading as null", () => {
    const doc = parseDocPage(DOCUMENT_RESPONSE);
    if (doc.spec.kind !== "document") {
      throw new Error("expected a document");
    }
    expect(doc.spec.sections[1]?.heading).toBeNull();
  });

  it("reads a workbook spec with its sheets and cell values", () => {
    const doc = parseDocPage(WORKBOOK_RESPONSE);
    if (doc.spec.kind !== "workbook") {
      throw new Error("expected a workbook");
    }
    expect(doc.spec.sheets[0]?.name).toBe("Plans");
    expect(doc.spec.sheets[0]?.columns[1]).toEqual({ key: "price", header: "Price", type: "currency", width: 14 });
    expect(doc.spec.sheets[0]?.rows[1]).toEqual({ plan: "Pro", price: null });
  });

  it("refuses an answer that is not a document page with a 502 malformed error", () => {
    let caught: unknown = null;
    try {
      parseDocPage({ artifactId: "art_1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocsError);
    expect((caught as DocsError).code).toBe("docs_malformed");
    expect((caught as DocsError).status).toBe(502);
  });
});

describe("parseDocVersions", () => {
  it("reads each version with its author and note", () => {
    const items = parseDocVersions({
      items: [
        {
          version: 2,
          kind: "document",
          changedSectionIds: ["s2"],
          baseVersion: 1,
          note: null,
          author: { kind: "agent", agentId: "research", askedByUserId: "user_budi" },
          createdAt: 2_000,
        },
        {
          version: 1,
          kind: "document",
          changedSectionIds: ["s1", "s2"],
          baseVersion: null,
          note: "Drafted",
          author: { kind: "person", userId: "user_ana" },
          createdAt: 1_000,
        },
      ],
    });
    expect(items.map((item) => item.version)).toEqual([2, 1]);
    expect(items[1]?.note).toBe("Drafted");
    expect(items[0]?.author.kind).toBe("agent");
  });

  it("refuses a versions answer without items", () => {
    expect(() => parseDocVersions({ versions: [] })).toThrow(DocsError);
  });
});

describe("errorFromPayload", () => {
  it("reads the nested envelope's code and message, with the status", () => {
    const error = errorFromPayload({ error: { code: "not_editable", message: "No." } }, 409);
    expect(error.code).toBe("not_editable");
    expect(error.message).toBe("No.");
    expect(error.status).toBe(409);
  });

  it("falls back to a generic code for a flat or empty answer", () => {
    expect(errorFromPayload({ error: "not_found" }, 404).code).toBe("docs_error");
    expect(errorFromPayload(null, 500).status).toBe(500);
  });
});

describe("docVersionFilePath", () => {
  it("names the version and the format in the file route, with the artifact id encoded", () => {
    expect(docVersionFilePath("art 1", 3, "pdf")).toBe("/api/v1/docs/art%201/versions/3/file?format=pdf");
    expect(docVersionFilePath("art_2", 1, "xlsx")).toBe("/api/v1/docs/art_2/versions/1/file?format=xlsx");
  });
});

describe("importDocPage", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  const answer = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  it("posts the artifact id to the import route and returns the new document's id", async () => {
    vi.mocked(apiFetch).mockResolvedValue(answer(201, { artifactId: "art_9" }));

    await expect(importDocPage("art_1")).resolves.toBe("art_9");
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/docs/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "art_1" }),
    });
  });

  it.each([
    [413, "too_large"],
    [409, "not_editable"],
    [503, "unavailable"],
    [404, "not_found"],
  ])("throws the host's code and status on HTTP %i", async (status, code) => {
    vi.mocked(apiFetch).mockResolvedValue(answer(status, { error: { code, message: "Host sentence." } }));

    const caught = await importDocPage("art_1").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DocsError);
    expect((caught as DocsError).code).toBe(code);
    expect((caught as DocsError).status).toBe(status);
    expect((caught as DocsError).message).toBe("Host sentence.");
  });

  it("falls back to a generic code when the error body is not JSON", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    } as unknown as Response);

    const caught = await importDocPage("art_1").catch((error: unknown) => error);

    expect((caught as DocsError).code).toBe("docs_error");
    expect((caught as DocsError).status).toBe(502);
  });

  it("refuses a success answer without an artifact id as malformed", async () => {
    vi.mocked(apiFetch).mockResolvedValue(answer(201, { id: "art_9" }));

    const caught = await importDocPage("art_1").catch((error: unknown) => error);

    expect((caught as DocsError).code).toBe("docs_malformed");
    expect((caught as DocsError).status).toBe(502);
  });
});
