import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import {
  briefTaskModule,
  extractNumbers,
  financeTaskMeta,
  getFinanceTaskModule,
  lineItemsFromRows,
  matchesAllowed,
  readFiguresText,
  type DirectionClaim,
  type FinanceTask,
  type ReportLocale,
} from "@agentforge/core/finance";
import type { JobEvent } from "@agentforge/core/jobs";
import type { WorkCard } from "../work-cards";
import { parseAppraisalInput, type ParsedAppraisal } from "./parse-appraisal";
import { parseBudgetInput, type BudgetParseResult } from "./parse-budget";
import { parseCashflowInput, type CashflowParseResult } from "./parse-cashflow";
import { parseRatiosInput, type ParsedRatios } from "./parse-ratios";

/**
 * The two skills the harness adds, against each task's own catalog sentence.
 * A reading that is not sections is asked for once more. A section that quotes a computed figure and
 * says the opposite of its direction is rewritten once. Both draw on the run's ONE shared extra call
 * (`call-budget.ts`), so a run that asked again for the reading has none left for the rewrite and the
 * contradicting sentence is taken out in code instead. Nothing here reaches the network.
 */
const asked: Array<Record<string, unknown>> = [];
const answers: string[] = [];
/** Cancels the job as the nth model call is made, the way a closed tab does mid-run. */
let cancelAt: { controller: AbortController; call: number } | null = null;

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: async (options: Record<string, unknown>) => {
      asked.push(options);
      if (cancelAt && asked.length === cancelAt.call) {
        cancelAt.controller.abort();
      }
      return { text: answers.shift() ?? "", model: "stub-model" };
    },
  };
});

vi.mock("./live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live")>();
  return { ...actual, requireLive: () => ({}), resolveModel: () => "stub-model" };
});

vi.mock("../knowledge-ingest", () => ({
  upsertWorkSource: async (_tenant: TenantContext, card: WorkCard) => {
    ingested.push(card);
    return { status: "skipped" as const, reason: "test" };
  },
  ingestWorkSource: () => {},
}));

const ingested: WorkCard[] = [];

const { runFinanceTask } = await import("./runner");
const { generateFinanceBrief } = await import("../finance-generate");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-harness",
  userId: "local",
  role: "owner",
};

const TASKS: readonly FinanceTask[] = ["brief", "cashflow", "budget", "appraisal", "ratios"];

function phrase(words: DirectionClaim["agree"], locale: ReportLocale): string {
  const word = words[0];
  if (!word) {
    throw new Error("direction claim has no phrase");
  }
  return locale === "id" ? word.id : word.en;
}

/** A spelling the number guard accepts for this computed figure. */
function quote(amount: number): string {
  const candidates = [String(Math.round(amount)), amount.toFixed(2), amount.toFixed(1), String(amount)];
  for (const text of candidates) {
    const token = extractNumbers(text)[0];
    if (!token) {
      continue;
    }
    const value = matchesAllowed(token.value, [amount]);
    const alternate = token.alternate !== undefined && matchesAllowed(token.alternate, [amount]);
    if (value || alternate) {
      return text;
    }
  }
  return String(amount);
}

async function confirmed(task: FinanceTask, locale: ReportLocale): Promise<Record<string, unknown>> {
  const figures = financeTaskMeta(task).sampleFigures[locale];
  const prompt = financeTaskMeta(task).defaultPrompt[locale];
  if (task === "brief") {
    // The catalog sentence dates only the revenue. The other amounts join that year so the
    // published operating profit — the figure this skill holds — is the sample's own numbers.
    const items = lineItemsFromRows(readFiguresText(figures).rows).items;
    const year = items.find((item) => item.period)?.period ?? "";
    const dated = year ? items.map((item) => (item.period ? item : { ...item, period: year })) : items;
    return { items: dated, prompt, locale };
  }
  if (task === "cashflow") {
    const parsed = (await parseCashflowInput(tenant, { figures })) as CashflowParseResult;
    const params = {
      ...(parsed.openingCash == null ? {} : { openingCash: parsed.openingCash }),
      ...(parsed.currency ? { currency: parsed.currency } : {}),
    };
    return { items: parsed.items, prompt, locale, ...(Object.keys(params).length > 0 ? { params } : {}) };
  }
  if (task === "budget") {
    const parsed = (await parseBudgetInput(tenant, { figures })) as BudgetParseResult;
    return { items: parsed.items, prompt, locale };
  }
  if (task === "appraisal") {
    const parsed = (await parseAppraisalInput(tenant, { figures })) as ParsedAppraisal;
    return {
      items: parsed.items,
      prompt,
      locale,
      ...(parsed.discountRatePercent == null ? {} : { params: { discountRatePercent: parsed.discountRatePercent } }),
    };
  }
  const parsed = (await parseRatiosInput(tenant, { figures })) as ParsedRatios;
  return { items: parsed.items, prompt, locale };
}

function claimsFor(task: FinanceTask, body: Record<string, unknown>): readonly DirectionClaim[] {
  const module = task === "brief" ? briefTaskModule : getFinanceTaskModule(task);
  if (!module?.directionClaims) {
    throw new Error(`${task} has no direction claims`);
  }
  return module.directionClaims(module.compute(module.inputSchema.parse(body)));
}

function narration(task: FinanceTask, locale: ReportLocale, sentence: string): string {
  if (task === "brief") {
    return JSON.stringify({
      title: "Reading",
      sections: [{ heading: "The result", body: sentence, metrics: [] }],
      assumptions: [],
    });
  }
  const module = getFinanceTaskModule(task);
  const sections = (module?.sections ?? []).map((section, index) => ({
    id: section.id,
    heading: locale === "id" ? section.title.id : section.title.en,
    body: index === 0 ? sentence : "The figures stand as computed.",
  }));
  return JSON.stringify({ title: "Reading", sections, assumptions: [] });
}

function readingOf(task: FinanceTask, result: unknown): string {
  if (task === "brief") {
    const brief = result as { brief?: { sections?: { body?: string }[] } };
    return brief.brief?.sections?.[0]?.body ?? "";
  }
  const report = result as { report?: { notes?: { body?: string }[] } };
  return report.report?.notes?.[0]?.body ?? "";
}

describe("finance harness skills", () => {
  beforeEach(() => {
    asked.length = 0;
    answers.length = 0;
    ingested.length = 0;
    cancelAt = null;
  });

  const CASES = TASKS.flatMap((task) => (["en", "id"] as const).map((locale) => [task, locale] as const));

  /** Run one task over its own catalog sentence with a queue of model answers, and say what happened. */
  async function runDirectionCase(
    task: FinanceTask,
    locale: ReportLocale,
    queue: (wrong: string, right: string) => string[],
  ) {
    const body = await confirmed(task, locale);
    const claim = claimsFor(task, body)[0];
    expect(claim, `${task} ${locale} produced no direction claim`).toBeTruthy();
    if (!claim) {
      throw new Error(`${task} ${locale} produced no direction claim`);
    }
    const figure = quote(claim.amount);
    const against = phrase(claim.contradict, locale);
    const withDirection = phrase(claim.agree, locale);
    const wrong = `The reading is ${against} at ${figure}.`;
    const right = `The reading is ${withDirection} at ${figure}.`;
    answers.push(...queue(narration(task, locale, wrong), JSON.stringify({ heading: "The result", body: right })));
    const events: JobEvent[] = [];
    const emit = (event: JobEvent) => events.push(event);
    const module = getFinanceTaskModule(task);
    if (task !== "brief" && !module) {
      throw new Error(`${task} has no module`);
    }
    const result =
      task === "brief" || !module
        ? await generateFinanceBrief(tenant, body, emit)
        : await runFinanceTask(module, { tenant, body, emit });
    const steps = events.filter((event) => event.type === "job.step").map((event) => event.label);
    for (const call of asked) {
      const system = String(call.systemPrompt);
      if (locale === "id") {
        expect(system).toContain("Bahasa Indonesia");
      } else {
        expect(system).toContain("Keep every number exactly as given.");
      }
    }
    return { steps, reading: readingOf(task, result), against, withDirection };
  }

  const removedStep = (label: string) =>
    label.includes("contradicted a computed direction") && label.includes("removed");

  it.each(CASES)("%s keeps the computed direction through one rewrite (%s)", async (task, locale) => {
    const run = await runDirectionCase(task, locale, (wrong, right) => [wrong, right]);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.runPrefix).toBe("finance-direction");
    expect(run.steps).toContain("Reading contradicted a computed direction");
    expect(run.steps.some(removedStep)).toBe(false);
    expect(run.reading).toContain(run.withDirection);
  });

  // The reading came back wrong the first time, so the one extra call went on asking again. The
  // contradicting sentence then has no call left to be rewritten with: code takes it out, and says so.
  it.each(CASES)("%s asks once more, then drops a contradicting sentence in code (%s)", async (task, locale) => {
    const run = await runDirectionCase(task, locale, (wrong) => ["not json", wrong]);
    expect(asked).toHaveLength(2);
    expect(asked.some((call) => call.runPrefix === "finance-direction")).toBe(false);
    expect(run.steps).toContain("Asked once more for the reading");
    expect(run.steps).toContain("Reading contradicted a computed direction");
    expect(run.steps.some(removedStep)).toBe(true);
    expect(run.reading).not.toContain(run.against);
    expect(run.reading).not.toBe("");
  });

  describe("a cancelled job", () => {
    async function runCancelled(task: "brief" | "cashflow", signal: AbortSignal): Promise<unknown> {
      const body = await confirmed(task, "en");
      const module = getFinanceTaskModule(task);
      return task === "brief" || !module
        ? generateFinanceBrief(tenant, body, () => {}, signal)
        : runFinanceTask(module, { tenant, body, emit: () => {}, abortSignal: signal });
    }

    it.each(["brief", "cashflow"] as const)("gets no second ask for the reading (%s)", async (task) => {
      const controller = new AbortController();
      cancelAt = { controller, call: 1 };
      answers.push("not json");
      await expect(runCancelled(task, controller.signal)).rejects.toMatchObject({ code: "aborted", status: 499 });
      expect(asked).toHaveLength(1);
      expect(asked[0]?.signal).toBe(controller.signal);
      expect(ingested).toHaveLength(0);
    });

    it.each(["brief", "cashflow"] as const)(
      "is not saved when it was cancelled during the direction rewrite (%s)",
      async (task) => {
        const body = await confirmed(task, "en");
        const claim = claimsFor(task, body)[0];
        expect(claim, `${task} produced no direction claim`).toBeTruthy();
        if (!claim) {
          return;
        }
        const figure = quote(claim.amount);
        const wrong = `The reading is ${phrase(claim.contradict, "en")} at ${figure}.`;
        const right = `The reading is ${phrase(claim.agree, "en")} at ${figure}.`;
        const controller = new AbortController();
        cancelAt = { controller, call: 2 };
        answers.push(narration(task, "en", wrong), JSON.stringify({ heading: "The result", body: right }));
        await expect(runCancelled(task, controller.signal)).rejects.toMatchObject({ code: "aborted", status: 499 });
        expect(asked).toHaveLength(2);
        expect(asked[1]?.runPrefix).toBe("finance-direction");
        expect(asked[1]?.signal).toBe(controller.signal);
        expect(ingested).toHaveLength(0);
      },
    );
  });
});
