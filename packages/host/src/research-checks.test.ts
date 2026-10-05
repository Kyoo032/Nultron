import { describe, expect, it } from "vitest";
import {
  RESEARCH_CHECK_IDS,
  RESEARCH_SYNTHESIS_CHECKS,
  excerptOf,
  repairRoundLabel,
  type SynthesisCheck,
  type SynthesisDraft,
} from "./research-checks";

function draft(overrides: Partial<SynthesisDraft> = {}): SynthesisDraft {
  return {
    summary: "Thin margins. Confidence: med.",
    findings: [
      { heading: "Margins are thin", body: "About 12% [S1].", sources: ["S1"] },
      { heading: "Failures are rising", body: "Two bankruptcies [S2].", sources: ["S2"] },
    ],
    emptyFindings: [],
    unknownCitations: [],
    sourceIds: ["S1", "S2", "S3"],
    ...overrides,
  };
}

function checkById(id: string): SynthesisCheck {
  const found = RESEARCH_SYNTHESIS_CHECKS.find((check) => check.id === id);
  if (!found) {
    throw new Error(`no check ${id}`);
  }
  return found;
}

describe("research synthesis checks", () => {
  it("lists the three checks in the order the repair note shows them", () => {
    expect(RESEARCH_SYNTHESIS_CHECKS.map((check) => check.id)).toEqual([
      "research-citations-resolve",
      "research-findings-cited",
      "research-sections-filled",
    ]);
  });

  it("passes a synthesis whose findings all cite a known source and whose sections are filled", () => {
    for (const check of RESEARCH_SYNTHESIS_CHECKS) {
      expect(check.run(draft())).toEqual({ ok: true });
    }
  });

  describe(RESEARCH_CHECK_IDS.cited, () => {
    const check = checkById(RESEARCH_CHECK_IDS.cited);

    it("fails each finding with no resolved citation, and names the allowed ids", () => {
      const verdict = check.run(
        draft({
          findings: [
            { heading: "Margins are thin", body: "About 12%.", sources: [] },
            { heading: "Failures are rising", body: "Two bankruptcies [S2].", sources: ["S2"] },
            { heading: "Black mass demand fell", body: "Demand fell.", sources: [] },
          ],
        }),
      );
      expect(verdict).toEqual({
        ok: false,
        check: "research-findings-cited",
        error: '2 findings cite no source: finding "Margins are thin"; finding "Black mass demand fell".',
        why: "A finding states a fact. Without a source id the reader cannot tell where it came from.",
        fix: 'Sections to fix: finding "Margins are thin"; finding "Black mass demand fell". Put [Sn] inside each body and list the same ids in "sources", using only S1, S2, S3. If no source supports a finding, remove it.',
      });
    });

    it("says it in the singular for one finding", () => {
      const verdict = check.run(draft({ findings: [{ heading: "Only one", body: "Claim.", sources: [] }] }));
      expect(verdict).toMatchObject({ ok: false, error: '1 finding cites no source: finding "Only one".' });
    });
  });

  describe(RESEARCH_CHECK_IDS.resolve, () => {
    const check = checkById(RESEARCH_CHECK_IDS.resolve);

    it("fails a citation that no source carries, grouped by section, and names the allowed ids", () => {
      const verdict = check.run(
        draft({
          unknownCitations: [
            { section: { kind: "finding", excerpt: "Failures are rising" }, id: "S99" },
            { section: { kind: "summary", excerpt: "" }, id: "S7" },
            { section: { kind: "finding", excerpt: "Failures are rising" }, id: "S98" },
            { section: { kind: "contradiction", excerpt: "S1 vs S2 on margins" }, id: "S50" },
            { section: { kind: "openQuestion", excerpt: "What next?" }, id: "S51" },
          ],
        }),
      );
      expect(verdict).toEqual({
        ok: false,
        check: "research-citations-resolve",
        error:
          'The answer cites source ids that do not exist: S99, S98 in finding "Failures are rising"; S7 in the summary; S50 in contradiction "S1 vs S2 on margins"; S51 in open question "What next?".',
        why: "Only the numbered sources in the prompt were read. A citation to any other id points at nothing, so the reader cannot check the claim.",
        fix: 'Sections to fix: finding "Failures are rising"; the summary; contradiction "S1 vs S2 on margins"; open question "What next?". Replace each unknown id with an allowed id that supports the claim, or delete the claim. Allowed source ids: S1, S2, S3.',
      });
    });

    it("caps a long list so the repair note stays short", () => {
      const unknownCitations = Array.from({ length: 10 }, (_, at) => ({
        section: { kind: "finding" as const, excerpt: `Finding ${at + 1}` },
        id: "S99",
      }));
      const verdict = check.run(draft({ unknownCitations }));
      expect(verdict).toMatchObject({ ok: false });
      expect(verdict.ok ? "" : verdict.error).toContain("; and 2 more.");
    });
  });

  describe(RESEARCH_CHECK_IDS.filled, () => {
    const check = checkById(RESEARCH_CHECK_IDS.filled);

    it("fails an empty summary", () => {
      expect(check.run(draft({ summary: "  " }))).toEqual({
        ok: false,
        check: "research-sections-filled",
        error: "the summary is empty.",
        why: "A section with nothing in it is a missing part of the answer, not a short one.",
        fix: "Sections to fix: the summary. Write the summary: the argument in 8 to 12 lines, then a confidence (high, med or low) and what evidence is thin.",
      });
    });

    it("fails findings dropped for an empty heading or body, by position", () => {
      expect(check.run(draft({ emptyFindings: [2, 4] }))).toEqual({
        ok: false,
        check: "research-sections-filled",
        error: "2 findings have an empty heading or body.",
        why: "A section with nothing in it is a missing part of the answer, not a short one.",
        fix: "Sections to fix: finding 2 of your findings list; finding 4 of your findings list. Give every finding a heading and a body, or remove it.",
      });
    });

    it("reports both problems in one verdict", () => {
      const verdict = check.run(draft({ summary: "", emptyFindings: [1] }));
      expect(verdict).toMatchObject({
        ok: false,
        error: "the summary is empty; 1 finding has an empty heading or body.",
      });
    });

    it("lets contradictions and open questions be empty, because the dossier renders them as 'None recorded.'", () => {
      expect(check.run(draft())).toEqual({ ok: true });
    });
  });
});

describe("excerptOf", () => {
  it("flattens whitespace and cuts at 60 characters with an ellipsis", () => {
    expect(excerptOf("  two\n words  ")).toBe("two words");
    expect(excerptOf("x".repeat(70))).toBe(`${"x".repeat(59)}…`);
  });
});

describe("repairRoundLabel", () => {
  it("has a label in both app languages", () => {
    expect(repairRoundLabel("en")).toBe("Repairing the findings");
    expect(repairRoundLabel("id")).toBe("Memperbaiki temuan");
  });
});
