import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-request-array-caps-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

type RouterModule = typeof import("../router");
type LimitsModule = typeof import("../request-limits");
let router: RouterModule;
let limits: LimitsModule;

const brief = {
  title: "Margins held while cash thinned",
  sections: [{ heading: "Revenue grew", body: "Revenue reached 1200 in 2026.", tables: [], metrics: [] }],
  assumptions: ["Figures are unaudited."],
  computed: { metrics: [], tables: [] },
};

function post(path: string, body: unknown): Promise<HostResult> {
  const request: HostRequest = { method: "POST", path, query: {}, params: {}, headers: {}, body };
  return router.dispatch(request);
}

function status(result: HostResult): number {
  return result.status;
}

function errorOf(result: HostResult): { code: string; message: string } {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body as { error: { code: string; message: string } }).error;
}

function many<T>(count: number, make: () => T): T[] {
  return Array.from({ length: count }, make);
}

beforeAll(async () => {
  router = await import("../router");
  limits = await import("../request-limits");
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("request arrays are capped before they are parsed", () => {
  it("still exports a normal-size result with flagged figures", async () => {
    const flagged = many(25, () => ({ section: 0, text: "99999" }));
    const result = await post("/api/v1/finance/export", { result: { brief, guard: { flagged, total: 25 } } });
    expect(status(result)).toBe(200);
    expect(result.type).toBe("bytes");
  });

  it("refuses 100,001 well-formed flagged figures with a 400", async () => {
    const flagged = many(100_001, () => ({ section: 0, text: "1" }));
    const result = await post("/api/v1/finance/export", { result: { brief, guard: { flagged, total: 1 } } });
    expect(status(result)).toBe(400);
    expect(errorOf(result).code).toBe("invalid_request");
  });

  it("refuses 100,001 malformed flagged figures with a 400", async () => {
    const flagged = many(100_001, () => ({}));
    const result = await post("/api/v1/finance/export", { result: { brief, guard: { flagged, total: 1 } } });
    expect(status(result)).toBe(400);
  });

  it("stops the export schema at the length check instead of collecting an issue per element", async () => {
    const { exportRequestSchema } = await import("./finance-export");
    const flagged = many(100_001, () => ({}));
    const parsed = exportRequestSchema.safeParse({ result: { brief, guard: { flagged, total: 1 } } });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? 0 : parsed.error.issues.length).toBeLessThan(10);
  });

  it("refuses an export whose brief has too many sections, naming the cap", async () => {
    const sections = many(limits.REQUEST_ARRAY_MAX + 1, () => ({ heading: "h", body: "b" }));
    const result = await post("/api/v1/finance/export", { brief: { ...brief, sections } });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses a nested array over the cap inside result.brief", async () => {
    const rows = many(limits.REQUEST_ARRAY_MAX + 1, () => ["a", 1]);
    const tables = [{ name: "t", columns: ["a", "b"], rows }];
    const result = await post("/api/v1/finance/export", {
      result: { brief: { ...brief, computed: { metrics: [], tables } } },
    });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized array on the Word export of a brief", async () => {
    const assumptions = many(limits.REQUEST_ARRAY_MAX + 1, () => "x");
    const result = await post("/api/v1/finance/docx", { brief: { ...brief, assumptions } });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized array on the Market Word export", async () => {
    const result = await post("/api/v1/market/docx", {
      briefing: { failures: many(limits.REQUEST_ARRAY_MAX + 1, () => "x") },
    });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized array on a finance section regenerate", async () => {
    const assumptions = many(limits.REQUEST_ARRAY_MAX + 1, () => "x");
    const result = await post("/api/v1/finance/regenerate", { brief: { ...brief, assumptions }, sectionIndex: 0 });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized finance task body before it reaches the runner", async () => {
    const items = many(limits.REQUEST_ARRAY_MAX + 1, () => ({ label: "Sales", period: "2026", amount: 1 }));
    const result = await post("/api/v1/finance/stream", { task: "cashflow", items });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized document draft on the Word export", async () => {
    const sections = many(limits.REQUEST_ARRAY_MAX + 1, () => ({ heading: "h", body: "b" }));
    const result = await post("/api/v1/documents/docx", { title: "Memo", sections });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized presentation outline on the PowerPoint export", async () => {
    const slides = many(limits.REQUEST_ARRAY_MAX + 1, () => ({ heading: "h", bullets: ["b"] }));
    const result = await post("/api/v1/presentations/pptx", { title: "Deck", slides });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses many lists that are each under the cap but together over the item budget", async () => {
    const lists = Math.ceil(limits.REQUEST_ITEMS_MAX / limits.REQUEST_ARRAY_MAX) + 1;
    const sections = many(lists, () => ({
      heading: "h",
      body: "b",
      metrics: many(limits.REQUEST_ARRAY_MAX, () => 1),
    }));
    const result = await post("/api/v1/finance/docx", { brief: { ...brief, sections } });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ITEMS_MAX));
  });

  it("refuses an oversized clip list inside an edit op", async () => {
    const clips = many(limits.REQUEST_ARRAY_MAX + 1, () => ({}));
    const ops = [{ type: "add_track", payload: { track: {}, clips } }];
    const result = await post("/api/v1/edit/projects/nope/ops", { ops });
    expect(status(result)).toBe(400);
    expect(errorOf(result).message).toContain(String(limits.REQUEST_ARRAY_MAX));
  });

  it("refuses an oversized legal deliverables list", async () => {
    const result = await post("/api/v1/legal/matters", {
      title: "NDA",
      side: { role: "", party: "Acme", counterparty: "" },
      workType: "review",
      deliverables: many(100_001, () => "redline"),
    });
    expect(status(result)).toBe(400);
  });
});

describe("assertArraysWithin", () => {
  it("passes a value at the cap and refuses one past it, at any depth", () => {
    expect(() => limits.assertArraysWithin({ a: many(limits.REQUEST_ARRAY_MAX, () => 0) }, "body")).not.toThrow();
    expect(() =>
      limits.assertArraysWithin({ a: [{ b: [many(limits.REQUEST_ARRAY_MAX + 1, () => 0)] }] }, "body"),
    ).toThrow(/body/);
  });

  it("counts every list together, not only each one", () => {
    const each = many(limits.REQUEST_ARRAY_MAX, () => 0);
    const lists = Math.floor(limits.REQUEST_ITEMS_MAX / limits.REQUEST_ARRAY_MAX);
    expect(() =>
      limits.assertArraysWithin(
        many(lists, () => each),
        "body",
      ),
    ).toThrow(/in all/);
    expect(() =>
      limits.assertArraysWithin(
        many(lists - 1, () => each),
        "body",
      ),
    ).not.toThrow();
  });

  it("ignores scalars, null and undefined", () => {
    for (const value of [undefined, null, "text", 4, true]) {
      expect(() => limits.assertArraysWithin(value, "body")).not.toThrow();
    }
  });
});
