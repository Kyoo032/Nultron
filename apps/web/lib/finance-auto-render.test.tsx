/**
 * What the prompt-first Finance page draws, rendered to static markup in both languages.
 *
 * `renderToStaticMarkup` runs no effects and no handlers, so this is the frame the page opens on, and
 * the frame each part draws for a fixed answer from `POST /api/v1/finance/auto`. The flow itself (drop,
 * read, press) is driven live; what is held here is the copy, the testids and the rule that nothing in
 * these frames offers a paid step except the one button.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceAutoPreview } from "@/components/finance-auto-preview";
import { AutoFit, AutoMore, AutoNotes, noteLines } from "@/components/finance-auto-parts";
import { FinanceStudio } from "@/components/finance-studio";
import { parseFinanceAuto, type FinanceAutoAnswer } from "./finance-auto-client";
import type { FinanceAutoSource } from "./finance-auto-io";
import { publishGate, resetGateStateForTests } from "./gate-state";
import { resetGatewayBlockedForTests } from "./gateway-blocked";
import type { GatewayGatePayload } from "./gateway-gate";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { resetSettingsReadForTests } from "./settings-read";

beforeEach(() => {
  resetGateStateForTests();
  resetGatewayBlockedForTests();
  resetSettingsReadForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
  resetLocaleForTests();
});

function page(element: ReactElement, url = "/finance"): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[url]}>{element}</MemoryRouter>);
}

const RANKED = [
  { task: "cashflow", score: 0.9, signals: [] },
  { task: "budget", score: 0.4, signals: [] },
  { task: "brief", score: 0.3, signals: [] },
  { task: "ratios", score: 0.1, signals: [] },
  { task: "appraisal", score: 0, signals: [] },
];

const PREVIEW = {
  task: "cashflow",
  title: "Cash flow",
  locale: "en",
  summary: [
    { label: "Runway", value: 4.5, unit: "months", flag: "risk" },
    { label: "Closing cash", value: 1_250_000.5 },
    { label: "Opening", value: null },
  ],
  tables: [
    { id: "inputs", title: "Inputs", columns: ["Label"], rows: [["a"]] },
    { id: "calc", title: "Calc", columns: ["Label"], rows: [["b"]] },
    {
      id: "runway",
      title: "Runway by month",
      columns: ["Month", "Net"],
      rows: Array.from({ length: 15 }, (_unused, index) => [`M${index}`, index * 1000]),
    },
  ],
  charts: [
    { id: "cash-balance", title: "Cash balance", kind: "line", categories: ["Jan", "Feb"], series: [{ name: "Cash", values: [10, 5] }] },
  ],
  flags: [{ level: "risk", text: "Cash runs out in month 5." }],
  notes: [],
};

function answerWith(over: Record<string, unknown> = {}): FinanceAutoAnswer {
  const parsed = parseFinanceAuto({
    fits: { top: "cashflow", confidence: "high", ranked: RANKED },
    task: "cashflow",
    input: { items: [], params: {} },
    preview: PREVIEW,
    rowsUsed: 8,
    unplaced: [{ label: "Misc", period: "Jan" }, { label: "Other", period: "" }],
    warnings: [{ code: "unplaced_rows", message: "dev", detail: ["2"] }],
    pii: { count: 3, kinds: ["name"] },
    prompt: "How long does my cash last?",
    promptSource: "user",
    ...over,
  });
  if (!parsed) {
    throw new Error("fixture is not a valid answer");
  }
  return parsed;
}

const FILE: FinanceAutoSource = {
  fileName: "cash.xlsx",
  figuresText: "Sheet: Jan\nCash in: 1",
  proseText: "",
  sheetNames: ["Jan", "Feb", "Mar"],
  skipped: ["Mar"],
  warnings: [{ code: "dropped_rows", message: "dev", detail: ["4 lines"] }],
  pii: { count: 1, kinds: ["name"] },
};

describe("the page /finance opens on", () => {
  it("is one prompt box, one drop zone and a Write it up button that waits for a preview, with no form and no chooser up front", () => {
    applyLocale("en");
    const html = page(<FinanceStudio />);
    expect(html).toContain('data-testid="finance-auto"');
    expect(html).toContain('data-testid="finance-auto-prompt"');
    expect(html).toContain('data-testid="finance-auto-drop"');
    expect(html).toContain('data-testid="finance-auto-input"');
    expect(html).toContain('data-testid="finance-guide-lead"');
    expect(html).toContain(t("finance.guide.lead"));
    expect(html).toContain(t("finance.auto.promptPlaceholder"));
    expect(html).toContain('data-testid="finance-auto-empty"');
    // The one paid step is a button, and it is not pressable before there is anything to write.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="finance-auto-write"/);
    expect(html).toContain('data-testid="finance-auto-write-note"');
    expect(html).toContain(t("finance.auto.writeNote"));
    // Nothing a task page asks for first.
    expect(html).not.toContain('data-testid="finance-inputs"');
    expect(html).not.toContain('data-testid="finance-parse"');
    expect(html).not.toContain('data-testid="finance-figures-input"');
  });

  it("keeps the chooser cards inside a closed More section", () => {
    applyLocale("en");
    const html = page(<FinanceStudio />);
    const more = html.slice(html.indexOf('data-testid="finance-more"'));
    expect(html).toMatch(/<details[^>]*data-testid="finance-more"/);
    expect(html.slice(html.lastIndexOf("<details", html.indexOf('data-testid="finance-more"')))).not.toMatch(
      /^<details[^>]*\sopen=/,
    );
    expect(more).toContain('data-testid="finance-guide-choices"');
    for (const task of ["brief", "cashflow", "budget", "appraisal", "ratios"]) {
      expect(more).toContain(`data-testid="finance-guide-${task}"`);
    }
    expect(more).toContain('data-testid="finance-auto-figures"');
    expect(more).toContain('data-testid="finance-auto-model"');
    // With no figures yet there is nothing to switch task on or to check.
    expect(more).not.toContain("finance-auto-switch-");
    expect(more).not.toContain('data-testid="finance-auto-check-rows"');
  });

  it("reads in Indonesian on an id desk, with the same testids", () => {
    applyLocale("id");
    const html = page(<FinanceStudio />);
    expect(html).toContain("Tulis hasilnya");
    expect(html).toContain(t("finance.auto.promptPlaceholder"));
    expect(html).toContain("Opsi lain");
    expect(html).toContain('data-testid="finance-auto-prompt"');
    expect(html).toContain('data-testid="finance-auto-write"');
    expect(html).not.toContain("Write it up");
  });

  it("is still the task page, not this one, when the URL names a task", () => {
    applyLocale("en");
    for (const task of ["brief", "cashflow", "budget", "appraisal", "ratios", "nope"]) {
      const html = page(<FinanceStudio />, `/finance?task=${task}`);
      expect(html, task).not.toContain('data-testid="finance-auto"');
      expect(html, task).toContain('data-testid="finance-task-current"');
      expect(html, task).toContain('data-testid="finance-studio-prompt-bar"');
    }
  });

  it("says a key is missing on the hosted app, and still lets the free read run", () => {
    applyLocale("en");
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
    const closed: GatewayGatePayload = {
      status: "needs_key",
      allowed: false,
      grace: false,
      endpoint: "https://api.tokotokenai.com/v1",
      endpointLocked: true,
      checkedAt: null,
      lastOkAt: null,
    };
    publishGate(closed);
    const html = page(<FinanceStudio />);
    expect(html).toContain('data-testid="finance-needs-key"');
    expect(html).toContain('data-testid="finance-auto-prompt"');
    expect(html).toContain('data-testid="finance-auto-drop"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="finance-auto-write"/);
  });
});

describe("the preview", () => {
  it("draws the KPIs, the flag, the chart and the computed tables, and none of the workbook-only sheets", () => {
    applyLocale("en");
    const answer = answerWith();
    const html = page(<FinanceAutoPreview report={answer.preview as NonNullable<typeof answer.preview>} />);
    expect(html).toContain('data-testid="finance-auto-preview"');
    expect(html).toContain('data-task="cashflow"');
    expect(html).toContain(t("finance.auto.previewHint"));
    expect(html).toContain('data-testid="finance-auto-kpis"');
    expect(html).toContain("Runway");
    expect(html).toContain("4.5 months");
    expect(html).toContain("1,250,000.5");
    expect(html).toContain("—");
    expect(html).toContain('data-testid="finance-auto-flags"');
    expect(html).toContain("Cash runs out in month 5.");
    expect(html).toContain('data-testid="finance-chart-cash-balance"');
    expect(html).toContain('data-testid="finance-auto-table-runway"');
    expect(html).not.toContain('data-testid="finance-auto-table-inputs"');
    expect(html).not.toContain('data-testid="finance-auto-table-calc"');
  });

  it("opens the first table, shows twelve rows of it, and says how many it left out", () => {
    applyLocale("en");
    const answer = answerWith();
    const html = page(<FinanceAutoPreview report={answer.preview as NonNullable<typeof answer.preview>} />);
    const table = html.slice(html.indexOf('data-testid="finance-auto-table-runway"'));
    expect(html).toMatch(/<details[^>]*open=""[^>]*data-testid="finance-auto-table-runway"/);
    expect(table).toContain("M11");
    expect(table).not.toContain("M12");
    expect(html).toContain(t("finance.auto.tableMoreRows", { n: 3 }));
  });

  it("says nothing about a model: it carries no prose, and the hint says so", () => {
    applyLocale("id");
    const answer = answerWith();
    const html = page(<FinanceAutoPreview report={answer.preview as NonNullable<typeof answer.preview>} />);
    expect(html).toContain(t("finance.auto.previewHint"));
    expect(html).toContain("Belum ada yang ditulis oleh model");
  });
});

describe("Looks like", () => {
  it("names the task and how sure the read is", () => {
    applyLocale("en");
    const html = page(<AutoFit answer={answerWith()} checking={false} />);
    expect(html).toContain('data-testid="finance-auto-fit"');
    expect(html).toContain('data-task="cashflow"');
    expect(html).toContain('data-confidence="high"');
    expect(html).toContain(t("finance.tasks.cashflow.label"));
    expect(html).toContain(t("finance.auto.confidence.high"));
    expect(html).not.toContain('data-testid="finance-auto-needs"');
  });

  it("calls a low-confidence read a best guess", () => {
    applyLocale("en");
    const low = answerWith({ fits: { top: "cashflow", confidence: "low", ranked: RANKED } });
    const html = page(<AutoFit answer={low} checking />);
    expect(html).toContain('data-confidence="low"');
    expect(html).toContain(t("finance.auto.confidence.low"));
    expect(html).toContain('data-testid="finance-auto-checking"');
  });

  it("says what the task needs when a question has no figures behind it yet", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      const prompted = answerWith({ input: null, preview: null, rowsUsed: 0, unplaced: [], warnings: [] });
      const html = page(<AutoFit answer={prompted} checking={false} />);
      expect(html, locale).toContain('data-testid="finance-auto-needs"');
      expect(html, locale).toContain(t("finance.auto.needs.cashflow"));
    }
  });
});

describe("what was read", () => {
  it("lists the rows, the sheets with the one left out, the rows nothing could place, the notes and the hidden identifiers", () => {
    applyLocale("en");
    const answer = answerWith();
    const html = page(<AutoNotes answer={answer} file={FILE} lines={noteLines(answer, FILE)} />);
    expect(html).toContain('data-testid="finance-auto-rows"');
    expect(html).toContain('data-rows="8"');
    expect(html).toContain(t("finance.auto.rows", { n: 8 }));
    expect(html).toContain('data-testid="finance-auto-sheet"');
    expect(html).toContain('data-skipped="1"');
    // The sheets that were read are named, and the one that was left out is not among them.
    expect(html).toContain(t("finance.auto.sheets", { names: "Jan, Feb" }));
    expect(html).toContain('data-testid="finance-auto-unplaced"');
    expect(html).toContain("Misc (Jan)");
    expect(html).toContain("Other");
    expect(html).toContain('data-testid="finance-auto-warnings"');
    expect(html).toContain(t("finance.auto.sheetsSkipped", { names: "Mar" }));
    expect(html).toContain(t("finance.auto.warnings.unplacedRows", { n: 2, task: "2", from: "2", to: "", rate: "2" }));
    expect(html).toContain('data-testid="finance-auto-pii"');
    expect(html).toContain(t("finance.auto.pii", { n: 3 }));
  });

  it("draws nothing at all when there is nothing to say", () => {
    applyLocale("en");
    const quiet = answerWith({ input: null, preview: null, rowsUsed: 0, unplaced: [], warnings: [], pii: { count: 0 } });
    expect(page(<AutoNotes answer={quiet} file={null} lines={noteLines(quiet, null)} />)).toBe("");
  });

  it("writes every host warning in the reader's language and never prints a developer sentence for a known code", () => {
    applyLocale("id");
    const answer = answerWith({
      warnings: [
        { code: "default_discount_rate", message: "No discount rate was found, so 12% is shown.", detail: ["12"] },
        { code: "unpaired_lines", message: "3 line(s) have no partner", detail: ["3"] },
      ],
    });
    const lines = noteLines(answer, null);
    expect(lines).toContain(t("finance.auto.warnings.defaultDiscountRate", { rate: "12" }));
    expect(lines.join(" ")).not.toContain("No discount rate");
    expect(lines.join(" ")).toContain("12%");
  });
});

describe("More, once there are figures", () => {
  const props = {
    workspaceId: "ws-render",
    prompt: "Which lines went over?",
    pasted: "",
    onPasted: () => undefined,
    locked: false,
    models: [],
    model: "",
    onModel: () => undefined,
  };

  it("offers the other four tasks, best fit first, and a rows check on the one it read", () => {
    applyLocale("en");
    const html = page(<AutoMore {...props} answer={answerWith()} figures={"Sheet: Jan\nCash in: 1"} />);
    expect(html).toContain('data-testid="finance-auto-check-rows"');
    expect(html).toContain('href="/finance?task=cashflow"');
    const order = ["budget", "brief", "ratios", "appraisal"].map((task) => html.indexOf(`finance-auto-switch-${task}`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("finance-auto-switch-cashflow");
    expect(html).toContain('href="/finance?task=budget"');
  });

  it("offers neither when only a question was asked", () => {
    applyLocale("en");
    const html = page(<AutoMore {...props} answer={answerWith({ input: null, preview: null })} figures="" />);
    expect(html).not.toContain("finance-auto-switch-");
    expect(html).not.toContain('data-testid="finance-auto-check-rows"');
  });
});
