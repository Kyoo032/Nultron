import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import type { DirectionClaim } from "@agentforge/core/finance";
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

const { holdReadingDirection, DIRECTION_EMPTY } = await import("./direction");
const { createCallBudget } = await import("./call-budget");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-direction",
  userId: "local",
  role: "owner",
};

const CLAIMS: DirectionClaim[] = [
  {
    amount: 14_000,
    agree: [{ en: "unfavourable", id: "tidak menguntungkan" }],
    contradict: [{ en: "favourable", id: "menguntungkan" }],
  },
];

const SECTIONS = [
  { heading: "Lines", body: "Marketing is favourable at 14000 this quarter. Rent held." },
  { heading: "Notes", body: "Travel is favourable at 14000 this quarter. Software held." },
];

const options = (extra: Record<string, unknown> = {}) => ({
  tenant,
  model: "stub-model",
  locale: "en" as const,
  factsBlock: "facts",
  allowed: [14_000],
  emit: (_event: JobEvent) => {},
  phase: "narrate-guard-export",
  ...extra,
});

function rewrite(body: string): string {
  return JSON.stringify({ heading: "ignored", body });
}

describe("holdReadingDirection", () => {
  it("asks nothing when no section contradicts a claim", async () => {
    asked.length = 0;
    const result = await holdReadingDirection(
      [{ heading: "Lines", body: "Marketing is unfavourable at 14000 this quarter." }],
      CLAIMS,
      options(),
    );
    expect(asked).toEqual([]);
    expect(result.directionRemoved).toBe(0);
  });

  it("rewrites a contradicting section once, keeping the heading", async () => {
    asked.length = 0;
    answers.length = 0;
    answers.push(rewrite("Marketing is unfavourable at 14000 this quarter. Rent held."));
    const result = await holdReadingDirection([SECTIONS[0] as (typeof SECTIONS)[number]], CLAIMS, options());
    expect(asked).toHaveLength(1);
    expect(result.sections[0]).toEqual({
      heading: "Lines",
      body: "Marketing is unfavourable at 14000 this quarter. Rent held.",
    });
    expect(result.directionRemoved).toBe(0);
  });

  describe("with the run's shared extra-call budget", () => {
    it("rewrites the first contradicting section and takes the sentence out of the second without asking", async () => {
      asked.length = 0;
      answers.length = 0;
      answers.push(rewrite("Marketing is unfavourable at 14000 this quarter. Rent held."));
      const budget = createCallBudget();
      const result = await holdReadingDirection(SECTIONS, CLAIMS, options({ budget }));
      expect(asked).toHaveLength(1);
      expect(budget.used).toBe(1);
      expect(budget.refused).toBe(1);
      expect(result.sections.map((section) => section.body)).toEqual([
        "Marketing is unfavourable at 14000 this quarter. Rent held.",
        "Software held.",
      ]);
      expect(result.directionRemoved).toBe(1);
    });

    it("makes no call when the budget is already spent, and drops the contradicting sentence in code", async () => {
      asked.length = 0;
      answers.length = 0;
      const budget = createCallBudget();
      budget.take();
      const result = await holdReadingDirection(SECTIONS, CLAIMS, options({ budget }));
      expect(asked).toEqual([]);
      expect(result.sections.map((section) => section.body)).toEqual(["Rent held.", "Software held."]);
      expect(result.directionRemoved).toBe(2);
    });

    it("says what a section holds when every sentence in it was dropped", async () => {
      asked.length = 0;
      const budget = createCallBudget();
      budget.take();
      const result = await holdReadingDirection(
        [{ heading: "Lines", body: "Marketing is favourable at 14000 this quarter." }],
        CLAIMS,
        options({ budget }),
      );
      expect(result.sections[0]?.body).toBe(DIRECTION_EMPTY.en);
    });

    it("spends nothing when nothing contradicts", async () => {
      const budget = createCallBudget();
      await holdReadingDirection([{ heading: "Lines", body: "Rent held." }], CLAIMS, options({ budget }));
      expect(budget.used).toBe(0);
      expect(budget.refused).toBe(0);
    });
  });
});
