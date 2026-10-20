import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensurePortalOwner } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import type { ChatFinanceFigures } from "@agentforge/core/chat-documents";
import { getFinanceTaskModule, type FinanceTask } from "@agentforge/core/finance";
import type { DeskPath } from "@agentforge/core/tools/files";
import type { WorkCard } from "../work-cards";

const asked: Array<Record<string, unknown>> = [];

function narrationFor(task: FinanceTask): string {
  const module = getFinanceTaskModule(task);
  const sections = (module?.sections ?? []).map((section) => ({
    id: section.id,
    heading: section.title.en,
    body: "The position reads as steady across the periods shown.",
    metrics: [],
  }));
  return JSON.stringify({
    title: "Figures review",
    sections:
      sections.length > 0
        ? sections
        : [{ heading: "Overview", body: "The position reads as steady across the periods shown.", metrics: [] }],
    assumptions: ["Figures as given."],
  });
}

let currentTask: FinanceTask = "ratios";

vi.mock("../job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../job-regen")>();
  return {
    ...actual,
    collectJobAssistantRun: async (options: Record<string, unknown>) => {
      asked.push(options);
      return { text: narrationFor(currentTask), model: "stub-model" };
    },
  };
});

vi.mock("../finance-tasks/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finance-tasks/live")>();
  return { ...actual, requireLive: () => ({}), resolveModel: () => "stub-model" };
});

vi.mock("../knowledge-ingest", () => ({
  upsertWorkSource: async (_tenant: TenantContext, _card: WorkCard) => ({ status: "skipped" as const, reason: "test" }),
  ingestWorkSource: () => {},
}));

const { runFinanceTaskWorker, financeTaskTool, FINANCE_TASK_TOOL_KEY } = await import("./finance-task-tool");
const { withWorkerChannel } = await import("./worker-channel");
const { withRunContext } = await import("../run-context");
const { saveDeskFigures } = await import("../chat-documents/desk-copy");
const { createDeskRoot } = await import("../desk-files/store");
const { privateFolderFor } = await import("../desk-files/private-uploads");
const { artifactStore } = await import("../artifacts");
const { resetObjectStoreForTests } = await import("../tenant-storage");
await import("../tenant-storage-db");

process.env.AGENTFORGE_SECRETS_KEY = "7c2e9a41d05b38f6e1a4c7d290b5f83e6a1d4c09b72e5f8a3d6c1b09e4f72a58";

const STATEMENTS = [
  "Sheet: Laporan Keuangan",
  "Label | 2024 | 2023",
  "Kas dan setara kas | 500 | 400",
  "Piutang usaha | 300 | 250",
  "Persediaan | 200 | 180",
  "Utang usaha | 250 | 200",
  "Ekuitas | 700 | 600",
  "Pendapatan | 1000 | 900",
  "Beban pokok penjualan | 600 | 540",
  "Beban operasional | 250 | 230",
].join("\n");

const ANNUAL_PL = [
  "Sheet: PL",
  "Item | 2023 | 2024",
  "Revenue | 1000000 | 1200000",
  "COGS | 400000 | 480000",
  "Opex | 300000 | 330000",
  "Zorblax fees | 20000 | 25000",
].join("\n");

const APPRAISAL_SENTENCE = "Outlay $200,000. Year 1 $60,000, year 2 $75,000, year 3 $90,000.";

const CASH_BOOK_NO_OPENING = [
  "Sheet: Arus Kas",
  "Keterangan | Jan 2024 | Feb 2024 | Mar 2024",
  "Kas masuk | 20000000 | 22000000 | 25000000",
  "Kas keluar | 26000000 | 21000000 | 20000000",
].join("\n");

let tenant: TenantContext;

beforeAll(async () => {
  const owner = await ensurePortalOwner(db, {
    tenantId: "fin-worker-tenant",
    orgId: "fin-worker-org",
    userId: "fin-worker-user",
    role: "owner",
  });
  tenant = {
    tenantId: "fin-worker-tenant",
    organizationId: "fin-worker-org",
    workspaceId: owner.workspaceId,
    userId: "fin-worker-user",
    role: "owner",
  };
});

afterEach(() => {
  asked.length = 0;
  resetObjectStoreForTests();
});

function figures(figuresText: string): ChatFinanceFigures {
  return { figuresText, proseText: "", sheetNames: [], skipped: [] };
}

async function attach(name: string, figuresText: string): Promise<string> {
  const saved = await saveDeskFigures(tenant, name, figures(figuresText));
  if (!saved) {
    throw new Error("figures file not saved");
  }
  return saved.path;
}

type Channel = { userText?: string; signal?: AbortSignal };

function run(args: Record<string, unknown>, channel: Channel = {}) {
  return withRunContext({ threadId: "thread-fin", agentId: "agent-fin", locale: "en" }, () =>
    withWorkerChannel({ emit: () => {}, ...channel }, () =>
      runFinanceTaskWorker(args as Parameters<typeof runFinanceTaskWorker>[0], tenant),
    ),
  );
}

describe("finance_task, a good run", () => {
  it("runs ratios from a balance sheet and P&L file and returns a checked result with facts", async () => {
    currentTask = "ratios";
    const file = await attach("statements.xlsx", STATEMENTS);
    const out = await run({ request: "How healthy is this company?", file });
    expect(out).toMatchObject({ ok: true, task: "ratios", artifact: { kind: "finance" } });
    if (!out.ok) {
      throw new Error("expected ok");
    }
    expect(out.artifact.id).toEqual(expect.any(String));
    expect(artifactStore().get(tenant, out.artifact.id as string)).not.toBeNull();
    expect(out.headline.length).toBeGreaterThan(0);
    expect(out.headline.length).toBeLessThanOrEqual(4);
    expect(out.facts.length).toBeGreaterThan(0);
    expect(out.facts.length).toBeLessThanOrEqual(3000);
    expect(out.checks).toEqual({ passed: true, flagged: 0, removed: 0 });
    expect(asked.length).toBeGreaterThan(0);
  });
});

describe("finance_task, the figures file", () => {
  it("refuses a figures file whose newest version an agent wrote", async () => {
    const file = await attach("forged.xlsx", STATEMENTS);
    const agent = { kind: "agent", runId: "run-x", mode: "chat" } as const;
    await createDeskRoot(tenant, agent).write(file as DeskPath, JSON.stringify(figures(ANNUAL_PL)), agent);
    const out = await run({ request: "How healthy is this company?", file, task: "ratios" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "file" } });
    expect(asked).toHaveLength(0);
  });

  it("refuses a file only an agent ever wrote", async () => {
    const path = `uploads/${privateFolderFor(tenant.userId)}/agent-only.figures.json`;
    const agent = { kind: "agent", runId: "run-y", mode: "chat" } as const;
    await createDeskRoot(tenant, agent).write(path as DeskPath, JSON.stringify(figures(STATEMENTS)), agent);
    const out = await run({ request: "How healthy is this company?", file: path, task: "ratios" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "file" } });
  });

  it("refuses a path in another person's folder", async () => {
    const other = `uploads/${privateFolderFor("someone-else")}/statements.figures.json`;
    const out = await run({ request: "How healthy is this company?", file: other, task: "ratios" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "file" } });
  });

  it("refuses a path that climbs out of the folder", async () => {
    const climbing = `uploads/${privateFolderFor(tenant.userId)}/../${privateFolderFor("x")}/a.figures.json`;
    const out = await run({ request: "How healthy is this company?", file: climbing, task: "ratios" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "file" } });
  });

  it("refuses a file that is not a figures file, and one that does not exist", async () => {
    const md = `uploads/${privateFolderFor(tenant.userId)}/statements.md`;
    const missing = `uploads/${privateFolderFor(tenant.userId)}/nothing.figures.json`;
    for (const file of [md, missing, "notes/plan.figures.json"]) {
      const out = await run({ request: "How healthy is this company?", file, task: "ratios" });
      expect(out, file).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "file" } });
    }
  });
});

describe("finance_task, what it asks", () => {
  it("asks for the task with at most three choices when the fit is not clear", async () => {
    const file = await attach("pl.xlsx", ANNUAL_PL);
    const out = await run({ request: "What do these figures say?", file });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "task" } });
    if (out.ok || out.reason !== "needs_input") {
      throw new Error("expected an ask");
    }
    expect(out.ask.choices?.length ?? 0).toBeGreaterThan(0);
    expect(out.ask.choices?.length ?? 0).toBeLessThanOrEqual(3);
    expect(asked).toHaveLength(0);
  });

  it("asks for the discount rate when the appraisal has none", async () => {
    const file = await attach("project.xlsx", APPRAISAL_SENTENCE);
    const out = await run({ request: "Is this project worth doing?", file, task: "appraisal" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "discountRatePercent" } });
    expect(asked).toHaveLength(0);
  });

  it("does not take a rate the model wrote into the request", async () => {
    const file = await attach("project-b.xlsx", APPRAISAL_SENTENCE);
    const out = await run(
      { request: "Is this project worth doing at a 15% discount rate?", file, task: "appraisal" },
      { userText: "Is this project worth doing?" },
    );
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "discountRatePercent" } });
  });

  it("runs the appraisal with the rate the person typed", async () => {
    currentTask = "appraisal";
    const file = await attach("project-c.xlsx", APPRAISAL_SENTENCE);
    const out = await run(
      { request: "Is this project worth doing?", file, task: "appraisal", answers: { discountRatePercent: 12 } },
      { userText: "Use a discount rate of 12%." },
    );
    expect(out).toMatchObject({ ok: true, task: "appraisal" });
    if (!out.ok) {
      throw new Error("expected ok");
    }
    expect(out.notes.map((note) => note.code)).not.toContain("default_discount_rate");
    expect(out.facts).toContain("NPV @ 12%");
  });

  it("asks again when the rate appears only inside an attached file block", async () => {
    const file = await attach("project-d.xlsx", APPRAISAL_SENTENCE);
    const userText = ["Is this worth it?", "--- project.xlsx ---", "Discount rate 12% per year", ""].join("\n");
    const out = await run(
      { request: "Is this project worth doing?", file, task: "appraisal", answers: { discountRatePercent: 12 } },
      { userText },
    );
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "discountRatePercent" } });
  });

  it("asks for the opening cash when the cash book has no opening row", async () => {
    const file = await attach("cash.xlsx", CASH_BOOK_NO_OPENING);
    const out = await run({ request: "How long will our cash last?", file, task: "cashflow" });
    expect(out).toMatchObject({ ok: false, reason: "needs_input", ask: { field: "openingCash" } });
  });

  it("runs the cash flow with the opening cash the person typed", async () => {
    currentTask = "cashflow";
    const file = await attach("cash-b.xlsx", CASH_BOOK_NO_OPENING);
    const out = await run(
      { request: "How long will our cash last?", file, task: "cashflow", answers: { openingCash: 50_000_000 } },
      { userText: "We opened with 50 juta in the bank." },
    );
    expect(out).toMatchObject({ ok: true, task: "cashflow" });
    if (!out.ok) {
      throw new Error("expected ok");
    }
    expect(out.notes.map((note) => note.code)).not.toContain("no_opening_cash");
    const jan = (out.facts.split("\n").find((line) => line.startsWith("| Jan 2024 |")) ?? "")
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell !== "");
    expect(Number(jan.at(-1)) - Number(jan.at(-2))).toBe(50_000_000);
  });
});

describe("finance_task, cancel and registration", () => {
  it("answers cancelled when the run's signal is already aborted", async () => {
    const file = await attach("statements-c.xlsx", STATEMENTS);
    const controller = new AbortController();
    controller.abort();
    const out = await run({ request: "How healthy is this company?", file }, { signal: controller.signal });
    expect(out).toMatchObject({ ok: false, reason: "cancelled", code: "cancelled" });
    expect(asked).toHaveLength(0);
  });

  it("is a user_content tool under its own key", () => {
    expect(FINANCE_TASK_TOOL_KEY).toBe("finance_task");
    expect(financeTaskTool.key).toBe("finance_task");
    expect(financeTaskTool.trust).toBe("user_content");
  });
});
