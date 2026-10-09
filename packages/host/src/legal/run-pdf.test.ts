/**
 * The full review on PDF files and on corrected facts (docs/internal/doc-flow-plan.md section 2 and 7a.3):
 * a PDF draft gets no redline, only files of the same format are compared, and what the owner corrected in
 * the extraction reaches the review's preamble as given.
 */
import { describe, expect, it } from "vitest";
import { documentFromPlainText } from "@agentforge/core/docx";
import type { DocxDocument } from "@agentforge/core/docx";
import type { JobEvent } from "@agentforge/core/jobs";
import { legalOutputCopy, type MatterDocCard } from "@agentforge/core/legal";
import type { LegalMatterRecord } from "./records";
import { type LegalRunInput, runLegalMatter } from "./run";
import { DOCX_MIME, PDF_MIME } from "./store-files";

const PRIOR = ["LOAN AGREEMENT", "1. Fees", "The Borrower shall pay a fee of Rp 5.000.000."].join("\n\n");
const DRAFT = ["LOAN AGREEMENT", "1. Fees", "The Borrower shall pay a fee of Rp 9.000.000 on signing."].join("\n\n");

function card(id: string, role: MatterDocCard["role"], format: "pdf" | "docx"): MatterDocCard {
  return {
    id,
    name: `${id}.${format}`,
    path: `files/${id}.${format}`,
    mime: format === "pdf" ? PDF_MIME : DOCX_MIME,
    bytes: 100,
    sha256: `sha-${id}`,
    role,
    status: "read",
    paragraphs: 3,
    words: 20,
    insertions: 0,
    deletions: 0,
    definedTerms: 0,
    preview: "Loan agreement",
  };
}

function matterOf(docs: MatterDocCard[], deliverables: LegalMatterRecord["deliverables"]): LegalMatterRecord {
  return {
    id: "m1",
    workspaceId: "ws",
    title: "Aurora",
    createdAt: 0,
    updatedAt: 0,
    side: { role: "borrower", party: "Aurora Holdings", counterparty: "the Lenders" },
    workType: "review",
    deliverables,
    instructions: "",
    playbookId: null,
    author: "Samuel Roth",
    addressee: "Priya",
    firm: "",
    docs,
    priorMatterId: null,
    lastRunId: null,
  };
}

function inputOf(
  docs: MatterDocCard[],
  texts: Record<string, DocxDocument>,
  deliverables: LegalMatterRecord["deliverables"] = ["issues-memo", "redline"],
  extra: Partial<LegalRunInput> = {},
): LegalRunInput {
  return {
    matter: matterOf(docs, deliverables),
    docs: new Map(Object.entries(texts)),
    bytes: new Map(Object.keys(texts).map((id) => [id, new Uint8Array([1, 2, 3])])),
    playbook: null,
    models: { drafting: "draft-model", verifier: "verify-model" },
    maxRounds: 1,
    runId: "run-1",
    now: () => new Date("2026-10-05T12:00:00Z"),
    ...extra,
  };
}

function run(input: LegalRunInput) {
  const events: JobEvent[] = [];
  const systems: string[] = [];
  const result = runLegalMatter(input, {
    ask: async ({ system }) => {
      systems.push(system);
      return JSON.stringify({ kind: "ok" });
    },
    emit: (event) => void events.push(event),
    concurrency: 1,
  });
  return { result, events, systems };
}

const steps = (events: JobEvent[], phase: string): string[] =>
  events
    .filter(
      (event): event is Extract<JobEvent, { type: "job.step" }> => event.type === "job.step" && event.phase === phase,
    )
    .map((event) => event.label);

describe("a PDF draft", () => {
  it("gets no redline, says so, and leaves the memorandum and the other deliverables alone", async () => {
    const { result, events } = run(
      inputOf([card("S1", "counterparty-draft", "pdf")], { S1: documentFromPlainText(DRAFT) }),
    );
    const done = await result;
    expect(steps(events, "draft")).toContain(legalOutputCopy("en").redlineNeedsWord);
    const redline = done.deliverables.find((item) => item.kind === "redline");
    expect(redline?.bytes.byteLength).toBe(0);
    expect(done.deliverables.find((item) => item.kind === "issues-memo")?.bytes.byteLength).toBeGreaterThan(0);
    // No redline was made, so there is nothing for the redline check to fail on.
    expect(done.verify.codeChecks.find((check) => check.code === "docx-valid")?.failed).toBe(0);
  });

  it("says it in Indonesian on an Indonesian run", async () => {
    const { result, events } = run(
      inputOf([card("S1", "counterparty-draft", "pdf")], { S1: documentFromPlainText(DRAFT) }, ["redline"], {
        locale: "id",
      }),
    );
    await result;
    expect(steps(events, "draft")).toContain(legalOutputCopy("id").redlineNeedsWord);
  });
});

describe("comparing with the prior turn", () => {
  it("compares two PDFs, which have no tracked changes, so a changed paragraph is an unmarked change", async () => {
    const { result, events } = run(
      inputOf(
        [card("S1", "prior-turn", "pdf"), card("S2", "counterparty-draft", "pdf")],
        { S1: documentFromPlainText(PRIOR), S2: documentFromPlainText(DRAFT) },
        ["issues-memo"],
      ),
    );
    const done = await result;
    expect(done.findings.filter((finding) => finding.kind === "unmarked-change").length).toBeGreaterThan(0);
    expect(steps(events, "diff").some((label) => label.includes("unmarked"))).toBe(true);
  });

  it("does not compare a Word prior turn with a PDF draft", async () => {
    const { result, events } = run(
      inputOf(
        [card("S1", "prior-turn", "docx"), card("S2", "counterparty-draft", "pdf")],
        { S1: documentFromPlainText(PRIOR), S2: documentFromPlainText(DRAFT) },
        ["issues-memo"],
      ),
    );
    const done = await result;
    expect(steps(events, "diff")).toEqual([legalOutputCopy("en").diffNeedsSameFormat]);
    expect(done.findings.filter((finding) => finding.kind === "unmarked-change")).toEqual([]);
  });
});

describe("facts the owner corrected", () => {
  const note =
    "USER-CONFIRMED FACTS (the owner corrected these; treat them as given): Payment (S1): Rp 9.000.000 on signing.";

  it("reach every call's preamble, and are absent when nothing was corrected", async () => {
    const withNote = run(
      inputOf([card("S1", "counterparty-draft", "pdf")], { S1: documentFromPlainText(DRAFT) }, ["issues-memo"], {
        confirmedFactsNote: note,
      }),
    );
    await withNote.result;
    expect(withNote.systems.length).toBeGreaterThan(0);
    expect(withNote.systems.every((system) => system.includes(note))).toBe(true);

    const without = run(
      inputOf([card("S1", "counterparty-draft", "pdf")], { S1: documentFromPlainText(DRAFT) }, ["issues-memo"]),
    );
    await without.result;
    expect(without.systems.some((system) => system.includes("USER-CONFIRMED FACTS"))).toBe(false);
  });
});
