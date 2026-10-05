import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";

/**
 * The Finance parse step asks the model for small things (row categories, the names of stated
 * figures, the bucket for a label the dictionary cannot place). Each of those passes is allowed to
 * fail without failing the parse, and each of those catch blocks used to swallow a cancel with it.
 * The gateway call is the one edge replaced here: it records what it was handed and can be told to
 * fail after the caller has left.
 */
type Asked = Record<string, unknown>;
const asked: Asked[] = [];
/** What the next gateway call does: answer with `text`, or fail once with `fail` after running `before`. */
let next: { text: string; before?: () => void; fail?: Error } = { text: "{}" };

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  const call = async (options: Asked): Promise<string> => {
    asked.push(options);
    const { before, fail, text } = next;
    // A failure is for the one call; the calls after it get the plain answer.
    next = { text };
    before?.();
    if (fail) {
      throw fail;
    }
    return text;
  };
  return {
    ...actual,
    collectJobAssistantText: call,
    collectJobAssistantRun: async (options: Asked) => ({ text: await call(options), model: "stub-model" }),
  };
});

vi.mock("./live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./live")>();
  return { ...actual, requireLive: () => ({}), resolveModel: () => "stub-model" };
});

const { parseRatiosFigures, parseRatiosInput } = await import("./parse-ratios");
const { parseBriefInput } = await import("./parse-brief");
const { parseFinanceFigures } = await import("../finance-generate");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-parse-cancel",
  userId: "local",
  role: "owner",
};

/** One row the dictionary cannot place, so the model is asked for its bucket. */
const LEFTOVER = { figures: "Pos Rahasia Khusus (2024): 125000000" };

/** A table the importer wrote, plus a sentence of prose around it, so the naming pass runs. */
const TABLE_WITH_PROSE = {
  figures: [
    "Sheet: Laba Rugi",
    "Keterangan | 2023 | 2024",
    "[PENDAPATAN USAHA] Penjualan Produk Beku | 5400000000 | 6900000000",
    "[HARGA POKOK PENJUALAN] Bahan Baku | 3120000000 | 3980000000",
  ].join("\n"),
  proseText: "Pendapatan naik 25 persen dibanding tahun lalu.",
  locale: "id",
};

beforeEach(() => {
  asked.length = 0;
  next = { text: "{}" };
});

describe("the ratios parse's bucket assist", () => {
  it("hands the request's cancel to the model call", async () => {
    next = { text: JSON.stringify({ assignments: [] }) };
    const controller = new AbortController();
    await parseRatiosFigures(tenant, LEFTOVER, controller.signal);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.signal).toBe(controller.signal);
  });

  it("passes the cancel through the dispatch the route uses", async () => {
    next = { text: JSON.stringify({ assignments: [] }) };
    const controller = new AbortController();
    await parseRatiosInput(tenant, LEFTOVER, controller.signal);
    expect(asked[0]?.signal).toBe(controller.signal);
  });

  it("leaves the call without a signal when the request has none", async () => {
    next = { text: JSON.stringify({ assignments: [] }) };
    await parseRatiosFigures(tenant, LEFTOVER);
    expect(asked[0]).not.toHaveProperty("signal");
  });

  it("stops the parse on a cancel instead of recording it as a model that could not place the label", async () => {
    const controller = new AbortController();
    next = { text: "", before: () => controller.abort(new Error("client left")), fail: new Error("socket closed") };
    await expect(parseRatiosFigures(tenant, LEFTOVER, controller.signal)).rejects.toMatchObject({
      code: "aborted",
      status: 499,
    });
  });

  it("still records a model that failed when nobody cancelled", async () => {
    next = { text: "", fail: new Error("socket closed") };
    const parsed = await parseRatiosFigures(tenant, LEFTOVER, new AbortController().signal);
    expect(parsed.modelAssist).toMatchObject({ asked: 1, placed: 0, error: "bucket_assist_failed" });
  });
});

describe("the brief's figures parse", () => {
  it("hands the request's cancel to the model call that reads prose figures", async () => {
    next = {
      text: JSON.stringify({
        items: [{ label: "Gaji", period: "2025", amount: 8500000, currency: "IDR", category: "opex" }],
      }),
    };
    const controller = new AbortController();
    await parseBriefInput(
      tenant,
      { figures: "Nama: Budi Santoso\nGaji Januari: 8500000", locale: "id" },
      controller.signal,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.signal).toBe(controller.signal);
  });

  it("stops on a cancel instead of dropping the naming pass and carrying on", async () => {
    const controller = new AbortController();
    next = { text: "", before: () => controller.abort(new Error("client left")), fail: new Error("socket closed") };
    await expect(parseFinanceFigures(tenant, TABLE_WITH_PROSE, controller.signal)).rejects.toMatchObject({
      code: "aborted",
      status: 499,
    });
    expect(asked).toHaveLength(1);
  });

  it("still carries on without the names when the naming pass failed and nobody cancelled", async () => {
    next = { text: JSON.stringify({ categories: {} }), fail: new Error("socket closed") };
    const parsed = await parseFinanceFigures(tenant, TABLE_WITH_PROSE, new AbortController().signal);
    expect(parsed.source).toBe("table");
    expect(parsed.items.length).toBeGreaterThan(0);
  });
});
