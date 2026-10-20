import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTurn } from "@/components/chat-turn";
import { FinanceCard, FinanceCards } from "@/components/chat-finance-card";
import { FINANCE_TASK_TOOL_KEY, readFinanceResult, type FinanceCardModel } from "@/components/tool-rows/finance-result";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import { toolActivityLabel, toolCallSummary } from "@/lib/tool-labels";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const INPUT = { request: "How healthy are these ratios?" };
const OUTPUT = {
  ok: true,
  artifact: { id: "fin-1", kind: "finance", title: "Ratio health check" },
  task: "ratios",
  headline: [
    { label: "Current ratio", value: "1.8", unit: "x" },
    { label: "Debt to equity", value: "0.6", unit: "x" },
    { label: "Net margin", value: "12.4", unit: "%" },
  ],
  summary: "Liquidity is sound; margins are thin.",
  facts: "current_ratio=1.8",
  checks: { passed: true, flagged: 0, removed: 0 },
  notes: [],
};

const RATIOS_REPORT = {
  task: "ratios",
  title: "Ratio health check",
  locale: "en",
  summary: [{ label: "Current ratio", value: 1.8, unit: "x", flag: "good" }],
  tables: [],
  charts: [],
  flags: [],
  notes: [{ heading: "What it means", body: "Liquidity is sound." }],
};

const BRIEF = {
  title: "Quarterly brief",
  sections: [{ heading: "Overview", body: "Revenue grew by a fifth." }],
};

const count = (markup: string, testId: string) => markup.split(`data-testid="${testId}"`).length - 1;

function model(over: Partial<FinanceCardModel> = {}): FinanceCardModel {
  const read = readFinanceResult(INPUT, OUTPUT);
  if (!read) {
    throw new Error("fixture does not read");
  }
  return { ...read, ...over };
}

function card(props: Partial<Parameters<typeof FinanceCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <FinanceCard model={props.model ?? model()} {...props} />
    </MemoryRouter>,
  );
}

function artifact(meta: Record<string, unknown> | undefined, body = "# Ratio health check\n\nThe **stored** text.") {
  return { id: "fin-1", title: "Ratio health check", body, meta };
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the finance card", () => {
  it("shows the task line, the title and the headline figures", () => {
    const html = card();
    expect(count(html, "chat-finance-card")).toBe(1);
    expect(html).toContain('data-artifact-id="fin-1"');
    expect(html).toContain("Finance · Is the business healthy?");
    expect(html).toMatch(/data-testid="chat-finance-title"[^>]*>Ratio health check</);
    expect(count(html, "chat-finance-figure")).toBe(3);
    expect(html).toContain("Current ratio");
    expect(html).toContain("1.8 x");
    expect(html).toContain("12.4 %");
    expect(html).not.toContain('data-failed="true"');
  });

  it("names the task from the Finance catalog", () => {
    const html = card({ model: model({ task: "cashflow" }) });
    expect(html).toContain("Finance · How long will the cash last?");
  });

  it("shows the danger line when the check flagged figures", () => {
    const html = card({ model: model({ checksPassed: false, flagged: 2 }) });
    expect(html).toMatch(/<p[^>]*text-\[var\(--danger\)\][^>]*data-testid="chat-finance-checks"[^>]*>/);
    expect(html).toContain("The check flagged 2 figures");
  });

  it("shows the danger line when the check removed figures", () => {
    const html = card({ model: model({ checksPassed: false, removed: 1 }) });
    expect(html).toContain('data-failed="true"');
    expect(html).toContain("The check removed 1 figure");
  });

  it("shows the danger line when there are notes", () => {
    const notes = [
      { code: "unplaced_rows", message: "Two rows were not placed." },
      { code: "default_discount_rate", message: "A 10% rate was used." },
    ];
    const html = card({ model: model({ notes }) });
    expect(html).toContain('data-failed="true"');
    expect(html).toContain("2 notes");
  });

  it("does not call figures checked when the answer said nothing about the checks", () => {
    const html = card({ model: model({ checksPassed: false }) });
    expect(html).toContain('data-failed="true"');
    expect(html).toContain("The check did not report on these figures");
  });

  it("has Open and the two downloads, and no PowerPoint", () => {
    const html = card();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="chat-finance-open"[^>]*>Open<\/button>/);
    expect(count(html, "chat-finance-download-xlsx")).toBe(1);
    expect(count(html, "chat-finance-download-docx")).toBe(1);
    expect(html).not.toContain("chat-finance-download-pptx");
    expect(count(html, "chat-finance-view")).toBe(0);
  });

  it("escapes a title that looks like markup", () => {
    const html = card({ model: model({ title: '<img src=x onerror="alert(1)">' }) });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the card, open", () => {
  it("shows the loading line until the artifact arrives", () => {
    const html = card({ defaultOpen: true });
    expect(count(html, "chat-finance-view")).toBe(1);
    expect(html).toContain("Opening the result");
  });

  it("renders the ratios result panel from the stored report", () => {
    const html = card({
      defaultOpen: true,
      initialArtifact: artifact({ task: "ratios", report: RATIOS_REPORT, guard: { flagged: [], total: 0 } }),
    });
    expect(count(html, "finance-ratios-result")).toBe(1);
    expect(html).toContain("Liquidity is sound.");
    expect(count(html, "chat-finance-text")).toBe(0);
  });

  it("renders the brief panel from a stored brief", () => {
    const html = card({
      model: model({ task: "brief", title: "Quarterly brief" }),
      defaultOpen: true,
      initialArtifact: artifact({ task: "brief", brief: BRIEF, guard: { flagged: [], total: 0 } }),
    });
    expect(count(html, "finance-preview")).toBe(1);
    expect(html).toContain("Revenue grew by a fifth.");
    expect(count(html, "finance-section-regen")).toBe(0);
  });

  it.each([
    ["budget", "budget-result"],
    ["cashflow", "cashflow-result"],
    ["appraisal", "appraisal-result"],
  ] as const)("renders the %s result panel from its stored report", (task, testId) => {
    const report = { ...RATIOS_REPORT, task, title: `A ${task} report` };
    const html = card({
      model: model({ task, title: `A ${task} report` }),
      defaultOpen: true,
      initialArtifact: artifact({ task, report, guard: { flagged: [], total: 0 } }),
    });
    expect(count(html, testId)).toBe(1);
    expect(count(html, "chat-finance-text")).toBe(0);
  });

  it("falls back to the markdown when no report was stored", () => {
    const html = card({ defaultOpen: true, initialArtifact: artifact({ task: "ratios" }) });
    expect(count(html, "chat-finance-text")).toBe(1);
    expect(html).toContain("<strong>stored</strong>");
    expect(count(html, "finance-ratios-result")).toBe(0);
  });

  it("lists every note from the check in the open view", () => {
    const html = card({
      model: model({ notes: [{ code: "unplaced_rows", message: "Two rows were not placed." }] }),
      defaultOpen: true,
      initialArtifact: artifact({ task: "ratios" }),
    });
    expect(count(html, "chat-finance-note")).toBe(1);
    expect(html).toContain("Two rows were not placed.");
  });

  it("loads the artifact once and exports through the Finance export route", () => {
    const text = source("../components/chat-finance-card.tsx");
    expect(text).toContain("getArtifact(id)");
    expect(text).toContain("downloadFinanceExport(");
    expect(text).toContain("regeneratingIndex={null}");
    expect(text).toContain('role="alert"');
  });
});

describe("a card with nothing to open", () => {
  it("offers no Open and no Download", () => {
    const html = card({ model: model({ artifactId: null }), defaultOpen: true });
    expect(count(html, "chat-finance-open")).toBe(0);
    expect(count(html, "chat-finance-download-xlsx")).toBe(0);
    expect(count(html, "chat-finance-view")).toBe(0);
    expect(html).toContain("could not be saved");
    expect(html).not.toContain("data-artifact-id");
  });
});

describe("the card in Indonesian", () => {
  it("is written from the id catalog", () => {
    applyLocale("id");
    const html = card({ model: model({ checksPassed: false, flagged: 2 }) });
    expect(html).toContain(">Buka</button>");
    expect(html).not.toContain("The check flagged");
    expect(html).toContain("Keuangan · Apakah usaha ini sehat?");
    expect(html).not.toContain("Is the business healthy?");
  });
});

describe("the cards of a turn", () => {
  const call = (status: "started" | "completed", key = FINANCE_TASK_TOOL_KEY, output: unknown = OUTPUT) => ({
    key,
    status,
    input: INPUT,
    output: status === "completed" ? output : undefined,
  });
  const render = (tools: ReturnType<typeof call>[]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <FinanceCards tools={tools} />
      </MemoryRouter>,
    );

  it("draws one card for a finished call", () => {
    expect(count(render([call("completed")]), "chat-finance-card")).toBe(1);
  });

  it("draws nothing while running, for another tool, a refusal or a question back", () => {
    expect(render([call("started")])).toBe("");
    expect(render([call("completed", "research_dossier")])).toBe("");
    expect(
      render([call("completed", FINANCE_TASK_TOOL_KEY, { ok: false, reason: "failed", code: "x", message: "no" })]),
    ).toBe("");
    const ask = {
      ok: false,
      reason: "needs_input",
      ask: { field: "openingCash", question: "What is the opening cash?" },
    };
    expect(render([call("completed", FINANCE_TASK_TOOL_KEY, ask)])).toBe("");
  });
});

describe("finance inside a Chat turn", () => {
  const saved = [
    {
      type: "tool_call" as const,
      toolKey: FINANCE_TASK_TOOL_KEY,
      status: "completed" as const,
      input: INPUT,
      output: OUTPUT,
    },
    { type: "text" as const, text: "The scorecard is ready." },
  ];

  function turn(content: unknown): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ChatTurn role="assistant" content={content} />
      </MemoryRouter>,
    );
  }

  it("rebuilds the card from a saved turn, outside the Thinking disclosure, with no job embed", () => {
    const html = turn(saved);
    expect(count(html, "chat-finance-card")).toBe(1);
    expect(html.indexOf('data-testid="chat-finance-card"')).toBeGreaterThan(html.indexOf("</details>"));
    expect(html).not.toContain("message-embed");
  });

  it("labels the Thinking row with the title and never prints the facts", () => {
    const html = turn(saved);
    const row = html.slice(html.indexOf('data-testid="message-tool"'), html.indexOf("</details>"));
    expect(row).toContain("Finance · Ratio health check");
    expect(row).not.toContain("current_ratio");
  });

  it("has a progress label and a failure summary", () => {
    expect(toolActivityLabel(FINANCE_TASK_TOOL_KEY)).toBe("Working");
    const refused = { ok: false, reason: "failed", code: "x", message: "The figures could not be read." };
    expect(toolCallSummary(FINANCE_TASK_TOOL_KEY, INPUT, refused)).toBe("Finance · The figures could not be read.");
    const ask = { ok: false, reason: "needs_input", ask: { field: "rate", question: "Which discount rate?" } };
    expect(toolCallSummary(FINANCE_TASK_TOOL_KEY, INPUT, ask)).toBe("Finance · Which discount rate?");
  });
});
