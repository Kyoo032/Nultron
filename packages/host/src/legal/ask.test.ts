import { describe, expect, it } from "vitest";
import { documentFromPlainText } from "@agentforge/core/docx";
import type { JobEvent } from "@agentforge/core/jobs";
import { type MatterDocCard, legalOutputCopy } from "@agentforge/core/legal";
import { type LegalAskInput, runLegalAsk } from "./ask";
import type { LegalMatterRecord } from "./records";

const S1 = [
  "LOAN AGREEMENT",
  "This Agreement is dated 14 August 2026 between PT Aurora Holdings (the Borrower) and Bank Sinar (the Lender).",
  "2.1 The Borrower shall repay Rp 1.500.000.000 within twelve (12) months of the first drawdown.",
  "5.3 The Borrower shall indemnify the Lender without limit for all losses.",
].join("\n\n");

const S2 = ["SIDE LETTER", "The Lender waives the arrangement fee of Rp 15.000.000 for the first drawdown."].join(
  "\n\n",
);

function card(id: string, name: string): MatterDocCard {
  return {
    id,
    name,
    path: `files/${id}.docx`,
    mime: "application/octet-stream",
    bytes: 1,
    sha256: `sha-${id}`,
    role: "context",
    status: "read",
    paragraphs: 1,
    words: 1,
    insertions: 0,
    deletions: 0,
    definedTerms: 0,
    preview: "",
  };
}

function matterOf(docs: MatterDocCard[]): LegalMatterRecord {
  return {
    id: "m1",
    workspaceId: "ws",
    title: "Aurora",
    createdAt: 1,
    updatedAt: 1,
    side: { role: "", party: "", counterparty: "" },
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

function inputOf(docs: Record<string, string>, extra: Partial<LegalAskInput> = {}): LegalAskInput {
  return {
    matter: matterOf(Object.keys(docs).map((id) => card(id, `${id}.docx`))),
    docs: new Map(Object.entries(docs).map(([id, text]) => [id, documentFromPlainText(text)])),
    pages: new Map(),
    question: "When must the loan be repaid?",
    model: "test-model",
    locale: "en",
    now: () => 5_000,
    ...extra,
  };
}

type Reply = Record<string, unknown> | string | Error;

function harness(replies: (call: number, prompt: string) => Reply) {
  const asked: { prompt: string; system: string }[] = [];
  const events: JobEvent[] = [];
  const ask = async ({ prompt, system }: { model: string; system: string; prompt: string }) => {
    asked.push({ prompt, system });
    const reply = replies(asked.length, prompt);
    if (reply instanceof Error) {
      throw reply;
    }
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return { asked, events, deps: { ask, emit: (event: JobEvent) => void events.push(event) } };
}

const GOOD = {
  answer: "The Borrower must repay within twelve (12) months of the first drawdown.",
  citations: [
    {
      docId: "S1",
      quote: "The Borrower shall repay Rp 1.500.000.000 within twelve (12) months of the first drawdown.",
    },
  ],
  notInDocuments: false,
};

describe("runLegalAsk: one call", () => {
  it("answers from the files, with each citation found in the file and placed in it", async () => {
    const { deps, asked, events } = harness(() => GOOD);
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toContain("When must the loan be repaid?");
    expect(asked[0]?.prompt).toContain("[S1 ¶2] 2.1 The Borrower shall repay");
    expect(record).toMatchObject({
      question: "When must the loan be repaid?",
      answer: GOOD.answer,
      status: "verified",
      notInDocuments: false,
      askedAt: 5_000,
      model: "test-model",
      read: { calls: 1, repairs: 0, partialDocs: [] },
      checks: { passed: true, rounds: 0 },
    });
    expect(record.citations).toEqual([
      { docId: "S1", quote: GOOD.citations[0]?.quote, anchor: "¶2", clauseId: "§2.1", page: null },
    ]);
    expect(record.checks.verdicts.map((verdict) => verdict.check)).toEqual([
      "legal-answer-cited",
      "legal-quotes",
      "legal-values",
      "legal-scope",
    ]);
    expect(
      events.filter((event) => event.type === "job.phase").map((event) => (event as { phase: string }).phase),
    ).toEqual(["reading", "answering", "checking"]);
  });

  it("says the documents do not answer, and keeps nothing the model wrote beside that", async () => {
    const { deps } = harness(() => ({
      answer: "Probably five years.",
      citations: [{ docId: "S1", quote: "made up words here" }],
      notInDocuments: true,
    }));
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(record).toMatchObject({
      answer: legalOutputCopy("en").notInDocuments,
      status: "not-in-documents",
      notInDocuments: true,
      citations: [],
    });
    expect(record.checks.passed).toBe(true);
  });

  it("answers in Indonesian copy when the run language is Indonesian", async () => {
    const { deps, asked } = harness(() => ({ answer: "", citations: [], notInDocuments: true }));
    const record = await runLegalAsk(inputOf({ S1 }, { locale: "id" }), deps);
    expect(asked[0]?.system).toMatch(/Bahasa Indonesia/);
    expect(record.answer).toBe("Dokumen tidak menyebutkannya.");
  });
});

describe("runLegalAsk: the checks and the one repair", () => {
  it("re-asks once when a citation is not in the files, and keeps the corrected answer", async () => {
    const { deps, asked } = harness((call) =>
      call === 1
        ? { ...GOOD, citations: [{ docId: "S1", quote: "The Borrower must repay everything on demand at any time" }] }
        : GOOD,
    );
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.prompt).toContain("PREVIOUS ANSWER:");
    expect(asked[1]?.prompt).toContain("ERROR: These citations are not in the files:");
    expect(record).toMatchObject({ status: "verified", read: { repairs: 1 }, checks: { passed: true, rounds: 1 } });
  });

  it("answers 'not in the documents' when no citation can be verified even after the repair", async () => {
    const { deps, asked, events } = harness(() => ({
      ...GOOD,
      citations: [{ docId: "S1", quote: "The Borrower must repay everything on demand" }],
    }));
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(asked).toHaveLength(2);
    expect(record).toMatchObject({
      status: "not-in-documents",
      notInDocuments: true,
      citations: [],
      answer: legalOutputCopy("en").notInDocuments,
    });
    expect(record.checks.passed).toBe(false);
    expect(
      events.some((event) => event.type === "job.step" && event.label === legalOutputCopy("en").answerDropped),
    ).toBe(true);
  });

  it("asks for a citation when an answer has none, and for the right figure when the answer states one the passage does not", async () => {
    const uncited = harness((call) => (call === 1 ? { ...GOOD, citations: [] } : GOOD));
    expect((await runLegalAsk(inputOf({ S1 }), uncited.deps)).status).toBe("verified");
    expect(uncited.asked[1]?.prompt).toContain("The answer is not backed by a citation");

    const wrongFigure = harness((call) =>
      call === 1 ? { ...GOOD, answer: "The Borrower must repay Rp 2.500.000.000 within twelve (12) months." } : GOOD,
    );
    const record = await runLegalAsk(inputOf({ S1 }), wrongFigure.deps);
    expect(wrongFigure.asked[1]?.prompt).toContain("The answer states figures or dates the cited passages do not");
    expect(wrongFigure.asked[1]?.prompt).toContain("Rp 2.500.000.000");
    expect(record.status).toBe("verified");
  });

  it("keeps an answer that still states a wrong figure after the repair, marked unverified, with its verified citation", async () => {
    const { deps, asked } = harness(() => ({
      ...GOOD,
      answer: "The Borrower must repay Rp 2.500.000.000 within twelve (12) months.",
    }));
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(asked).toHaveLength(2);
    expect(record.status).toBe("unverified");
    expect(record.notInDocuments).toBe(false);
    expect(record.citations).toHaveLength(1);
    expect(record.checks.passed).toBe(false);
  });

  it("repairs advice and a statute no file cites", async () => {
    const advice = harness((call) =>
      call === 1 ? { ...GOOD, answer: "You should refuse the clause; see UU No. 11 Tahun 2020." } : GOOD,
    );
    const record = await runLegalAsk(inputOf({ S1 }), advice.deps);
    expect(advice.asked[1]?.prompt).toContain("The answer gives advice or relies on law the files do not cite");
    expect(record.status).toBe("verified");
  });

  it("asks an unreadable answer once more at once", async () => {
    const { deps, asked } = harness((call) => (call === 1 ? "no json here" : GOOD));
    const record = await runLegalAsk(inputOf({ S1 }), deps);
    expect(asked).toHaveLength(2);
    expect(record.status).toBe("verified");
  });

  it("never asks a part more than three times, however badly the model answers", async () => {
    const { deps, asked } = harness(() => "no json at all");
    await expect(runLegalAsk(inputOf({ S1 }), deps)).rejects.toMatchObject({
      code: "model_unreadable",
      message: legalOutputCopy("en").modelUnreadable,
    });
    expect(asked).toHaveLength(3);
  });
});

describe("runLegalAsk: edge cases", () => {
  it("refuses a matter with no files before any call", async () => {
    const { deps, asked } = harness(() => GOOD);
    await expect(runLegalAsk({ ...inputOf({ S1 }), matter: matterOf([]) }, deps)).rejects.toMatchObject({
      code: "invalid_request",
      message: legalOutputCopy("en").noFiles,
    });
    expect(asked).toHaveLength(0);
  });

  it("fails, saving nothing, when every call fails", async () => {
    const boom = new Error("gateway unreachable");
    const { deps } = harness(() => boom);
    await expect(runLegalAsk(inputOf({ S1 }), deps)).rejects.toBe(boom);
  });

  it("stops when the client cancels", async () => {
    const controller = new AbortController();
    const { deps, asked } = harness(() => {
      controller.abort();
      return GOOD;
    });
    await expect(runLegalAsk(inputOf({ S1 }), { ...deps, abortSignal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(asked).toHaveLength(1);
  });
});

describe("runLegalAsk: a matter too long for one call", () => {
  const BIG = Array.from(
    { length: 24 },
    (_, index) => `Paragraph ${index}: filler about item ${index} of this long agreement.`,
  ).join("\n\n");

  it("sends every file to the model in full, across calls, and joins the answers of the parts that answered", async () => {
    const { deps, asked } = harness((_call, prompt) =>
      prompt.includes("[S2 ¶1]")
        ? {
            answer: "The Lender waived the arrangement fee of Rp 15.000.000.",
            citations: [{ docId: "S2", quote: "The Lender waives the arrangement fee of Rp 15.000.000" }],
            notInDocuments: false,
          }
        : { answer: "", citations: [], notInDocuments: true },
    );
    const record = await runLegalAsk(
      inputOf({ S1: BIG, S2 }, { question: "Was any fee waived?", budgetChars: 600 }),
      deps,
    );
    expect(asked.length).toBeGreaterThan(2);
    for (let index = 0; index < 24; index += 1) {
      expect(
        asked.filter((entry) => entry.prompt.includes(`[S1 ¶${index}] Paragraph ${index}:`)).length,
        `paragraph ${index}`,
      ).toBe(1);
    }
    expect(record).toMatchObject({ status: "verified", notInDocuments: false });
    expect(record.answer).toBe("The Lender waived the arrangement fee of Rp 15.000.000.");
    expect(record.citations.map((citation) => citation.docId)).toEqual(["S2"]);
    expect(record.read.calls).toBe(asked.length);
    expect(record.read.files.every((file) => file.status === "read")).toBe(true);
  });

  it("does not call it 'not in the documents' as if sure when a part could not be read", async () => {
    const { deps } = harness((_call, prompt) =>
      prompt.includes("[S2 ¶1]") ? "garbage" : { answer: "", citations: [], notInDocuments: true },
    );
    const record = await runLegalAsk(
      inputOf({ S1: BIG, S2 }, { question: "Was any fee waived?", budgetChars: 600 }),
      deps,
    );
    expect(record).toMatchObject({ notInDocuments: true, status: "unverified" });
    // S2 shares its call with the tail of S1, so S1 is only partly read too.
    expect(record.read.partialDocs).toContain("S2");
    expect(record.read.files.find((file) => file.docId === "S2")?.status).toBe("unread");
  });

  it("refuses up front a matter that would need more calls than the cap", async () => {
    const { deps, asked } = harness(() => GOOD);
    await expect(runLegalAsk(inputOf({ S1: BIG }, { budgetChars: 40 }), deps)).rejects.toMatchObject({
      code: "matter_too_large",
      status: 413,
    });
    expect(asked).toHaveLength(0);
  });
});
