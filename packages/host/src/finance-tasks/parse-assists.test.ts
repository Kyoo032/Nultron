import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";

/**
 * "Assists" are the model's two small jobs inside the free-text parses: placing a statement label no
 * rule knows (ratios) and scoring two budget labels by meaning (budget). `/finance/auto` runs the
 * same parses with them off. Each is replaced here by a counter, so the test can say both that the
 * assist runs when it is on and that nothing at all is called when it is off.
 */
const textCalls: Array<Record<string, unknown>> = [];
const embedCalls: string[][] = [];

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  return {
    ...actual,
    collectJobAssistantText: async (options: Record<string, unknown>) => {
      textCalls.push(options);
      return JSON.stringify({ assignments: [{ label: "Zorblax Holdings", bucket: "cash" }] });
    },
  };
});

vi.mock("./live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live")>();
  return { ...actual, requireLive: () => ({}), resolveModel: () => "stub-model" };
});

vi.mock("../knowledge-embed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge-embed")>();
  return {
    ...actual,
    embedTextsWithModel: async (labels: string[]) => {
      embedCalls.push(labels);
      return { vectors: labels.map(() => [1, 0]), model: "real-embed" };
    },
  };
});

vi.mock("../knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../knowledge")>();
  return { ...actual, getKnowledgeModels: () => ({ embeddingModel: "real-embed" }) };
});

const { parseRatiosFigures } = await import("./parse-ratios");
const { parseBudgetFigures } = await import("./parse-budget");

const tenant = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-assists",
  userId: "local",
  role: "owner",
} as TenantContext;

const RATIOS_WITH_UNKNOWN_LABEL = [
  "Sheet: Neraca",
  "Keterangan | 2024",
  "Kas dan Setara Kas | 500",
  "Piutang Usaha | 300",
  "Zorblax Holdings | 90",
  "Utang Usaha | 250",
].join("\n");

/** Two sides with a loose end on each: nothing local pairs "Alpha spend" with "Omega cost". */
const BUDGET_WITH_LOOSE_ENDS = [
  "Sheet: Anggaran 2024",
  "Pendapatan: 1000",
  "Alpha spend: 200",
  "Sheet: Realisasi 2024",
  "Pendapatan: 950",
  "Omega cost: 210",
].join("\n");

beforeEach(() => {
  textCalls.length = 0;
  embedCalls.length = 0;
});

describe("parseRatiosFigures: the bucket assist", () => {
  it("asks the model for the labels no rule placed when assists are on, as it always did", async () => {
    const parsed = await parseRatiosFigures(tenant, { figures: RATIOS_WITH_UNKNOWN_LABEL });
    expect(textCalls).toHaveLength(1);
    expect(parsed.modelAssist).toMatchObject({ asked: 1, placed: 1 });
  });

  it("makes no call with assists off, and leaves the label unplaced for the owner to see", async () => {
    const parsed = await parseRatiosFigures(tenant, { figures: RATIOS_WITH_UNKNOWN_LABEL }, undefined, {
      assists: false,
    });
    expect(textCalls).toEqual([]);
    expect(parsed.modelAssist).toBeNull();
    const zorblax = parsed.buckets.find((entry) => entry.label === "Zorblax Holdings");
    expect(zorblax).toMatchObject({ bucket: "excluded", source: "unknown" });
    // Every row the rules did place is read exactly as before.
    expect(parsed.buckets.find((entry) => entry.label === "Kas dan Setara Kas")).toMatchObject({ bucket: "cash" });
  });
});

describe("parseBudgetFigures: the meaning stage", () => {
  it("embeds the labels of two loose ends when assists are on, as it always did", async () => {
    const parsed = await parseBudgetFigures(tenant, { figures: BUDGET_WITH_LOOSE_ENDS });
    expect(embedCalls).toHaveLength(1);
    expect(parsed.matching.embedding).not.toBe("not-needed");
  });

  it("makes no embedding call with assists off, and says the meaning stage did not run", async () => {
    const parsed = await parseBudgetFigures(tenant, { figures: BUDGET_WITH_LOOSE_ENDS }, { assists: false });
    expect(embedCalls).toEqual([]);
    expect(parsed.matching.embedding).toBe("unavailable");
    // The local pairing still ran: the line both sheets share is paired.
    expect(parsed.pairs.some((pair) => pair.budgetLabel === "Pendapatan" && pair.actualLabel === "Pendapatan")).toBe(
      true,
    );
  });

  it("says nothing was needed when the local stages paired everything, whether or not assists are on", async () => {
    const paired = "Sheet: Anggaran 2024\nPendapatan: 1000\nSheet: Realisasi 2024\nPendapatan: 950";
    const on = await parseBudgetFigures(tenant, { figures: paired });
    const off = await parseBudgetFigures(tenant, { figures: paired }, { assists: false });
    expect(on.matching.embedding).toBe("not-needed");
    expect(off.matching.embedding).toBe("not-needed");
    expect(embedCalls).toEqual([]);
  });
});
