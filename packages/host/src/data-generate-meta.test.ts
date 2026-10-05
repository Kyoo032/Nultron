import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModel, TenantContext } from "@agentforge/core";
import type { WorkCard } from "./work-cards";

/**
 * A Data job saved through the REAL artifact store (the desk's SQLite and vault key in a throwaway
 * data dir), then read back. The gateway call, the Knowledge Base write and the model list are
 * mocked at the module boundary; the dataset, the SQL tool, the artifact validation and the
 * stored row are the real code. This is the test that was missing when a count in `meta.queries`
 * made the whole provenance object parse to `{}`: `./data-generate.test.ts` mocks the store.
 */
process.env.AGENTFORGE_DATA_DIR = mkdtempSync(join(tmpdir(), "agentforge-data-meta-"));

const ingested: WorkCard[] = [];
let sqlToRun: string[] = [];

const ANALYSIS = JSON.stringify({
  title: "Acme carries most of the spend",
  summary: "Two vendors, one of them large.",
  findings: [
    {
      heading: "Acme is the larger vendor",
      body: "Acme spends more than Beta.",
      sql: "SELECT vendor, SUM(spend) AS spend FROM data GROUP BY 1 ORDER BY 2 DESC",
    },
  ],
  charts: [],
});

const { runSqlTool } = await import("./sql-tool");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-data-meta",
  userId: "local",
  role: "owner",
};

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    // The model's tool loop: every SQL string goes through the real `run_sql` tool, inside the
    // dataset scope `analyzeDataset` opened, so the step counter and `onQuery` behave as live.
    collectJobAssistantRun: async (options: { model: string }) => {
      for (const sqlText of sqlToRun) {
        await runSqlTool.execute({ sql: sqlText }, tenant);
      }
      return { text: ANALYSIS, model: options.model };
    },
  };
});

vi.mock("./knowledge-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-ingest")>();
  return {
    ...actual,
    upsertWorkSource: async (_tenant: TenantContext, card: WorkCard) => {
      ingested.push(card);
      return { status: "skipped" as const, reason: "test" };
    },
  };
});

const CATALOG = ["deepseek-v4-flash", "gpt-5.6-luna"].map(
  (id): ChatModel => ({ id, label: id, provider: "openai", inputModalities: ["text"] }) as ChatModel,
);

vi.mock("./selectable-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./selectable-models")>();
  return {
    ...actual,
    listSelectableModels: () => CATALOG,
    modeCatalogPayload: () => ({ defaults: { data: "deepseek-v4-flash" } }),
  };
});

const { analyzeDataset, DATA_QUERY_META_MAX_CHARS } = await import("./data-generate");
const { artifactStore } = await import("./artifacts");

const CSV = "vendor,spend\nAcme,12000\nBeta,4100";
const GOOD_SQL = "SELECT vendor, SUM(spend) AS spend FROM data GROUP BY 1 ORDER BY 2 DESC";

describe("the provenance a saved Data analysis keeps", () => {
  beforeEach(() => {
    ingested.length = 0;
    sqlToRun = [];
    vi.stubEnv("AGENTFORGE_RUNTIME", "ai");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads back the question, model, dataset and the SQL the model ran from the real store", async () => {
    sqlToRun = [GOOD_SQL, "SELECT COUNT(*) AS n FROM data"];
    const result = await analyzeDataset(tenant, { prompt: "Who spends most?", csv: CSV, model: "deepseek-v4-flash" });

    expect(result.artifactId).toBeTruthy();
    const saved = artifactStore().get(tenant, result.artifactId as string);
    expect(saved?.mode).toBe("data");
    expect(saved?.meta).toMatchObject({
      question: "Who spends most?",
      model: "deepseek-v4-flash",
      datasetId: result.dataset.id,
      datasetName: "Pasted table",
      queries: [GOOD_SQL, "SELECT COUNT(*) AS n FROM data"],
    });
    expect(ingested[0]?.prompt).toBe("Who spends most?");
  });

  it("survives the list call the artifact shelf uses", async () => {
    sqlToRun = [GOOD_SQL];
    const result = await analyzeDataset(tenant, { prompt: "List me", csv: CSV });
    const listed = artifactStore()
      .list(tenant, "data")
      .find((item) => item.id === result.artifactId);
    expect(listed?.meta.question).toBe("List me");
    expect(listed?.meta.datasetId).toBe(result.dataset.id);
    expect(listed?.meta.queries).toEqual([GOOD_SQL]);
  });

  it("keeps a query that failed, in order, and the provenance with it", async () => {
    sqlToRun = ["SELECT nope FROM data", GOOD_SQL];
    const result = await analyzeDataset(tenant, { prompt: "Retry?", csv: CSV });
    const saved = artifactStore().get(tenant, result.artifactId as string);
    expect(saved?.meta.queries).toEqual(["SELECT nope FROM data", GOOD_SQL]);
    expect(saved?.meta.question).toBe("Retry?");
    expect(saved?.meta.datasetId).toBe(result.dataset.id);
  });

  it("saves an empty list, not a missing question, when the model ran no query", async () => {
    sqlToRun = [];
    const result = await analyzeDataset(tenant, { prompt: "No queries", csv: CSV });
    const saved = artifactStore().get(tenant, result.artifactId as string);
    expect(saved?.meta.queries).toEqual([]);
    expect(saved?.meta.question).toBe("No queries");
  });

  it("trims a very long query so one runaway string cannot bloat the row", async () => {
    const long = `SELECT vendor FROM data WHERE vendor <> '${"x".repeat(DATA_QUERY_META_MAX_CHARS * 2)}'`;
    sqlToRun = [long];
    const result = await analyzeDataset(tenant, { prompt: "Long", csv: CSV });
    const saved = artifactStore().get(tenant, result.artifactId as string);
    const stored = saved?.meta.queries?.[0] ?? "";
    expect(stored.length).toBeLessThanOrEqual(DATA_QUERY_META_MAX_CHARS + 1);
    expect(stored.startsWith("SELECT vendor FROM data")).toBe(true);
    expect(saved?.meta.question).toBe("Long");
  });
});
