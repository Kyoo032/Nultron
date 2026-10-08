import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { TenantContext } from "@agentforge/core";
import {
  REMOVED_SENTENCE_FLAG,
  UNVERIFIED_MARKER,
  type FinanceReport,
  type FinanceTaskModule,
} from "@agentforge/core/finance";
import type { JobEvent } from "@agentforge/core/jobs";
import type { WorkCard } from "../work-cards";

/**
 * The whole pipeline with the gateway replaced by a queue: one answer per call, in order — the
 * narration first, then whatever the repair asks for. Nothing here reaches the network, and the
 * gate is stubbed because this test is about the pipeline, not about who is allowed to run it.
 */
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

const { runFinanceTask, runnerMathPhases } = await import("./runner");
const { readStoredFinanceReport } = await import("./persist");
const { ADVICE_SENTENCE_FLAG } = await import("./scope");
const { artifactStore } = await import("../artifacts");

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org",
  workspaceId: "ws-finance-runner",
  userId: "local",
  role: "owner",
};

type Input = { readonly cash: number };

/**
 * A stand-in for a real task: it computes one figure, declares one section, and writes the model's
 * prose straight into the report's notes — which is what makes a marker that survived visible.
 */
const taskModule: FinanceTaskModule<Input, Input> = {
  id: "cashflow",
  inputSchema: z.object({ cash: z.number() }),
  compute: (input) => input,
  buildReport: (computed, prose, options): FinanceReport => ({
    task: "cashflow",
    title: prose.title,
    locale: options?.locale ?? "en",
    summary: [{ label: "Cash", value: computed.cash, unit: "IDR" }],
    tables: [],
    charts: [],
    flags: [],
    notes: prose.sections.map((section) => ({ heading: section.heading, body: section.body })),
  }),
  promptFacts: (computed) => `Cash: ${computed.cash}`,
  allowedNumbers: (_input, computed) => [computed.cash],
  sections: [{ id: "position", title: { id: "Posisi", en: "Position" } }],
};

function narration(body: string): string {
  return JSON.stringify({
    title: "Runway to March",
    sections: [{ id: "position", heading: "Where cash sits", body }],
    assumptions: ["Monthly figures."],
  });
}

function rewrite(body: string): string {
  return JSON.stringify({ heading: "Where cash sits", body, metrics: [] });
}

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: "How is cash?", cash: 900, locale: "en", ...extra };
}

async function run(extra: Record<string, unknown> = {}) {
  const events: JobEvent[] = [];
  const result = await runFinanceTask(taskModule, {
    tenant,
    body: body(extra),
    emit: (event) => events.push(event),
  });
  return { result, events };
}

function phases(events: readonly JobEvent[]): string[] {
  return events.filter((event) => event.type === "job.phase").map((event) => event.phase);
}

function steps(events: readonly JobEvent[]): string[] {
  return events.filter((event) => event.type === "job.step").map((event) => event.label);
}

function reset() {
  asked.length = 0;
  answers.length = 0;
  ingested.length = 0;
}

describe("runnerMathPhases", () => {
  it("names the math steps this run performs, in the task's own order", () => {
    // Everything up to the task's last shared step ran on the parse route, not here.
    expect(runnerMathPhases("cashflow")).toEqual(["runway-math"]);
    expect(runnerMathPhases("budget")).toEqual(["variance-math", "flag-over-limit"]);
    expect(runnerMathPhases("appraisal")).toEqual(["appraisal-math", "sensitivity-grid"]);
    expect(runnerMathPhases("ratios")).toEqual(["ratio-math", "bands-vs-thresholds"]);
    expect(runnerMathPhases("brief")).toEqual(["core-metrics"]);
  });
});

describe("runFinanceTask", () => {
  it("walks the task's own phases in order and says nothing about a repair that did not happen", async () => {
    reset();
    answers.push(narration("Cash was 900."));
    const { result, events } = await run();
    expect(phases(events)).toEqual(["runway-math", "narrate-guard-export"]);
    expect(steps(events)).toEqual(["1 figure(s) computed in code", "All figures trace to inputs"]);
    expect(asked).toHaveLength(1);
    expect(result.guard).toEqual({ flagged: [], total: 0, removed: 0 });
    expect(result.warnings).toBeUndefined();
  });

  it("repairs a blanked figure, emits a step only then, and ships no marker anywhere", async () => {
    reset();
    answers.push(narration("Cash was 900. Burn was 1234 a month."));
    answers.push(rewrite("Cash was 900."));
    const { result, events } = await run();
    expect(asked).toHaveLength(2);
    expect(String(asked[1]?.prompt)).toContain("Cash: 900");
    expect(steps(events)).toEqual([
      "1 figure(s) computed in code",
      "1 unverified figure(s) removed",
      "0 sentence(s) removed after one rewrite",
    ]);
    expect(JSON.stringify(result.report)).not.toContain(UNVERIFIED_MARKER);
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(result.report.notes[0]?.body).toBe("Cash was 900.");
  });

  it("removes the sentence, flags it for the reader and warns the desk when the rewrite invents again", async () => {
    reset();
    answers.push(narration("Cash held steady. Burn was 1234 a month."));
    answers.push(rewrite("Cash held steady. Burn was 4321 a month."));
    const { result, events } = await run({ locale: "id" });
    expect(JSON.stringify(result.report)).not.toContain(UNVERIFIED_MARKER);
    expect(result.markdown).not.toContain(UNVERIFIED_MARKER);
    expect(result.report.flags).toContainEqual({ level: "watch", text: REMOVED_SENTENCE_FLAG.id });
    expect(result.guard.removed).toBe(1);
    expect(steps(events)).toContain("1 sentence(s) removed after one rewrite");
    expect(result.warnings).toEqual([
      "2 figure(s) did not trace to the computed facts and were taken out",
      "1 sentence(s) were removed because their figure could not be traced",
    ]);
  });

  // The guard drops an assumption that rests on a figure nobody computed. That is a removed sentence
  // too, and the reader is told the same way the brief tells them — with or without a repair.
  it("flags an assumption the guard dropped as a removed sentence, even when nothing was repaired", async () => {
    reset();
    answers.push(
      JSON.stringify({
        title: "Runway to March",
        sections: [{ id: "position", heading: "Where cash sits", body: "Cash was 900." }],
        assumptions: ["Monthly figures.", "Headcount holds at 140 staff."],
      }),
    );
    const { result } = await run();
    expect(asked).toHaveLength(1);
    expect(result.guard).toEqual({ flagged: [{ section: -1, text: "140" }], total: 1, removed: 1 });
    expect(result.report.flags).toContainEqual({ level: "watch", text: REMOVED_SENTENCE_FLAG.en });
    expect(result.warnings).toEqual([
      "1 figure(s) did not trace to the computed facts and were taken out",
      "1 sentence(s) were removed because their figure could not be traced",
    ]);
    const artifact = artifactStore().get(tenant, String(result.artifactId));
    expect(artifact?.meta?.removed).toBe(1);
  });

  it("adds the dropped assumption to the sentences the repair took out, rather than replacing them", async () => {
    reset();
    answers.push(
      JSON.stringify({
        title: "Runway to March",
        sections: [{ id: "position", heading: "Where cash sits", body: "Cash held steady. Burn was 1234 a month." }],
        assumptions: ["Headcount holds at 140 staff."],
      }),
    );
    answers.push(rewrite("Cash held steady. Burn was 4321 a month."));
    const { result, events } = await run();
    expect(steps(events)).toContain("1 sentence(s) removed after one rewrite");
    expect(result.guard.removed).toBe(2);
    expect(result.warnings).toContain("2 sentence(s) were removed because their figure could not be traced");
    expect(JSON.stringify(result.report)).not.toContain(UNVERIFIED_MARKER);
  });

  it("hands the picker's pin to the job call only when the request names the model it pins", async () => {
    reset();
    answers.push(narration("Cash was 900."), narration("Cash was 900."));
    await run({ modelPinned: true });
    await run({ modelPinned: true, model: "gpt-5.6-sol" });
    expect(asked.map((options) => options.modelExplicit)).toEqual([false, true]);
  });

  it("hands the run's cancel to the narration and to the repair rewrite", async () => {
    reset();
    answers.push(narration("Cash was 900. Burn was 1234 a month."), rewrite("Cash was 900."));
    const controller = new AbortController();
    await runFinanceTask(taskModule, { tenant, body: body(), emit: () => {}, abortSignal: controller.signal });
    expect(asked).toHaveLength(2);
    expect(asked[0]?.signal).toBe(controller.signal);
    expect(asked[1]?.signal).toBe(controller.signal);
  });

  it("saves no report when the cancel lands during the repair", async () => {
    reset();
    answers.push(narration("Cash was 900. Burn was 1234 a month."), rewrite("Cash was 900."));
    const controller = new AbortController();
    const outcome = runFinanceTask(taskModule, {
      tenant,
      body: body(),
      emit: (event) => {
        if (event.type === "job.step" && event.label.includes("unverified")) {
          controller.abort(new Error("client left"));
        }
      },
      abortSignal: controller.signal,
    });
    await expect(outcome).rejects.toMatchObject({ code: "aborted", status: 499 });
    expect(ingested).toEqual([]);
  });

  it("saves the task, the model and the locale beside the report, so an export by id is full fidelity", async () => {
    reset();
    answers.push(narration("Cash was 900."));
    const { result } = await run();
    expect(result.artifactId).toBeTruthy();
    const artifact = artifactStore().get(tenant, String(result.artifactId));
    expect(artifact?.meta?.task).toBe("cashflow");
    expect(artifact?.meta?.model).toBe("stub-model");
    expect(artifact?.meta?.locale).toBe("en");
    expect(readStoredFinanceReport(artifact?.meta)).toEqual(result.report);
  });
});

// A run is the narrative plus at most ONE more model call, shared by every check that would have
// asked for its own: the second ask for a reading, the rewrite of a section the guard blanked, the
// rewrite of a section that contradicted a computed direction, and the rewrite of one that advised.
// The first to ask gets the call; each later one falls back to what code can do on its own.
describe("one shared extra call", () => {
  const SECTIONS = [
    { id: "position", title: { id: "Posisi", en: "Position" } },
    { id: "outlook", title: { id: "Prospek", en: "Outlook" } },
  ];

  const twoSections: FinanceTaskModule<Input, Input> = {
    ...taskModule,
    sections: SECTIONS,
    directionClaims: (computed) => [
      {
        amount: computed.cash,
        agree: [{ en: "a surplus", id: "surplus" }],
        contradict: [{ en: "a deficit", id: "defisit" }],
      },
    ],
  };

  function twoNarration(position: string, outlook: string): string {
    return JSON.stringify({
      title: "Runway to March",
      sections: [
        { id: "position", heading: "Where cash sits", body: position },
        { id: "outlook", heading: "What comes next", body: outlook },
      ],
      assumptions: ["Monthly figures."],
    });
  }

  async function runTwo(extra: Record<string, unknown> = {}) {
    const events: JobEvent[] = [];
    const result = await runFinanceTask(twoSections, {
      tenant,
      body: body(extra),
      emit: (event) => events.push(event),
    });
    return { result, events };
  }

  it("rewrites the first blanked section and takes the sentence out of the second without asking", async () => {
    reset();
    answers.push(twoNarration("Cash was 900. Burn was 1234 a month.", "Cash was 900. Rent was 777 a month."));
    answers.push(rewrite("Cash was 900."));
    const { result, events } = await runTwo();
    expect(asked).toHaveLength(2);
    expect(result.report.notes.map((note) => note.body)).toEqual(["Cash was 900.", "Cash was 900."]);
    expect(result.guard.removed).toBe(1);
    expect(JSON.stringify(result.report)).not.toContain(UNVERIFIED_MARKER);
    expect(steps(events)).toContain("The one extra model call was already used; the rest was handled in code");
  });

  it("spends the second ask for a reading that was not the sections, and removes the blanked sentence in code", async () => {
    reset();
    answers.push("this is not json");
    answers.push(twoNarration("Cash was 900. Burn was 1234 a month.", "Cash was 900."));
    const { result, events } = await runTwo();
    expect(asked).toHaveLength(2);
    expect(steps(events)).toContain("Asked once more for the reading");
    expect(result.report.notes[0]?.body).toBe("Cash was 900.");
    expect(result.guard.removed).toBe(1);
  });

  it("makes no third call when the narration failed twice: the error the desk shows today", async () => {
    reset();
    answers.push("not json", "still not json");
    await expect(runTwo()).rejects.toMatchObject({ code: "invalid_finance", status: 502 });
    expect(asked).toHaveLength(2);
  });

  it("takes a contradicting sentence out in code when the repair already used the extra call", async () => {
    reset();
    answers.push(twoNarration("Cash was 900 and is a deficit. Burn was 1234 a month.", "Cash was 900."));
    answers.push(rewrite("Cash was 900 and is a deficit."));
    const { result } = await runTwo();
    expect(asked).toHaveLength(2);
    expect(result.guard.directionRemoved).toBe(1);
    expect(result.report.notes[0]?.body).not.toContain("deficit");
  });

  it("rewrites an advising section once, and keeps the rewrite when it only describes the figures", async () => {
    reset();
    answers.push(twoNarration("Cash was 900. You should sell the asset now.", "Cash was 900."));
    answers.push(rewrite("Cash was 900. The asset is a third of the balance sheet."));
    const { result, events } = await runTwo();
    expect(asked).toHaveLength(2);
    expect(String(asked[1]?.runPrefix)).toBe("finance-scope");
    expect(result.report.notes[0]?.body).toBe("Cash was 900. The asset is a third of the balance sheet.");
    expect(result.report.flags.some((flag) => flag.text === ADVICE_SENTENCE_FLAG.en)).toBe(false);
    expect(steps(events)).toContain("Reading gave advice");
  });

  it("drops advice that survives its rewrite, tells the reader once, and tells the desk", async () => {
    reset();
    answers.push(twoNarration("Cash was 900. You should sell the asset now.", "Cash was 900."));
    answers.push(rewrite("Cash was 900. We recommend selling the asset."));
    const { result, events } = await runTwo({ locale: "id" });
    expect(result.report.notes[0]?.body).toBe("Cash was 900.");
    expect(result.report.flags).toContainEqual({ level: "watch", text: ADVICE_SENTENCE_FLAG.id });
    expect(steps(events)).toContain("1 sentence(s) removed because they gave advice");
    expect(result.warnings).toContain("1 sentence(s) were removed because they gave advice");
    expect(JSON.stringify(result.report)).not.toMatch(/should sell|recommend selling/);
  });

  it("drops advice in code when the extra call went to the figure repair, with no second rewrite", async () => {
    reset();
    answers.push(twoNarration("Cash was 900. Burn was 1234 a month. You should sell the asset.", "Cash was 900."));
    answers.push(rewrite("Cash was 900. You should sell the asset."));
    const { result } = await runTwo();
    expect(asked).toHaveLength(2);
    expect(result.report.notes[0]?.body).toBe("Cash was 900.");
    expect(result.report.flags.some((flag) => flag.text === ADVICE_SENTENCE_FLAG.en)).toBe(true);
  });

  it("does not take a sentence the person's own source text holds for advice", async () => {
    reset();
    answers.push(twoNarration("Cash was 900. You should review the outlay before March.", "Cash was 900."));
    const { result } = await runTwo({ sourceText: "Board note: you should review the outlay before March." });
    expect(asked).toHaveLength(1);
    expect(result.report.notes[0]?.body).toBe("Cash was 900. You should review the outlay before March.");
  });

  it("asks nothing beyond the narrative for a clean write-up", async () => {
    reset();
    answers.push(twoNarration("Cash was 900.", "Cash was 900."));
    const { events } = await runTwo();
    expect(asked).toHaveLength(1);
    expect(steps(events).some((label) => label.includes("extra model call"))).toBe(false);
  });
});
