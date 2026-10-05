import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_LIBRARY } from "@agentforge/core";
import type { CheckVerdict } from "@agentforge/core/harness";
import {
  buildChecksReport,
  documentChecks,
  findUngroundedSections,
  groundingCheck,
  MAX_DOCUMENT_SECTIONS,
  requiredSectionCount,
  structureCheck,
  structureIssues,
  type DocumentCheckInput,
} from "./documents-checks";
import type { DocumentDraft } from "./document-outline";

const WHY_STRUCTURE =
  "A document is done when it reads as the JSON draft and every section the brief asks for is present and written out. The host cannot preview or download anything less.";
const FIX_STRUCTURE =
  'Return the whole document again as one JSON object {"title": string, "sections": [{"heading": string, "body": string}]} with no markdown fences and no commentary. Include every required section, each written out as finished prose with no placeholders.';

const FINISHED =
  "Saturday pickup stays on the current card reader through the October renewal. Maya writes the two-reader plan this week.";

function draftOf(...bodies: string[]): DocumentDraft {
  return {
    title: "Pickup memo",
    sections: bodies.map((body, index) => ({ heading: `Heading ${index + 1}`, body })),
  };
}

const input = (draft: DocumentDraft | null, parseError: string | null = null): DocumentCheckInput => ({
  draft,
  parseError,
});

function verdictOf(check: ReturnType<typeof structureCheck>, value: DocumentCheckInput): CheckVerdict {
  return check.run(value) as CheckVerdict;
}

describe("requiredSectionCount", () => {
  const documents = TEMPLATE_LIBRARY.filter((entry) => entry.mode === "documents");
  const EXPECTED: Record<string, number> = {
    "Decision memo": 6,
    "Project one-pager": 6,
    "Design RFC": 7,
    "Meeting digest": 4,
    "Kickoff agenda": 5,
    "Handoff pack": 6,
  };

  it("counts the numbered list under Required sections in every built-in template", () => {
    expect(documents.map((entry) => entry.title).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of documents) {
      expect(requiredSectionCount(entry.prompt), entry.title).toBe(EXPECTED[entry.title]);
    }
  });

  it("counts the same when the line breaks are gone, as the one-line prompt box delivers a brief", () => {
    for (const entry of documents) {
      const oneLine = entry.prompt.replace(/\r?\n/g, "");
      expect(requiredSectionCount(oneLine), entry.title).toBe(EXPECTED[entry.title]);
    }
  });

  it("counts the Indonesian templates too", () => {
    const localesDir = resolve(__dirname, "../../../apps/web/locales");
    const id = JSON.parse(readFileSync(resolve(localesDir, "id", "documents.json"), "utf8")) as {
      templates: Record<string, { prompt: string }>;
    };
    const counts = Object.fromEntries(
      Object.entries(id.templates).map(([key, value]) => [key, requiredSectionCount(value.prompt)]),
    );
    expect(counts).toEqual({
      "decision-memo": 6,
      "project-one-pager": 6,
      "design-rfc": 7,
      "meeting-digest": 4,
      "kickoff-agenda": 5,
      "handoff-pack": 6,
    });
  });

  it("is null for a brief that lists nothing, and does not read digits elsewhere as a list", () => {
    expect(requiredSectionCount("Write a status memo for leadership")).toBeNull();
    expect(requiredSectionCount("Deliverable: 5-7 sections, 700-1000 words. 1. maybe")).toBeNull();
    expect(requiredSectionCount("Required sections: keep it short, 2. is not the first item")).toBeNull();
  });

  it("stops at the first number that does not follow, and ignores a number far past the list", () => {
    const brief = `Required sections:\n1. Decision.\n2. Context.\n3. Ask.\n\nQuality bar: ${"x".repeat(50)} 4. later`;
    expect(requiredSectionCount(brief)).toBe(3);
  });
});

describe("structure check", () => {
  const check = structureCheck("Write the memo", "");

  it("passes a finished draft", () => {
    expect(verdictOf(check, input(draftOf(FINISHED, FINISHED)))).toEqual({ ok: true });
  });

  it("fails a reply that was not a draft, with the parse reason in the note", () => {
    expect(verdictOf(check, input(null, "Model returned invalid JSON for the document"))).toEqual({
      ok: false,
      check: "structure",
      error: "The reply was not a document draft: Model returned invalid JSON for the document.",
      why: WHY_STRUCTURE,
      fix: FIX_STRUCTURE,
    });
  });

  it("fails fewer sections than the brief requires, naming both numbers", () => {
    const brief = "Write it.\n\nRequired sections:\n1. Decision.\n2. Context.\n3. Ask.\n";
    const verdict = verdictOf(structureCheck(brief, ""), input(draftOf(FINISHED, FINISHED)));
    expect(verdict).toEqual({
      ok: false,
      check: "structure",
      error: "The brief lists 3 required sections and the draft has 2.",
      why: WHY_STRUCTURE,
      fix: FIX_STRUCTURE,
    });
  });

  it("fails a label-length body and a placeholder, each named by its position and heading", () => {
    const draft: DocumentDraft = {
      title: "Pickup memo",
      sections: [
        { heading: "Decision", body: FINISHED },
        { heading: "Context", body: "Coming soon." },
        { heading: "Ask", body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit." },
        { heading: "Risks", body: "TBD" },
      ],
    };
    expect(structureIssues(input(draft), "Write it", "")).toEqual([
      'Section 2 ("Context") is only 2 words, which is a label and not finished writing.',
      'Section 3 ("Ask") still holds placeholder text.',
      'Section 4 ("Risks") is only 1 words, which is a label and not finished writing.',
    ]);
  });

  it("fails a whitespace-only body that the draft schema lets through", () => {
    expect(structureIssues(input(draftOf(FINISHED, "   ")), "Write it", "")).toEqual([
      'Section 2 ("Heading 2") has an empty body.',
    ]);
  });

  it("fails more sections than the prompt's own cap", () => {
    const many = draftOf(...Array.from({ length: MAX_DOCUMENT_SECTIONS + 1 }, () => FINISHED));
    expect(structureIssues(input(many), "Write it", "")).toEqual([
      `The draft has ${MAX_DOCUMENT_SECTIONS + 1} sections; the limit is ${MAX_DOCUMENT_SECTIONS}.`,
    ]);
  });

  it("lets a TBD stand when the brief or the source says TBD itself", () => {
    const quoted = draftOf(`The renewal date is listed as TBD in the vendor note, so we plan around it. ${FINISHED}`);
    expect(structureIssues(input(quoted), "Write it", "")).toHaveLength(1);
    expect(structureIssues(input(quoted), "Write it", "Renewal date: TBD")).toEqual([]);
    expect(structureIssues(input(quoted), "Mention the TBD renewal date", "")).toEqual([]);
  });

  it("does not fail the two starter drafts or a built-in template's required list when it is met", () => {
    const localesDir = resolve(__dirname, "../../../apps/web/locales");
    const en = JSON.parse(readFileSync(resolve(localesDir, "en", "documents.json"), "utf8")) as {
      starters: Record<string, Record<string, unknown>>;
    };
    for (const starter of Object.values(en.starters)) {
      const sections = Object.entries(starter)
        .filter(([key]) => /^s\d+$/.test(key))
        .map(([, value]) => value as { heading: string; body: string });
      expect(structureIssues(input({ title: String(starter.title), sections }), "Write it", "")).toEqual([]);
    }
    const decision = TEMPLATE_LIBRARY.find((entry) => entry.title === "Decision memo");
    const six = draftOf(...Array.from({ length: 6 }, () => FINISHED));
    expect(structureIssues(input(six), decision?.prompt ?? "", "")).toEqual([]);
    expect(
      structureIssues(input(draftOf(...Array.from({ length: 5 }, () => FINISHED))), decision?.prompt ?? "", ""),
    ).toEqual(["The brief lists 6 required sections and the draft has 5."]);
  });

  it("lists at most five issues and counts the rest", () => {
    const thin = draftOf(...Array.from({ length: 8 }, () => "Too short."));
    const verdict = verdictOf(check, input(thin));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.endsWith("...and 3 more.")).toBe(true);
      expect(verdict.error.match(/is only 2 words/g)).toHaveLength(5);
    }
  });
});

describe("grounding check", () => {
  // The status-memo starter's own text, as a pasted source.
  const SOURCE = [
    "Saturday wait is 8 minutes over the last four weekends (target 5). Two readers timed out on Thursday; we have the till log, not a repair ticket yet.",
    "Bag labels went out for the first twenty pre-orders. Timing the queue is still open. Alex owns it, blocked when two orders share a customer name.",
    "The printed door menu is still the 31 Aug sheet. The counter whiteboard already shows the new Saturday hours; anyone who only reads the door will not see them until we reprint.",
    "Approve keeping Saturday pickup on the current card reader through the 15 Oct renewal. Maya will write the two-reader plan this week; accounts will not sign a second supplier before then.",
  ].join("\n\n");

  const FAITHFUL = draftOf(
    "Saturday wait averaged 8 minutes across the last four weekends against a target of 5. Two card readers timed out on Thursday, and the till log exists but no repair ticket has been filed yet. Bag labels went out for the first twenty pre-orders.",
    "The printed door menu is still the 31 Aug sheet, while the counter whiteboard already shows the new Saturday hours. Anyone who only reads the door will not see them until we reprint.",
    "Please approve keeping Saturday pickup on the current card reader through the 15 Oct renewal. Maya will write the two-reader plan this week, and accounts will not sign a second supplier before then.",
  );

  const INVENTED =
    "The company will open three new stores in Jakarta next year. Revenue is expected to double after the expansion completes. Investors approved a budget of five million dollars for hiring.";

  it("passes a faithful paraphrase of the source, with every section under the flag", () => {
    expect(findUngroundedSections(FAITHFUL, SOURCE)).toEqual([]);
    expect(verdictOf(groundingCheck(SOURCE), input(FAITHFUL))).toEqual({ ok: true });
  });

  it("flags a section whose sentences are invented, and only that section", () => {
    const draft: DocumentDraft = {
      ...FAITHFUL,
      sections: [FAITHFUL.sections[0] as never, { heading: "Growth", body: INVENTED }],
    };
    const flagged = findUngroundedSections(draft, SOURCE);
    expect(flagged).toEqual([
      {
        sectionIndex: 1,
        heading: "Growth",
        checked: 3,
        unsupported: 3,
        example: "The company will open three new stores in Jakarta next year.",
      },
    ]);
  });

  it("writes the failing verdict with the section, the count and a rewrite-only-from-the-source fix", () => {
    const draft: DocumentDraft = {
      ...FAITHFUL,
      sections: [FAITHFUL.sections[0] as never, { heading: "Growth", body: INVENTED }],
    };
    expect(verdictOf(groundingCheck(SOURCE), input(draft))).toEqual({
      ok: false,
      check: "grounding",
      error:
        'A section does not follow the source material. Section 2 ("Growth"): 3 of 3 sentences are not in the source, for example "The company will open three new stores in Jakarta next year.".',
      why: "The brief supplied source material, and the draft may use only that material for facts, figures, names and quotes. These sections state things the source does not contain.",
      fix: "Rewrite the listed sections using only facts, figures, names and quotes that appear in the source material. Delete any claim the source does not support, and where the source is silent say so in one sentence instead of filling the gap. Keep the other sections as they are and return the whole JSON document.",
    });
  });

  const OWN = "Saturday wait averaged 8 minutes across the last four weekends against a target of 5.";
  const MADE_UP = [
    "The company will open three new stores in Jakarta next year.",
    "Revenue is expected to double after the expansion completes.",
    "Investors approved a budget of five million dollars for hiring.",
  ];

  function flaggedCounts(...sentences: string[]): Array<[number, number, number]> {
    return findUngroundedSections(draftOf(sentences.join(" ")), SOURCE).map((item) => [
      item.sectionIndex,
      item.unsupported,
      item.checked,
    ]);
  }

  it("does not flag one stray sentence, half a section, or two sentences in three", () => {
    expect(
      flaggedCounts(OWN, OWN, OWN, "The new supplier will certainly deliver better results next quarter."),
    ).toEqual([]);
    expect(flaggedCounts(OWN, OWN, MADE_UP[0] as string, MADE_UP[1] as string)).toEqual([]);
    expect(flaggedCounts(OWN, MADE_UP[0] as string, MADE_UP[1] as string)).toEqual([]);
  });

  it("flags three sentences in four, and two in two", () => {
    expect(flaggedCounts(OWN, ...MADE_UP)).toEqual([[0, 3, 4]]);
    expect(flaggedCounts(MADE_UP[0] as string, MADE_UP[1] as string)).toEqual([[0, 2, 2]]);
  });

  it("passes without a source and when the reply was not a draft", () => {
    expect(verdictOf(groundingCheck(""), input(draftOf(INVENTED)))).toEqual({ ok: true });
    expect(verdictOf(groundingCheck(SOURCE), input(null, "bad"))).toEqual({ ok: true });
    expect(findUngroundedSections(draftOf(INVENTED), "   ")).toEqual([]);
  });
});

describe("documentChecks and the report", () => {
  it("runs structure alone without a source, and structure then grounding with one", () => {
    expect(documentChecks("Write it", "").map((check) => check.id)).toEqual(["structure"]);
    expect(documentChecks("Write it", "Some source text").map((check) => check.id)).toEqual(["structure", "grounding"]);
  });

  it("turns failing verdicts into a report with the flagged sections, and a pass into an empty one", () => {
    const source = "Saturday wait is 8 minutes over the last four weekends (target 5).";
    const invented =
      "The company will open three new stores in Jakarta next year. Revenue is expected to double after the expansion completes.";
    const draft = draftOf(invented, "Saturday wait is 8 minutes over the last four weekends.");
    const verdicts = documentChecks("Write it", source).map((check) => check.run(input(draft)) as CheckVerdict);
    const report = buildChecksReport(verdicts, 1, draft, source);
    expect(report.passed).toBe(false);
    expect(report.rounds).toBe(1);
    expect(report.failures.map((failure) => [failure.check, failure.sections])).toEqual([["grounding", [0]]]);
    expect(buildChecksReport([{ ok: true }], 0, draft, source)).toEqual({ passed: true, rounds: 0, failures: [] });
  });
});
