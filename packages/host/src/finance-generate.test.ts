import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { UNVERIFIED_MARKER } from "@agentforge/core/finance";
import type { WorkCard } from "./work-cards";

/**
 * The gateway call and the Knowledge Base write are the two edges of `regenerateFinanceSection`.
 * Both are module imports rather than injected dependencies here, so they are mocked at the module
 * boundary; everything between them (guard, repair, merge, artifact id) is the real code. Queued
 * answers go out first, one per call; after that every call gets `sectionDraft`.
 */
const asked: Array<Record<string, unknown>> = [];
const ingested: WorkCard[] = [];
const queued: string[] = [];
let sectionDraft = "";

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    collectJobAssistantText: async (options: Record<string, unknown>) => {
      asked.push(options);
      return queued.shift() ?? sectionDraft;
    },
    collectJobAssistantRun: async (options: Record<string, unknown>) => {
      asked.push(options);
      return { text: queued.shift() ?? sectionDraft, model: "stub-model" };
    },
  };
});

vi.mock("./knowledge-ingest", () => ({
  upsertWorkSource: async (_tenant: TenantContext, card: WorkCard) => {
    ingested.push(card);
    return { status: "skipped" as const, reason: "test" };
  },
  ingestWorkSource: () => {},
}));

const { EMPTIED_SECTION_BODY, generateFinanceBrief, readRegenArtifactId, regenerateFinanceSection } = await import(
  "./finance-generate"
);

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-regen",
  userId: "local",
  role: "owner",
};

const BRIEF = {
  title: "FY2025 Gross Margin Review",
  sections: [
    { heading: "Where the margin came from", body: "Revenue was 1000.", metrics: [] },
    { heading: "What to watch", body: "COGS was 400.", metrics: [] },
  ],
  assumptions: ["Figures are FY2025."],
  computed: { metrics: [], tables: [] },
};

const ITEMS = [
  { label: "Revenue", period: "2025", amount: 1000, currency: "IDR", category: "revenue" },
  { label: "COGS", period: "2025", amount: 400, currency: "IDR", category: "cogs" },
];

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { brief: BRIEF, sectionIndex: 1, prompt: "Gross margin story", items: ITEMS, ...extra };
}

describe("generateFinanceBrief", () => {
  beforeEach(() => {
    asked.length = 0;
    ingested.length = 0;
    queued.length = 0;
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // An assumption resting on a figure nobody computed is dropped; the reader is told a sentence went.
  it("counts an assumption the guard dropped as a removed sentence, so the reader is told", async () => {
    queued.push(
      JSON.stringify({
        title: "Margin story",
        sections: [{ heading: "Where the margin came from", body: "Revenue was 1000 and COGS was 400.", metrics: [] }],
        assumptions: ["Figures are FY2025.", "Headcount holds at 140 staff."],
      }),
    );
    const result = await generateFinanceBrief(tenant, { prompt: "Gross margin story", items: ITEMS, locale: "en" });
    if (!("brief" in result)) {
      throw new Error("expected the brief path");
    }
    expect(result.brief.assumptions).toEqual(["Figures are FY2025."]);
    expect(result.guard).toEqual({ flagged: [{ section: -1, text: "140" }], total: 1, removed: 1 });
    expect(asked).toHaveLength(1);
  });

  // A section whose every sentence the repair took out used to fail the brief schema (a body may not
  // be empty), and the job answered 500. The slot stays, as a regenerate keeps the section it replaced.
  it("keeps a section the repair emptied, saying why without a figure, and ships no marker", async () => {
    queued.push(
      JSON.stringify({
        title: "Margin story",
        sections: [
          { heading: "Where the margin came from", body: "Revenue was 1000 and COGS was 400.", metrics: [] },
          { heading: "What to watch", body: "Margin hit 62.5%.", metrics: [] },
        ],
        assumptions: [],
      }),
      JSON.stringify({ heading: "What to watch", body: "Margin hit 71%.", metrics: [] }),
    );
    const result = await generateFinanceBrief(tenant, { prompt: "Gross margin story", items: ITEMS, locale: "en" });
    if (!("brief" in result)) {
      throw new Error("expected the brief path");
    }
    expect(asked).toHaveLength(2);
    expect(result.brief.sections.map((section) => [section.heading, section.body])).toEqual([
      ["Where the margin came from", "Revenue was 1000 and COGS was 400."],
      ["What to watch", EMPTIED_SECTION_BODY.en],
    ]);
    expect(EMPTIED_SECTION_BODY.en).not.toMatch(/\d/);
    expect(result.guard.total).toBe(2);
    expect(result.guard.removed).toBe(1);
    expect(JSON.stringify(result.brief)).not.toContain(UNVERIFIED_MARKER);
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(result.artifactId).toBeTruthy();
  });

  it("hands the run's cancel to the draft and to the repair rewrite", async () => {
    queued.push(
      JSON.stringify({
        title: "Margin story",
        sections: [{ heading: "What to watch", body: "Margin hit 62.5%.", metrics: [] }],
        assumptions: [],
      }),
      JSON.stringify({ heading: "What to watch", body: "COGS was 400 against revenue of 1000.", metrics: [] }),
    );
    const controller = new AbortController();
    await generateFinanceBrief(
      tenant,
      { prompt: "Gross margin story", items: ITEMS, locale: "en" },
      () => {},
      controller.signal,
    );
    expect(asked).toHaveLength(2);
    expect(asked[0]?.signal).toBe(controller.signal);
    expect(asked[1]?.signal).toBe(controller.signal);
  });

  it("saves nothing when the cancel lands after the draft came back", async () => {
    const controller = new AbortController();
    queued.push(
      JSON.stringify({
        title: "Margin story",
        sections: [{ heading: "Where the margin came from", body: "Revenue was 1000 and COGS was 400.", metrics: [] }],
        assumptions: [],
      }),
    );
    const outcome = generateFinanceBrief(
      tenant,
      { prompt: "Gross margin story", items: ITEMS, locale: "en" },
      (event) => {
        if (event.type === "job.phase" && event.phase === "verifying") {
          controller.abort(new Error("client left"));
        }
      },
      controller.signal,
    );
    await expect(outcome).rejects.toMatchObject({ code: "aborted", status: 499 });
    expect(ingested).toEqual([]);
  });

  it("keeps the brief when the repair emptied every section, in the reader's language", async () => {
    queued.push(
      JSON.stringify({
        title: "Cerita margin",
        sections: [{ heading: "Margin", body: "Margin mencapai 97%.", metrics: [] }],
        assumptions: [],
      }),
      // A rewrite nobody can read: the repair keeps the marked section and takes the sentence out.
      "not json",
    );
    const result = await generateFinanceBrief(tenant, { prompt: "Cerita margin", items: ITEMS, locale: "id" });
    if (!("brief" in result)) {
      throw new Error("expected the brief path");
    }
    expect(result.brief.sections).toEqual([
      { heading: "Margin", body: EMPTIED_SECTION_BODY.id, tables: [], metrics: [] },
    ]);
    expect(EMPTIED_SECTION_BODY.id).not.toMatch(/\d/);
    expect(result.guard.removed).toBe(1);
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
  });

  // A brief is one call plus at most one more. Two sections the guard blanked used to take a rewrite
  // each; they now share the one extra call, and the second is cleaned in code.
  it("shares one extra call across every section the guard blanked, and says so", async () => {
    queued.push(
      JSON.stringify({
        title: "Margin story",
        sections: [
          { heading: "Where the margin came from", body: "Margin hit 62.5%. Revenue was 1000.", metrics: [] },
          { heading: "What to watch", body: "Churn was 4.5%. COGS was 400.", metrics: [] },
        ],
        assumptions: [],
      }),
      JSON.stringify({ heading: "Where the margin came from", body: "Revenue was 1000.", metrics: [] }),
    );
    const steps: string[] = [];
    const result = await generateFinanceBrief(
      tenant,
      { prompt: "Gross margin story", items: ITEMS, locale: "en" },
      (event) => {
        if (event.type === "job.step") {
          steps.push(event.label);
        }
      },
    );
    if (!("brief" in result)) {
      throw new Error("expected the brief path");
    }
    expect(asked).toHaveLength(2);
    expect(result.brief.sections.map((section) => section.body)).toEqual(["Revenue was 1000.", "COGS was 400."]);
    expect(result.guard.removed).toBe(1);
    expect(JSON.stringify(result.brief)).not.toContain(UNVERIFIED_MARKER);
    expect(steps).toContain("The one extra model call was already used; the rest was handled in code");
  });

  it("spends the second ask for a draft that was not the sections, and strips a blanked sentence in code", async () => {
    queued.push(
      "this is not json",
      JSON.stringify({
        title: "Margin story",
        sections: [{ heading: "What to watch", body: "Margin hit 62.5%. COGS was 400.", metrics: [] }],
        assumptions: [],
      }),
    );
    const result = await generateFinanceBrief(tenant, { prompt: "Gross margin story", items: ITEMS, locale: "en" });
    if (!("brief" in result)) {
      throw new Error("expected the brief path");
    }
    expect(asked).toHaveLength(2);
    expect(result.brief.sections[0]?.body).toBe("COGS was 400.");
    expect(result.guard.removed).toBe(1);
  });
});

describe("readRegenArtifactId", () => {
  it("reads a non-empty string id and nothing else", () => {
    expect(readRegenArtifactId({ artifactId: "abc-123" })).toBe("abc-123");
    expect(readRegenArtifactId({ artifactId: "  abc-123  " })).toBe("abc-123");
    expect(readRegenArtifactId({ artifactId: "" })).toBeNull();
    expect(readRegenArtifactId({ artifactId: "   " })).toBeNull();
    expect(readRegenArtifactId({ artifactId: 12 })).toBeNull();
    expect(readRegenArtifactId({})).toBeNull();
    expect(readRegenArtifactId(null)).toBeNull();
  });
});

describe("regenerateFinanceSection", () => {
  beforeEach(() => {
    asked.length = 0;
    ingested.length = 0;
    queued.length = 0;
    sectionDraft = JSON.stringify({
      heading: "What to watch next",
      body: "COGS was 400 against revenue of 1000.",
      metrics: [],
    });
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // F1: the studio used to get `artifactId: null` back, so the next "Send to Knowledge Base"
  // pasted a second row next to the card the original generate had already indexed.
  it("returns the artifact the brief was saved as, so the next send stays idempotent", async () => {
    const result = await regenerateFinanceSection(tenant, body({ artifactId: "artifact-1" }));
    expect(result.artifactId).toBe("artifact-1");
    expect(result.brief.sections[1]?.heading).toBe("What to watch next");
    expect(result.brief.sections[0]?.body).toBe("Revenue was 1000.");
    expect(result.markdown).toContain("What to watch next");
  });

  it("rewrites the same origin's card with the merged brief", async () => {
    const result = await regenerateFinanceSection(tenant, body({ artifactId: "artifact-1" }));
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      type: "Finance",
      origin: { kind: "artifact", id: "artifact-1" },
      pointer: "artifact:artifact-1",
      title: "FY2025 Gross Margin Review",
      prompt: "Gross margin story",
    });
    expect(ingested[0]?.body).toBe(result.markdown);
  });

  it("hands the cancel to the rewrite and to its repair, and leaves the calls without one when there is none", async () => {
    queued.push(
      JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%. COGS was 400.", metrics: [] }),
      JSON.stringify({ heading: "What to watch", body: "COGS was 400 against revenue of 1000.", metrics: [] }),
    );
    const controller = new AbortController();
    await regenerateFinanceSection(tenant, body(), controller.signal);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.signal).toBe(controller.signal);
    expect(asked[1]?.signal).toBe(controller.signal);

    asked.length = 0;
    await regenerateFinanceSection(tenant, body());
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toHaveProperty("signal");
  });

  it("indexes nothing and answers null when the caller sends no artifact", async () => {
    const result = await regenerateFinanceSection(tenant, body());
    expect(result.artifactId).toBeNull();
    expect(ingested).toEqual([]);
  });

  it("still guards figures the metrics do not support", async () => {
    sectionDraft = JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%.", metrics: [] });
    const result = await regenerateFinanceSection(tenant, body({ artifactId: "artifact-1" }));
    expect(result.guard.total).toBeGreaterThan(0);
    expect(result.guard.flagged[0]?.section).toBe(1);
  });

  // The rewrite used to be guarded and then shipped: "[unverified figure]" went straight to the reader.
  it("rewrites a blanked figure once, the same repair a generate runs, and ships no marker", async () => {
    queued.push(
      JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%. COGS was 400.", metrics: [] }),
      JSON.stringify({ heading: "What to watch", body: "COGS was 400 against revenue of 1000.", metrics: [] }),
    );
    const result = await regenerateFinanceSection(tenant, body({ artifactId: "artifact-1" }));
    expect(asked).toHaveLength(2);
    expect(String(asked[1]?.prompt)).toContain("Margin hit [unverified figure].");
    expect(result.brief.sections[1]?.body).toBe("COGS was 400 against revenue of 1000.");
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(JSON.stringify(result.brief)).not.toContain(UNVERIFIED_MARKER);
    expect(result.guard).toEqual({ flagged: [{ section: 1, text: "62.5%" }], total: 1, removed: 0 });
    expect(ingested[0]?.body).not.toContain(UNVERIFIED_MARKER);
  });

  it("takes the sentence out when the rewrite invents again, and counts it", async () => {
    sectionDraft = JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%. COGS was 400.", metrics: [] });
    const result = await regenerateFinanceSection(tenant, body());
    expect(result.brief.sections[1]?.body).toBe("COGS was 400.");
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(result.guard.removed).toBe(1);
    expect(result.guard.flagged).toEqual([
      { section: 1, text: "62.5%" },
      { section: 1, text: "62.5%" },
    ]);
  });

  // A section cannot be empty; a rewrite with nothing traceable left keeps the section it replaced.
  it("keeps the section it was asked to replace when nothing traceable is left of the rewrite", async () => {
    sectionDraft = JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%.", metrics: [] });
    const result = await regenerateFinanceSection(tenant, body());
    expect(result.brief.sections[1]).toEqual({ ...BRIEF.sections[1], tables: [] });
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(result.guard.total).toBe(2);
    expect(result.guard.removed).toBe(1);
  });

  // What a regenerate does with the owner's edits (docs/internal/doc-flow-plan.md 7a.5). The studio
  // posts the brief it holds, edits and all, and the host rewrites only the section asked for: every
  // other section, the title and the assumptions come back exactly as sent, and are not re-guarded.
  describe("keeps what the owner edited", () => {
    const EDITED = {
      title: "My own title, 2.5x better",
      sections: [
        { heading: "Where it came from", body: "Revenue was 1000, and my forecast is 1500 next year.", metrics: [] },
        { heading: "What to watch", body: "COGS was 400.", metrics: [] },
        { heading: "Next steps", body: "I will ask the board about 77 new hires.", metrics: [] },
      ],
      assumptions: ["Figures are FY2025.", "Headcount holds at 140 staff."],
      computed: { metrics: [], tables: [] },
    };

    it("leaves every other section, the title and the assumptions exactly as sent, figures the guard would blank included", async () => {
      const result = await regenerateFinanceSection(tenant, body({ brief: EDITED, sectionIndex: 1 }));
      expect(result.brief.title).toBe(EDITED.title);
      expect(result.brief.assumptions).toEqual(EDITED.assumptions);
      expect(result.brief.sections[0]?.body).toBe(EDITED.sections[0]?.body);
      expect(result.brief.sections[2]?.body).toBe(EDITED.sections[2]?.body);
      expect(result.brief.sections[1]?.heading).toBe("What to watch next");
      expect(result.markdown).toContain("my forecast is 1500 next year");
      expect(result.markdown).toContain("77 new hires");
      expect(result.guard.flagged).toEqual([]);
    });

    it("shows the model the section as the owner left it, edits included, so the rewrite starts from them", async () => {
      await regenerateFinanceSection(
        tenant,
        body({
          brief: {
            ...EDITED,
            sections: [
              EDITED.sections[0],
              { heading: "What to watch", body: "COGS was 400, which I think is too high.", metrics: [] },
              EDITED.sections[2],
            ],
          },
          sectionIndex: 1,
          instruction: "Keep my point about COGS.",
        }),
      );
      const prompt = String(asked[0]?.prompt);
      expect(prompt).toContain("COGS was 400, which I think is too high.");
      expect(prompt).toContain("Keep my point about COGS.");
    });

    it("keeps the owner's text in the target section when the rewrite leaves nothing the guard accepts", async () => {
      sectionDraft = JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%.", metrics: [] });
      const edited = { heading: "What to watch", body: "COGS was 400, and I want this said my way.", metrics: [] };
      const result = await regenerateFinanceSection(
        tenant,
        body({ brief: { ...EDITED, sections: [EDITED.sections[0], edited, EDITED.sections[2]] }, sectionIndex: 1 }),
      );
      expect(result.brief.sections[1]?.body).toBe(edited.body);
    });

    it("makes the section rewrite plus at most one extra call, never more", async () => {
      sectionDraft = JSON.stringify({ heading: "What to watch", body: "Margin hit 62.5%. COGS was 400.", metrics: [] });
      await regenerateFinanceSection(tenant, body({ brief: EDITED, sectionIndex: 1 }));
      expect(asked).toHaveLength(2);
    });
  });

  it("refuses a malformed body before it reaches the gateway", async () => {
    await expect(regenerateFinanceSection(tenant, "nope")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    await expect(regenerateFinanceSection(tenant, body({ sectionIndex: 9 }))).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    expect(asked).toEqual([]);
  });
});
