import { describe, expect, it } from "vitest";
import { documentFromPlainText } from "@agentforge/core/docx";
import type { JobEvent } from "@agentforge/core/jobs";
import { type LegalExtractModelResponse, type MatterDocCard, legalOutputCopy } from "@agentforge/core/legal";
import { type LegalExtractInput, runLegalExtract } from "./extract-engine";
import type { LegalMatterRecord } from "./records";

const S1_TEXT = [
  "LOAN AGREEMENT",
  "This Agreement is dated 14 August 2026 between PT Aurora Holdings (the Borrower) and Bank Sinar (the Lender).",
  "2.1 The Borrower shall repay Rp 1.500.000.000 within twelve (12) months of the first drawdown.",
  "5.3 The Borrower shall indemnify the Lender without limit for all losses.",
  "This Agreement is governed by the laws of Indonesia.",
].join("\n\n");

const S2_TEXT = [
  "LOAN AGREEMENT (counter-proposal)",
  "This Agreement is dated 1 September 2026 between PT Aurora Holdings (the Borrower) and Bank Sinar (the Lender).",
  "2.1 The Borrower shall repay Rp 1.500.000.000 within twenty-four (24) months of the first drawdown.",
].join("\n\n");

function card(id: string, name: string, role: MatterDocCard["role"] = "context"): MatterDocCard {
  return {
    id,
    name,
    path: `files/${id}.docx`,
    mime: "application/octet-stream",
    bytes: 100,
    sha256: `sha-${id}`,
    role,
    status: "read",
    paragraphs: 3,
    words: 30,
    insertions: 0,
    deletions: 0,
    definedTerms: 0,
    preview: "",
  };
}

function matterOf(docs: MatterDocCard[], side = { role: "", party: "", counterparty: "" }): LegalMatterRecord {
  return {
    id: "m1",
    workspaceId: "ws",
    title: "Aurora",
    createdAt: 1,
    updatedAt: 1,
    side,
    workType: "review",
    deliverables: ["issues-memo"],
    instructions: "",
    playbookId: null,
    author: "",
    addressee: "",
    firm: "",
    docs,
    priorMatterId: null,
    lastRunId: null,
  };
}

const fact = (field: string, value: string, quote: string, docId: string, status = "found") =>
  ({ field, label: "", value, status, quote, docId, anchor: "" }) as LegalExtractModelResponse["facts"][number];
const missing = (field: string) => fact(field, "", "", "", "missing");

/** A correct answer about S1 alone. */
function s1Answer(overrides: Partial<LegalExtractModelResponse> = {}): LegalExtractModelResponse {
  return {
    documentType: "Loan agreement",
    parties: [
      { name: "PT Aurora Holdings", role: "Borrower", quote: "PT Aurora Holdings (the Borrower)", docId: "S1" },
      { name: "Bank Sinar", role: "Lender", quote: "Bank Sinar (the Lender)", docId: "S1" },
    ],
    files: [{ docId: "S1", role: "draft", reason: "a draft" }],
    side: null,
    facts: [
      fact(
        "parties",
        "PT Aurora Holdings and Bank Sinar",
        "between PT Aurora Holdings (the Borrower) and Bank Sinar",
        "S1",
      ),
      fact("effective-date", "14 August 2026", "This Agreement is dated 14 August 2026", "S1"),
      fact("term", "twelve (12) months", "within twelve (12) months of the first drawdown", "S1"),
      fact("payment", "Rp 1.500.000.000", "The Borrower shall repay Rp 1.500.000.000 within twelve (12) months", "S1"),
      fact(
        "liability",
        "indemnity without limit",
        "The Borrower shall indemnify the Lender without limit for all losses.",
        "S1",
      ),
      missing("termination"),
      fact("governing-law", "Indonesia", "This Agreement is governed by the laws of Indonesia.", "S1"),
    ],
    redFlags: [
      {
        title: "Unlimited indemnity",
        why: "The Borrower indemnifies the Lender for all losses with no cap.",
        severity: "high",
        against: "PT Aurora Holdings",
        quote: "The Borrower shall indemnify the Lender without limit for all losses.",
        docId: "S1",
        anchor: "",
      },
    ],
    ...overrides,
  };
}

type Responder = (info: { prompt: string; docIds: string[]; calls: number }) => string | Error;

function harness(responder: Responder) {
  const asked: { prompt: string; system: string }[] = [];
  const events: JobEvent[] = [];
  const ask = async ({ prompt, system }: { model: string; system: string; prompt: string }) => {
    asked.push({ prompt, system });
    const docIds = [...prompt.matchAll(/^=== (S\d+) —/gm)].map((match) => match[1] as string);
    const out = responder({ prompt, docIds, calls: asked.length });
    if (out instanceof Error) {
      throw out;
    }
    return out;
  };
  return { asked, events, deps: { ask, emit: (event: JobEvent) => void events.push(event) } };
}

function inputOf(
  matter: LegalMatterRecord,
  docs: Record<string, string>,
  extra: Partial<LegalExtractInput> = {},
): LegalExtractInput {
  return {
    matter,
    docs: new Map(Object.entries(docs).map(([id, text]) => [id, documentFromPlainText(text)])),
    pages: new Map(),
    model: "test-model",
    locale: "en",
    prompt: "",
    deskParty: null,
    previous: null,
    now: () => 1_000,
    ...extra,
  };
}

describe("runLegalExtract: one call", () => {
  it("reads, extracts, checks and returns a record whose every item is verified or not in the documents", async () => {
    const { deps, asked, events } = harness(() => JSON.stringify(s1Answer()));
    const { record, roles, side } = await runLegalExtract(
      inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }),
      deps,
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("[S1 ¶1] This Agreement is dated 14 August 2026");
    expect(record).toMatchObject({
      version: 1,
      matterId: "m1",
      model: "test-model",
      documentType: "Loan agreement",
      createdAt: 1_000,
      prompt: "",
      read: {
        calls: 1,
        repairs: 0,
        partialDocs: [],
        files: [{ docId: "S1", status: "read", chunks: { read: 1, total: 1 } }],
      },
      checks: { passed: true, rounds: 0 },
    });
    expect(record.checks.verdicts.map((verdict) => verdict.check)).toEqual([
      "legal-shape",
      "legal-quotes",
      "legal-values",
      "legal-coverage",
      "legal-scope",
    ]);
    const payment = record.facts.find((item) => item.id === "payment:S1");
    expect(payment).toMatchObject({
      field: "payment",
      label: "Payment",
      value: "Rp 1.500.000.000",
      status: "verified",
      docId: "S1",
      anchor: "¶2",
      clauseId: "§2.1",
      page: null,
    });
    expect(record.facts.find((item) => item.id === "termination:-")).toMatchObject({
      status: "not-in-documents",
      value: "",
      quote: "",
    });
    expect(record.redFlags[0]).toMatchObject({
      status: "verified",
      severity: "high",
      docId: "S1",
      anchor: "¶3",
      clauseId: "§5.3",
    });
    expect(record.coverage.find((entry) => entry.field === "termination")?.state).toBe("not-stated");
    expect(record.coverage.find((entry) => entry.field === "payment")?.state).toBe("stated");
    expect(record.conflicts).toEqual([]);
    // One draft: it is the counterparty draft, set in code.
    expect(roles).toEqual([{ id: "S1", role: "counterparty-draft" }]);
    expect(record.files).toEqual([
      { docId: "S1", intakeRole: "draft", reason: "a draft", appliedRole: "counterparty-draft" },
    ]);
    expect(record.side).toMatchObject({ ask: true, source: "ask" });
    expect(side).toBeNull();

    expect(
      events.filter((event) => event.type === "job.phase").map((event) => (event as { phase: string }).phase),
    ).toEqual(["reading", "extracting", "checking"]);
    expect(events.some((event) => event.type === "job.source" && event.id === "S1")).toBe(true);
  });

  it("says what the owner asked for in the prompt and keeps it in the record, without relaxing a check", async () => {
    const { deps, asked } = harness(() => JSON.stringify(s1Answer()));
    const { record } = await runLegalExtract(
      inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }, { prompt: "  what should I watch out for  " }),
      deps,
    );
    expect(asked[0]?.prompt).toContain("OWNER'S FOCUS");
    expect(asked[0]?.prompt).toContain("what should I watch out for");
    expect(record.prompt).toBe("what should I watch out for");
    expect(record.checks.verdicts).toHaveLength(5);
  });

  it("asks for the user-facing words in the run language", async () => {
    const { deps, asked } = harness(() => JSON.stringify(s1Answer()));
    const { record } = await runLegalExtract(
      inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }, { locale: "id" }),
      deps,
    );
    expect(asked[0]?.system).toMatch(/Bahasa Indonesia/);
    expect(record.locale).toBe("id");
    expect(record.facts.find((item) => item.field === "payment")?.label).toBe("Pembayaran");
  });

  it("refuses a matter with no files before any model call", async () => {
    const { deps, asked } = harness(() => "{}");
    await expect(runLegalExtract(inputOf(matterOf([]), {}), deps)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
      message: legalOutputCopy("en").noFiles,
    });
    expect(asked).toHaveLength(0);
  });
});

describe("runLegalExtract: the one repair", () => {
  const fabricated = () =>
    s1Answer({
      redFlags: [
        {
          title: "Seizure at will",
          why: "The Lender may seize assets.",
          severity: "high",
          against: "PT Aurora Holdings",
          quote: "The Lender may seize every asset of the Borrower at will.",
          docId: "S1",
          anchor: "",
        },
      ],
    });

  it("re-asks only for a failing answer, with a note naming what failed, and keeps the corrected answer", async () => {
    const { deps, asked, events } = harness(({ calls }) => JSON.stringify(calls === 1 ? fabricated() : s1Answer()));
    const { record } = await runLegalExtract(inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }), deps);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.prompt).toContain("PREVIOUS ANSWER:");
    expect(asked[1]?.prompt).toContain("ERROR: These quotes are not in the files:");
    expect(asked[1]?.prompt).toContain("The Lender may seize every asset");
    expect(record.read.repairs).toBe(1);
    expect(record.checks).toMatchObject({ passed: true, rounds: 1 });
    expect(record.redFlags[0]).toMatchObject({ title: "Unlimited indemnity", status: "verified" });
    expect(events.filter((event) => event.type === "job.round")).toHaveLength(2);
  });

  it("marks an item unverified, keeps it, and does not ask a third time when the repair fails too", async () => {
    const { deps, asked } = harness(() => JSON.stringify(fabricated()));
    const { record } = await runLegalExtract(inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }), deps);
    expect(asked).toHaveLength(2);
    expect(record.checks.passed).toBe(false);
    expect(record.redFlags).toHaveLength(1);
    expect(record.redFlags[0]).toMatchObject({
      title: "Seizure at will",
      status: "unverified",
      anchor: "",
      docId: "S1",
    });
    // The facts that were right stay verified.
    expect(record.facts.find((item) => item.id === "payment:S1")?.status).toBe("verified");
  });

  it("asks an unreadable answer once more at once, and again with a note if it is still unreadable", async () => {
    const { deps, asked } = harness(({ calls }) => (calls <= 2 ? "I could not do that." : JSON.stringify(s1Answer())));
    const { record } = await runLegalExtract(inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }), deps);
    expect(asked).toHaveLength(3);
    expect(asked[2]?.prompt).toContain("not valid JSON");
    expect(record.read.files[0]?.status).toBe("read");
    expect(record.checks.passed).toBe(true);
  });

  it("never asks a part more than three times, however badly the model answers: two first tries and one repair", async () => {
    const { deps, asked } = harness(() => "no json at all");
    await expect(
      runLegalExtract(inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }), deps),
    ).rejects.toMatchObject({
      code: "model_unreadable",
      status: 502,
      message: legalOutputCopy("en").modelUnreadable,
    });
    expect(asked).toHaveLength(3);
  });
});

describe("runLegalExtract: several files", () => {
  const TWO = { S1: S1_TEXT, S2: S2_TEXT };
  const cards = () => [card("S1", "draft.docx"), card("S2", "counter.docx")];

  function twoFileAnswer(): LegalExtractModelResponse {
    const s1 = s1Answer();
    return {
      ...s1,
      files: [
        { docId: "S1", role: "draft", reason: "" },
        { docId: "S2", role: "counter-draft", reason: "" },
      ],
      facts: [
        ...s1.facts.filter((item) => item.field !== "effective-date" && item.field !== "term"),
        fact("effective-date", "14 August 2026", "This Agreement is dated 14 August 2026", "S1"),
        fact("effective-date", "1 September 2026", "This Agreement is dated 1 September 2026", "S2"),
        fact("term", "twelve (12) months", "within twelve (12) months of the first drawdown", "S1"),
        fact("term", "twenty-four (24) months", "within twenty-four (24) months of the first drawdown", "S2"),
      ],
    };
  }

  it("reports a conflict between files and gives the counter-draft the counterparty-draft role and the draft the prior turn", async () => {
    const { deps, asked } = harness(() => JSON.stringify(twoFileAnswer()));
    const { record, roles } = await runLegalExtract(inputOf(matterOf(cards()), TWO), deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("=== S1 — draft.docx");
    expect(asked[0]?.prompt).toContain("=== S2 — counter.docx");
    expect(record.conflicts.map((conflict) => [conflict.field, conflict.kind])).toEqual([
      ["effective-date", "date"],
      ["term", "duration"],
    ]);
    expect(record.conflicts[0]?.values.map((entry) => entry.docIds)).toEqual([["S1"], ["S2"]]);
    expect(record.conflicts[0]?.values[0]?.itemIds).toEqual(["effective-date:S1"]);
    expect(roles).toEqual([
      { id: "S1", role: "prior-turn" },
      { id: "S2", role: "counterparty-draft" },
    ]);
  });

  it("never overrides a role the owner set, but updates one an earlier extraction set", async () => {
    const { deps } = harness(() => JSON.stringify(twoFileAnswer()));
    const owner = await runLegalExtract(
      inputOf(matterOf([card("S1", "draft.docx", "executed"), card("S2", "counter.docx")]), TWO),
      deps,
    );
    expect(owner.roles).toEqual([{ id: "S2", role: "counterparty-draft" }]);
    expect(owner.record.files.find((file) => file.docId === "S1")?.appliedRole).toBeNull();

    const earlier = await runLegalExtract(
      inputOf(matterOf([card("S1", "draft.docx", "counterparty-draft"), card("S2", "counter.docx")]), TWO, {
        previous: owner.record,
      }),
      deps,
    );
    // S1 was given counterparty-draft by hand (the earlier record did not apply a role to it), so it stays.
    expect(earlier.roles.some((entry) => entry.id === "S1")).toBe(false);

    const sameAsBefore = await runLegalExtract(
      inputOf(matterOf([card("S1", "draft.docx", "counterparty-draft"), card("S2", "counter.docx")]), TWO, {
        previous: {
          ...owner.record,
          files: [
            { docId: "S1", intakeRole: "draft", reason: "", appliedRole: "counterparty-draft" },
            { docId: "S2", intakeRole: "counter-draft", reason: "", appliedRole: null },
          ],
        },
      }),
      deps,
    );
    expect(sameAsBefore.roles).toContainEqual({ id: "S1", role: "prior-turn" });
  });

  it("asks the side question with the detected parties, and resolves it without asking when the matter or the model is sure", async () => {
    const { deps } = harness(() => JSON.stringify(twoFileAnswer()));
    const asked = await runLegalExtract(inputOf(matterOf(cards()), TWO), deps);
    expect(asked.record.side).toEqual({
      party: null,
      ask: true,
      source: "ask",
      candidates: [
        { party: "PT Aurora Holdings", role: "borrower", counterparty: "Bank Sinar" },
        { party: "Bank Sinar", role: "lender", counterparty: "PT Aurora Holdings" },
      ],
    });

    const sure = harness(() =>
      JSON.stringify({
        ...twoFileAnswer(),
        side: { party: "PT Aurora Holdings", confidence: "high", quote: "PT Aurora Holdings (the Borrower)" },
      }),
    );
    const modelPick = await runLegalExtract(inputOf(matterOf(cards()), TWO), sure.deps);
    expect(modelPick.record.side).toMatchObject({ party: "PT Aurora Holdings", ask: false, source: "model" });
    expect(modelPick.side).toEqual({ role: "borrower", party: "PT Aurora Holdings", counterparty: "Bank Sinar" });
    // Who the red flag hurts follows the resolved side.
    expect(modelPick.record.redFlags[0]?.against).toBe("you");

    const onMatter = await runLegalExtract(
      inputOf(matterOf(cards(), { role: "lender", party: "Bank Sinar", counterparty: "PT Aurora Holdings" }), TWO),
      deps,
    );
    expect(onMatter.record.side).toMatchObject({ party: "Bank Sinar", source: "matter" });
    expect(onMatter.side).toBeNull();
    expect(onMatter.record.redFlags[0]?.against).toBe("them");

    const desk = await runLegalExtract(inputOf(matterOf(cards()), TWO, { deskParty: "bank sinar" }), deps);
    expect(desk.record.side).toMatchObject({ party: "Bank Sinar", source: "desk", ask: false });
  });

  it("does not ask again after the owner said neither", async () => {
    const { deps } = harness(() => JSON.stringify(twoFileAnswer()));
    const declined = await runLegalExtract(inputOf({ ...matterOf(cards()), sideDeclined: true }, TWO), deps);
    expect(declined.record.side).toEqual({ party: null, ask: false, candidates: [], source: "declined" });
  });
});

describe("runLegalExtract: a matter too long for one call", () => {
  const BIG = Array.from(
    { length: 30 },
    (_, index) => `Paragraph ${index}: the parties agree to item number ${index} of this long agreement.`,
  ).join("\n\n");
  const docs = { S1: BIG, S2: S2_TEXT };
  const cards = () => [card("S1", "long.docx"), card("S2", "counter.docx")];

  /** Answers for whichever files its call holds: found for what it can, missing for the rest. */
  function perCall({ docIds }: { docIds: string[] }): string {
    const facts = [
      ...["parties", "effective-date", "term", "payment", "liability", "termination", "governing-law"].map((field) =>
        field === "effective-date" && docIds.includes("S2")
          ? fact(field, "1 September 2026", "This Agreement is dated 1 September 2026", "S2")
          : missing(field),
      ),
    ];
    return JSON.stringify({
      documentType: "",
      parties: [],
      files: docIds.map((docId) => ({ docId, role: docId === "S2" ? "counter-draft" : "draft", reason: "" })),
      side: null,
      facts,
      redFlags: [],
    });
  }

  it("reads every file in full across several calls, merges them in code, and records what was read", async () => {
    const { deps, asked } = harness(perCall);
    const { record } = await runLegalExtract(inputOf(matterOf(cards()), docs, { budgetChars: 700 }), deps);
    expect(asked.length).toBeGreaterThan(2);
    // Every paragraph of the long file went to the model exactly once.
    for (let index = 0; index < 30; index += 1) {
      expect(
        asked.filter((entry) => entry.prompt.includes(`[S1 ¶${index}] Paragraph ${index}:`)).length,
        `paragraph ${index}`,
      ).toBe(1);
    }
    expect(record.read.calls).toBe(asked.length);
    expect(record.read.files.map((file) => [file.docId, file.status])).toEqual([
      ["S1", "read"],
      ["S2", "read"],
    ]);
    expect(record.read.files[0]?.chunks.total ?? 0).toBeGreaterThan(1);
    expect(record.read.files[0]?.chunks.read).toBe(record.read.files[0]?.chunks.total);
    expect(record.read.partialDocs).toEqual([]);
    // The date S2 states came through the merge, and the missing ones were reported once.
    expect(record.facts.find((item) => item.id === "effective-date:S2")?.status).toBe("verified");
    expect(record.facts.filter((item) => item.field === "payment")).toHaveLength(1);
    expect(record.facts.find((item) => item.field === "payment")?.status).toBe("not-in-documents");
    expect(asked.some((entry) => /part \d+ of \d+ of the matter's text/i.test(entry.prompt))).toBe(true);
  });

  it("refuses up front, before any model call, a matter that would need more calls than the cap", async () => {
    const { deps, asked } = harness(perCall);
    await expect(runLegalExtract(inputOf(matterOf(cards()), docs, { budgetChars: 40 }), deps)).rejects.toMatchObject({
      code: "matter_too_large",
      status: 413,
    });
    expect(asked).toHaveLength(0);
  });

  it("marks the files of a call that never gave a readable answer as not read, instead of dropping them silently", async () => {
    const { deps } = harness((info) => (info.docIds.includes("S2") ? "garbage" : perCall(info)));
    const { record } = await runLegalExtract(inputOf(matterOf(cards()), docs, { budgetChars: 700 }), deps);
    expect(record.read.files.find((file) => file.docId === "S2")).toMatchObject({
      status: "unread",
      chunks: { read: 0, total: 1 },
    });
    expect(record.read.partialDocs).toEqual(["S2"]);
    expect(record.checks.passed).toBe(false);
    expect(record.files.find((file) => file.docId === "S2")).toMatchObject({ intakeRole: null, appliedRole: null });
  });

  it("fails the run, saving nothing, when no call could be made at all", async () => {
    const boom = new Error("gateway unreachable");
    const { deps } = harness(() => boom);
    await expect(runLegalExtract(inputOf(matterOf(cards()), docs, { budgetChars: 700 }), deps)).rejects.toBe(boom);
  });
});

describe("runLegalExtract: cancel", () => {
  it("stops before the next call when the client cancelled", async () => {
    const controller = new AbortController();
    const { deps, asked } = harness(() => {
      controller.abort();
      return JSON.stringify(s1Answer());
    });
    await expect(
      runLegalExtract(inputOf(matterOf([card("S1", "loan.docx")]), { S1: S1_TEXT }), {
        ...deps,
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "aborted", status: 499 });
    expect(asked).toHaveLength(1);
  });
});
