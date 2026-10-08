import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { UNVERIFIED_MARKER, computeFinance, type LineItem } from "@agentforge/core/finance";

/** One stubbed gateway call per retry; the queue is what each retry gets back. */
const answers: string[] = [];
const asked: Array<Record<string, unknown>> = [];

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: async (options: Record<string, unknown>) => {
      asked.push(options);
      return { text: answers.shift() ?? "", model: "stub-model" };
    },
  };
});

const { repairUnverifiedSections, splitSentences, stripMarkedSentences } = await import("./finance-section-repair");
const { createCallBudget } = await import("./finance-tasks/call-budget");
const { readFinanceLocale } = await import("./finance-locale");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-repair",
  userId: "local",
  role: "owner",
};

const ITEMS: LineItem[] = [
  { label: "Pendapatan", period: "2024", amount: 1_250_000_000, currency: "IDR", category: "revenue" },
  { label: "HPP", period: "2024", amount: 730_000_000, currency: "IDR", category: "cogs" },
];
const computed = computeFinance(ITEMS, {}, { locale: "id" });

function brief(body: string) {
  return {
    title: "Ringkasan",
    sections: [{ heading: "Kinerja", body, tables: [], metrics: [] }],
    assumptions: [],
    computed: { metrics: computed.metrics, tables: computed.tables },
  };
}

const prompt = {
  tenant,
  model: "stub-model",
  systemPrompt: "system",
  factsBlock: "facts",
  locale: "id" as const,
};

describe("sentence splitting", () => {
  it("does not break a grouped figure in half", () => {
    expect(splitSentences("Pendapatan Rp 1.250.000.000 naik. Marjin tetap.")).toEqual([
      "Pendapatan Rp 1.250.000.000 naik.",
      "Marjin tetap.",
    ]);
  });

  it("ends a sentence that ends on a figure, so the next one is not carried away with it", () => {
    expect(splitSentences("Cash was 900. Burn held.")).toEqual(["Cash was 900.", "Burn held."]);
    expect(splitSentences("Pendapatan Rp 1.250.000.000. Marjin tetap.")).toEqual([
      "Pendapatan Rp 1.250.000.000.",
      "Marjin tetap.",
    ]);
    const stripped = stripMarkedSentences(`Cash was 900. Burn was ${UNVERIFIED_MARKER}. Rent held.`);
    expect(stripped.body).toBe("Cash was 900. Rent held.");
    expect(stripped.removed).toHaveLength(1);
  });

  it("does not take a list number for the end of a sentence", () => {
    expect(splitSentences("1. Revenue up. Costs fell.")).toEqual(["1. Revenue up.", "Costs fell."]);
    expect(splitSentences("Highlights: 2. Costs fell. Cash held.")).toEqual([
      "Highlights: 2. Costs fell.",
      "Cash held.",
    ]);
  });

  it("takes out only the sentence that carries the marker", () => {
    const stripped = stripMarkedSentences(`Pendapatan naik. Churn ${UNVERIFIED_MARKER} persen. Marjin tetap.`);
    expect(stripped.body).toBe("Pendapatan naik. Marjin tetap.");
    expect(stripped.removed).toHaveLength(1);
    expect(stripped.body).not.toContain(UNVERIFIED_MARKER);
  });

  it("drops a paragraph that had nothing else in it", () => {
    const stripped = stripMarkedSentences(`Marjin tetap.\n\nChurn ${UNVERIFIED_MARKER} persen.`);
    expect(stripped.body).toBe("Marjin tetap.");
  });
});

describe("repairUnverifiedSections", () => {
  it("leaves a clean brief alone and asks the model nothing", async () => {
    asked.length = 0;
    const result = await repairUnverifiedSections(brief("Pendapatan Rp 1.250.000.000."), computed, prompt);
    expect(asked).toEqual([]);
    expect(result.guard).toEqual({ flagged: [], total: 0, removed: 0 });
  });

  it("asks once, and keeps the rewrite when it traces", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(JSON.stringify({ heading: "Kinerja", body: "Marjin kotor 41,6%.", metrics: [] }));
    const result = await repairUnverifiedSections(brief(`Marjin kotor ${UNVERIFIED_MARKER}.`), computed, prompt);
    expect(asked).toHaveLength(1);
    expect(String(asked[0]?.prompt)).toContain(UNVERIFIED_MARKER);
    expect(result.brief.sections[0]?.body).toBe("Marjin kotor 41,6%.");
    expect(result.guard.removed).toBe(0);
  });

  it("removes the sentence cleanly when the rewrite invents again, and says one was removed", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(JSON.stringify({ heading: "Kinerja", body: "Marjin kotor 41,6%. Churn 4,5%.", metrics: [] }));
    const result = await repairUnverifiedSections(brief(`Marjin kotor ${UNVERIFIED_MARKER}.`), computed, prompt);
    const body = result.brief.sections[0]?.body ?? "";
    expect(body).toBe("Marjin kotor 41,6%.");
    expect(body).not.toContain(UNVERIFIED_MARKER);
    expect(result.guard.removed).toBe(1);
    expect(result.guard.flagged).toEqual([{ section: 0, text: "4,5%" }]);
  });

  it("hands the job's cancel to the rewrite call", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(JSON.stringify({ heading: "Kinerja", body: "Marjin kotor 41,6%.", metrics: [] }));
    const controller = new AbortController();
    await repairUnverifiedSections(brief(`Marjin kotor ${UNVERIFIED_MARKER}.`), computed, {
      ...prompt,
      signal: controller.signal,
    });
    expect(asked[0]?.signal).toBe(controller.signal);
  });

  it("stops the repair on a cancel instead of treating it as a retry that failed", async () => {
    asked.length = 0;
    answers.length = 0;
    const controller = new AbortController();
    controller.abort(new Error("client left"));
    // The stubbed gateway call answers with an empty reply, which `parseBriefSection` refuses: without
    // the cancel check that is swallowed and the repair goes on to the next section.
    await expect(
      repairUnverifiedSections(
        {
          ...brief(`Marjin kotor ${UNVERIFIED_MARKER}.`),
          sections: [
            { heading: "Kinerja", body: `Marjin kotor ${UNVERIFIED_MARKER}.`, tables: [], metrics: [] },
            { heading: "Arus kas", body: `Kas ${UNVERIFIED_MARKER}.`, tables: [], metrics: [] },
          ],
        },
        computed,
        { ...prompt, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted", status: 499 });
    expect(asked).toHaveLength(1);
  });

  describe("with the run's shared extra-call budget", () => {
    const twoMarked = {
      ...brief("x"),
      sections: [
        {
          heading: "Kinerja",
          body: `Marjin kotor ${UNVERIFIED_MARKER}. Pendapatan Rp 1.250.000.000.`,
          tables: [],
          metrics: [],
        },
        {
          heading: "Arus kas",
          body: `Kas ${UNVERIFIED_MARKER}. Pendapatan Rp 1.250.000.000.`,
          tables: [],
          metrics: [],
        },
      ],
    };

    it("rewrites the first marked section and takes the sentence out of the others without asking", async () => {
      asked.length = 0;
      answers.length = 0;
      answers.push(JSON.stringify({ heading: "Kinerja", body: "Marjin kotor 41,6%.", metrics: [] }));
      const budget = createCallBudget();
      const result = await repairUnverifiedSections(twoMarked, computed, { ...prompt, budget });
      expect(asked).toHaveLength(1);
      expect(budget.used).toBe(1);
      expect(budget.refused).toBe(1);
      expect(result.brief.sections[0]?.body).toBe("Marjin kotor 41,6%.");
      expect(result.brief.sections[1]?.body).toBe("Pendapatan Rp 1.250.000.000.");
      expect(result.guard.removed).toBe(1);
      expect(JSON.stringify(result.brief)).not.toContain(UNVERIFIED_MARKER);
    });

    it("makes no call at all when the budget is already spent, and still ships no marker", async () => {
      asked.length = 0;
      answers.length = 0;
      const budget = createCallBudget();
      budget.take();
      const result = await repairUnverifiedSections(twoMarked, computed, { ...prompt, budget });
      expect(asked).toEqual([]);
      expect(result.guard.removed).toBe(2);
      expect(result.brief.sections.map((section) => section.body)).toEqual([
        "Pendapatan Rp 1.250.000.000.",
        "Pendapatan Rp 1.250.000.000.",
      ]);
    });

    it("spends nothing on a brief with no marker", async () => {
      asked.length = 0;
      const budget = createCallBudget();
      await repairUnverifiedSections(brief("Pendapatan Rp 1.250.000.000."), computed, { ...prompt, budget });
      expect(budget.used).toBe(0);
      expect(budget.refused).toBe(0);
    });

    it("counts a rewrite that failed as spent: the call was made", async () => {
      asked.length = 0;
      answers.length = 0;
      answers.push("not json at all");
      const budget = createCallBudget();
      const result = await repairUnverifiedSections(twoMarked, computed, { ...prompt, budget });
      expect(asked).toHaveLength(1);
      expect(budget.remaining).toBe(0);
      expect(result.guard.removed).toBe(2);
    });
  });

  it("still strips the marker when the retry itself fails", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push("not json at all");
    const result = await repairUnverifiedSections(
      brief(`Marjin kotor ${UNVERIFIED_MARKER}. Pendapatan Rp 1.250.000.000.`),
      computed,
      prompt,
    );
    expect(result.brief.sections[0]?.body).toBe("Pendapatan Rp 1.250.000.000.");
    expect(result.guard.removed).toBe(1);
  });
});

describe("readFinanceLocale", () => {
  it("takes the locale the request asked for", () => {
    expect(readFinanceLocale({ locale: "id" })).toBe("id");
    expect(readFinanceLocale({ locale: "en" })).toBe("en");
  });

  it("falls back to the run's own locale rather than to a default", () => {
    expect(readFinanceLocale({ locale: "fr" })).toBe(readFinanceLocale({}));
    expect(readFinanceLocale(null)).toBe(readFinanceLocale({}));
  });
});
