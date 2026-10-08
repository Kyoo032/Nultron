import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { UNVERIFIED_MARKER, type FinanceReport } from "@agentforge/core/finance";
import type { JobEvent } from "@agentforge/core/jobs";

const answers: string[] = [];
const asked: Array<Record<string, unknown>> = [];

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: async (options: Record<string, unknown>) => {
      asked.push(options);
      return { text: answers.shift() ?? "", model: "stub-model" };
    },
  };
});

const { ADVICE_EMPTY, ADVICE_SENTENCE_FLAG, holdReadingScope, withAdviceFlag, withoutAdviceSentences } = await import(
  "./scope"
);
const { createCallBudget } = await import("./call-budget");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-scope",
  userId: "local",
  role: "owner",
};

const options = (extra: Record<string, unknown> = {}) => {
  const events: JobEvent[] = [];
  return {
    events,
    options: {
      tenant,
      model: "stub-model",
      locale: "en" as const,
      factsBlock: "facts",
      allowed: [900],
      sources: [] as string[],
      emit: (event: JobEvent) => events.push(event),
      phase: "narrate-guard-export",
      ...extra,
    },
  };
};

function rewrite(body: string): string {
  return JSON.stringify({ heading: "ignored", body });
}

const ADVISING = [
  {
    id: "position",
    heading: "Where cash sits",
    body: "Cash was 900 in the bank. You should sell the asset. Burn held.",
  },
  { id: "outlook", heading: "What next", body: "Burn held. We recommend cutting rent." },
];

describe("withoutAdviceSentences", () => {
  it("takes out only the sentence that advises", () => {
    const stripped = withoutAdviceSentences("Cash held. You should sell now. Burn fell.", []);
    expect(stripped.body).toBe("Cash held. Burn fell.");
    expect(stripped.removed).toEqual(["You should sell now."]);
  });

  it("drops a paragraph that had nothing else in it", () => {
    expect(withoutAdviceSentences("Cash held.\n\nWe recommend a review.", []).body).toBe("Cash held.");
  });

  it("keeps a sentence the person's own text contains", () => {
    const sources = ["Memo: you should sell now."];
    expect(withoutAdviceSentences("You should sell now.", sources).removed).toEqual([]);
  });

  it("changes nothing in a body that does not advise, and never touches a figure", () => {
    const body = "Cash was 900.\n\nBurn held at 1.250.000.";
    expect(withoutAdviceSentences(body, [])).toEqual({ body, removed: [] });
  });
});

describe("holdReadingScope", () => {
  it("asks nothing when no section advises", async () => {
    asked.length = 0;
    const { options: opts, events } = options();
    const result = await holdReadingScope([{ heading: "A", body: "Cash was 900. Burn held." }], opts);
    expect(asked).toEqual([]);
    expect(result.adviceRemoved).toBe(0);
    expect(events).toEqual([]);
  });

  it("rewrites an advising section once and keeps the rewrite when it describes the figures", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("Cash was 900 in the bank. The asset is a third of the balance sheet."));
    const { options: opts, events } = options();
    const result = await holdReadingScope([ADVISING[0] as (typeof ADVISING)[number]], opts);
    expect(asked).toHaveLength(1);
    expect(String(asked[0]?.prompt)).toContain("facts");
    expect(result.sections[0]).toEqual({
      id: "position",
      heading: "Where cash sits",
      body: "Cash was 900 in the bank. The asset is a third of the balance sheet.",
    });
    expect(result.adviceRemoved).toBe(0);
    expect(events.map((event) => (event.type === "job.step" ? event.label : event.type))).toEqual([
      "Reading gave advice",
    ]);
  });

  it("drops the sentence when the rewrite advises again, counts it, and says so", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("Cash held. You should sell the asset."));
    const { options: opts, events } = options();
    const result = await holdReadingScope([ADVISING[0] as (typeof ADVISING)[number]], opts);
    expect(result.sections[0]?.body).toBe("Cash held.");
    expect(result.adviceRemoved).toBe(1);
    expect(events.map((event) => (event.type === "job.step" ? event.label : event.type))).toContain(
      "1 sentence(s) removed because they gave advice",
    );
  });

  it("drops the sentence when the rewrite is not JSON, and the section keeps its other sentences", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push("not json");
    const { options: opts } = options();
    const result = await holdReadingScope([ADVISING[0] as (typeof ADVISING)[number]], opts);
    expect(result.sections[0]?.body).toBe("Cash was 900 in the bank. Burn held.");
    expect(result.adviceRemoved).toBe(1);
  });

  it("holds a figure the rewrite invented to the same guard as any other", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("Cash was 900 in the bank. Burn was 1234 a month. Debt is large."));
    const { options: opts } = options();
    const result = await holdReadingScope([ADVISING[0] as (typeof ADVISING)[number]], opts);
    expect(result.sections[0]?.body).toBe("Cash was 900 in the bank. Debt is large.");
    expect(result.amountRemoved).toBe(1);
    expect(JSON.stringify(result.sections)).not.toContain(UNVERIFIED_MARKER);
  });

  it("says what a section holds when every sentence in it advised", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("We recommend cutting rent."));
    const { options: opts } = options({ locale: "id" });
    const result = await holdReadingScope([{ heading: "Next", body: "We recommend cutting rent." }], opts);
    expect(result.sections[0]?.body).toBe(ADVICE_EMPTY.id);
  });

  describe("with the run's shared extra-call budget", () => {
    it("rewrites the first advising section and drops the sentence from the second without asking", async () => {
      asked.length = 0;
      answers.length = 0;
      answers.push(rewrite("Cash was 900 in the bank. Burn held."));
      const budget = createCallBudget();
      const { options: opts } = options({ budget });
      const result = await holdReadingScope(ADVISING, opts);
      expect(asked).toHaveLength(1);
      expect(budget.used).toBe(1);
      expect(budget.refused).toBe(1);
      expect(result.sections.map((section) => section.body)).toEqual([
        "Cash was 900 in the bank. Burn held.",
        "Burn held.",
      ]);
      expect(result.adviceRemoved).toBe(1);
    });

    it("makes no call when the budget was spent on something else, and still drops every advising sentence", async () => {
      asked.length = 0;
      answers.length = 0;
      const budget = createCallBudget();
      budget.take();
      const { options: opts } = options({ budget });
      const result = await holdReadingScope(ADVISING, opts);
      expect(asked).toEqual([]);
      expect(result.sections.map((section) => section.body)).toEqual([
        "Cash was 900 in the bank. Burn held.",
        "Burn held.",
      ]);
      expect(result.adviceRemoved).toBe(2);
    });

    it("spends nothing when nothing advises", async () => {
      const budget = createCallBudget();
      const { options: opts } = options({ budget });
      await holdReadingScope([{ heading: "A", body: "Burn held." }], opts);
      expect(budget.used).toBe(0);
      expect(budget.refused).toBe(0);
    });
  });

  it("hands the job's cancel to the rewrite, and stops on a cancel", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("Burn held."));
    const controller = new AbortController();
    const { options: opts } = options({ signal: controller.signal });
    await holdReadingScope([ADVISING[1] as (typeof ADVISING)[number]], opts);
    expect(asked[0]?.signal).toBe(controller.signal);
    controller.abort(new Error("client left"));
    await expect(holdReadingScope([ADVISING[1] as (typeof ADVISING)[number]], opts)).rejects.toMatchObject({
      code: "aborted",
    });
  });
});

describe("withAdviceFlag", () => {
  const report = (flags: FinanceReport["flags"] = []): FinanceReport => ({
    task: "appraisal",
    title: "t",
    locale: "en",
    summary: [],
    tables: [],
    charts: [],
    flags,
    notes: [],
  });

  it("tells the reader once, in their language, and not at all when nothing was removed", () => {
    expect(withAdviceFlag(report(), 0, "en").flags).toEqual([]);
    const flagged = withAdviceFlag(report(), 2, "id");
    expect(flagged.flags).toEqual([{ level: "watch", text: ADVICE_SENTENCE_FLAG.id }]);
    expect(withAdviceFlag(flagged, 1, "id").flags).toHaveLength(1);
  });

  it("names no figure and no marker", () => {
    for (const text of Object.values(ADVICE_SENTENCE_FLAG)) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain(UNVERIFIED_MARKER);
    }
  });
});
