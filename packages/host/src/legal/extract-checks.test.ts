import { describe, expect, it } from "vitest";
import { documentFromPlainText } from "@agentforge/core/docx";
import { LEGAL_FACT_FIELDS, type LegalExtractModelResponse } from "@agentforge/core/legal";
import { outcomesById } from "@agentforge/core/judges";
import { buildEvidence } from "./evidence";
import type { CallOutput } from "./extract-merge";
import { buildExtractChecks } from "./extract-checks";

const S1 = [
  "LOAN AGREEMENT",
  "This Agreement is dated 14 August 2026 between PT Aurora Holdings (the Borrower) and Bank Sinar (the Lender).",
  "2.1 The Borrower shall repay Rp 1.500.000.000 within twelve (12) months of the first drawdown.",
  "5.3 The Borrower shall indemnify the Lender without limit for all losses.",
  "This Agreement is governed by the laws of Indonesia.",
].join("\n\n");

const S2 = ["SIDE LETTER", "Signed this 14th day of August, 2026 by the parties named in the Loan Agreement."].join(
  "\n\n",
);

const evidence = buildEvidence([
  { id: "S1", name: "loan.docx", doc: documentFromPlainText(S1), pages: null },
  { id: "S2", name: "side.docx", doc: documentFromPlainText(S2), pages: null },
]);

const fact = (field: string, value: string, quote: string, docId: string, status = "found") =>
  ({ field, label: "", value, status, quote, docId, anchor: "" }) as LegalExtractModelResponse["facts"][number];
const missing = (field: string) => fact(field, "", "", "", "missing");

/** A complete, clean answer for S1 and S2. */
function cleanResponse(): LegalExtractModelResponse {
  return {
    documentType: "Loan agreement",
    parties: [
      { name: "PT Aurora Holdings", role: "Borrower", quote: "PT Aurora Holdings (the Borrower)", docId: "S1" },
    ],
    files: [
      { docId: "S1", role: "draft", reason: "" },
      { docId: "S2", role: "reference", reason: "" },
    ],
    side: null,
    facts: [
      fact(
        "parties",
        "PT Aurora Holdings and Bank Sinar",
        "between PT Aurora Holdings (the Borrower) and Bank Sinar",
        "S1",
      ),
      fact("effective-date", "14 August 2026", "This Agreement is dated 14 August 2026", "S1"),
      missing("term"),
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
  };
}

function outputsOf(response: LegalExtractModelResponse | null, extra: Partial<CallOutput> = {}): CallOutput[] {
  return [{ index: 0, docIds: ["S1", "S2"], response, problem: response ? null : "not valid JSON", raw: "", ...extra }];
}

type Verdict = { ok: boolean; error?: string; why?: string; fix?: string };

async function verdicts(outputs: CallOutput[], locale: "en" | "id" = "en") {
  const built = buildExtractChecks({ evidence, locale });
  const results = new Map<string, Verdict>();
  for (const check of built.checks) {
    results.set(check.id, (await check.run(outputs)) as Verdict);
  }
  return { built, results };
}

describe("the five extraction checks", () => {
  it("pass a clean answer, and give every fact and the red flag a verified outcome", async () => {
    const { built, results } = await verdicts(outputsOf(cleanResponse()));
    expect([...results].map(([id, verdict]) => [id, verdict.ok])).toEqual([
      ["legal-shape", true],
      ["legal-quotes", true],
      ["legal-values", true],
      ["legal-coverage", true],
      ["legal-scope", true],
    ]);
    const outcomes = outcomesById(built.judgements());
    expect(outcomes.get("payment:S1")).toBe("verified");
    expect(outcomes.get("term:-")).toBe("not-in-sources");
    expect([...outcomes.values()].every((outcome) => outcome !== "unverified")).toBe(true);
  });

  it("legal-shape fails a call that could not be read, a found fact with no value, a short quote and an unknown file", async () => {
    const response = cleanResponse();
    response.facts[3] = fact(
      "payment",
      "",
      "The Borrower shall repay Rp 1.500.000.000 within twelve (12) months",
      "S1",
    );
    response.facts[4] = fact("liability", "indemnity", "unlimited", "S1");
    response.facts[6] = fact(
      "governing-law",
      "Indonesia",
      "This Agreement is governed by the laws of Indonesia.",
      "S9",
    );
    const { results } = await verdicts(outputsOf(response));
    const shape = results.get("legal-shape");
    expect(shape?.ok).toBe(false);
    expect(shape?.error).toMatch(/payment:S1: marked found but the value is empty/);
    expect(shape?.error).toMatch(/liability:S1: the quote must be 12 to 400 characters/);
    expect(shape?.error).toMatch(/governing-law:S9: docId "S9" is not one of the files/);
    const unreadable = await verdicts(outputsOf(null));
    expect(unreadable.results.get("legal-shape")?.error).toMatch(/answer: not valid JSON/);
  });

  it("legal-quotes fails a quote that is not in the files and names it", async () => {
    const response = cleanResponse();
    response.redFlags = [
      {
        ...(response.redFlags[0] as LegalExtractModelResponse["redFlags"][number]),
        quote: "The Lender may seize every asset of the Borrower at will",
      },
    ];
    const { results, built } = await verdicts(outputsOf(response));
    expect(results.get("legal-quotes")?.ok).toBe(false);
    expect(results.get("legal-quotes")?.error).toMatch(/The Lender may seize every asset/);
    const failed = built.judgements().filter((judgement) => !judgement.ok);
    expect(failed.map((judgement) => judgement.id)).toEqual([expect.stringMatching(/^flag:S1:/)]);
    expect(outcomesById(built.judgements()).get(failed[0]?.id as string)).toBe("unverified");
  });

  it("legal-quotes accepts a quote that differs only in case, spacing or line breaks, and one the model filed under the wrong file", async () => {
    const response = cleanResponse();
    response.facts[1] = fact("effective-date", "14 August 2026", "this agreement is DATED  14 August 2026", "S2");
    const { results } = await verdicts(outputsOf(response));
    expect(results.get("legal-quotes")?.ok).toBe(true);
  });

  it("legal-values fails a figure the quoted passage does not state, and a date it does not state", async () => {
    const response = cleanResponse();
    response.facts[3] = fact(
      "payment",
      "Rp 2.500.000.000",
      "The Borrower shall repay Rp 1.500.000.000 within twelve (12) months",
      "S1",
    );
    response.facts[1] = fact("effective-date", "15 August 2026", "This Agreement is dated 14 August 2026", "S1");
    const { results } = await verdicts(outputsOf(response));
    expect(results.get("legal-values")?.ok).toBe(false);
    expect(results.get("legal-values")?.error).toMatch(/payment:S1: the value states Rp 2\.500\.000\.000/);
    expect(results.get("legal-values")?.error).toMatch(
      /effective-date:S1: the value states the date or time 15 August 2026/,
    );
  });

  it("legal-values reads a date written as '14th day of August, 2026' as the date 14 August 2026", async () => {
    const response = cleanResponse();
    response.facts[1] = fact(
      "effective-date",
      "14 August 2026",
      "Signed this 14th day of August, 2026 by the parties",
      "S2",
    );
    const { results } = await verdicts(outputsOf(response));
    expect(results.get("legal-values")?.ok).toBe(true);
  });

  it("legal-values fails a red flag explanation that states a figure the file never does", async () => {
    const response = cleanResponse();
    response.redFlags = [
      {
        ...(response.redFlags[0] as LegalExtractModelResponse["redFlags"][number]),
        why: "The indemnity could cost Rp 9.999.000.000.",
      },
    ];
    const { results } = await verdicts(outputsOf(response));
    expect(results.get("legal-values")?.error).toMatch(/the explanation states Rp 9\.999\.000\.000/);
  });

  it("legal-coverage fails a field with no entry and a file with no role, and counts 'missing' as an answer", async () => {
    const response = cleanResponse();
    response.facts = response.facts.filter((item) => item.field !== "liability");
    response.files = response.files.filter((file) => file.docId !== "S2");
    const { results } = await verdicts(outputsOf(response));
    expect(results.get("legal-coverage")?.ok).toBe(false);
    expect(results.get("legal-coverage")?.error).toMatch(/liability: no entry for this field/);
    expect(results.get("legal-coverage")?.error).toMatch(/S2: no role given/);
    expect(results.get("legal-coverage")?.error).not.toMatch(/term:/);
    const covered = await verdicts(outputsOf(cleanResponse()));
    expect(covered.results.get("legal-coverage")?.ok).toBe(true);
    expect([...LEGAL_FACT_FIELDS]).toHaveLength(7);
  });

  it("legal-scope fails advice and a statute no file cites, and lets a sentence that reports the file through", async () => {
    const advice = cleanResponse();
    advice.redFlags = [
      {
        ...(advice.redFlags[0] as LegalExtractModelResponse["redFlags"][number]),
        why: "You should reject this clause and renegotiate under UU No. 11 Tahun 2020.",
      },
    ];
    const { results } = await verdicts(outputsOf(advice));
    expect(results.get("legal-scope")?.ok).toBe(false);
    expect(results.get("legal-scope")?.error).toMatch(/gives advice/);

    const citing = cleanResponse();
    citing.redFlags = [
      {
        ...(citing.redFlags[0] as LegalExtractModelResponse["redFlags"][number]),
        why: "This conflicts with UU No. 11 Tahun 2020.",
      },
    ];
    expect((await verdicts(outputsOf(citing))).results.get("legal-scope")?.error).toMatch(
      /cites "UU No\. 11 Tahun 2020"/,
    );

    const reporting = cleanResponse();
    reporting.redFlags = [
      {
        ...(reporting.redFlags[0] as LegalExtractModelResponse["redFlags"][number]),
        why: "The clause states that the Borrower must indemnify without a cap.",
      },
    ];
    expect((await verdicts(outputsOf(reporting))).results.get("legal-scope")?.ok).toBe(true);
  });

  it("routes each failure to the call that produced it, so a repair re-asks only that call", async () => {
    const good = cleanResponse();
    const bad = cleanResponse();
    bad.facts[3] = fact(
      "payment",
      "Rp 2.500.000.000",
      "The Borrower shall repay Rp 1.500.000.000 within twelve (12) months",
      "S1",
    );
    const outputs: CallOutput[] = [
      {
        index: 0,
        docIds: ["S1"],
        response: { ...good, files: [{ docId: "S1", role: "draft", reason: "" }] },
        problem: null,
        raw: "",
      },
      {
        index: 1,
        docIds: ["S2"],
        response: { ...bad, files: [{ docId: "S2", role: "reference", reason: "" }] },
        problem: null,
        raw: "",
      },
    ];
    const { built } = await verdicts(outputs);
    const failures = built.failuresByCall();
    expect([...failures.keys()]).toEqual([1]);
    expect(failures.get(1)?.map((judgement) => judgement.id)).toEqual(["payment:S1#2"]);
  });
});
