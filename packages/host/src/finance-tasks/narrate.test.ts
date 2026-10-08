import { describe, expect, it } from "vitest";
import { UNVERIFIED_MARKER } from "@agentforge/core/finance";
import { adviceSentencesIn, guardNarration, parseNarration } from "./narrate";

const SECTIONS = [
  { id: "position", title: { id: "Posisi", en: "Position" } },
  { id: "outlook", title: { id: "Prospek", en: "Outlook" } },
];

function draftOf(narration: Record<string, unknown>) {
  return parseNarration(JSON.stringify(narration), SECTIONS, "How is cash?");
}

describe("guardNarration", () => {
  // The guard used to read the bodies only; a figure in a title, a heading or an assumption reached
  // the reader as though it had been computed.
  it("guards the title, every heading and every assumption, and never leaves the marker in them", () => {
    const draft = draftOf({
      title: "Cash lasts 14 months",
      sections: [
        { id: "position", heading: "Cash sits at 900 after a 35% drop", body: "Cash was 900." },
        { id: "outlook", heading: "What comes next", body: "Burn was 1234 a month." },
      ],
      assumptions: ["Monthly figures.", "A 5% raise lands in March."],
    });
    const { prose, guard } = guardNarration(draft, [900]);
    expect(prose.title).toBe("How is cash?");
    expect(prose.sections.map((section) => section.heading)).toEqual([
      "Cash sits at 900 after a drop",
      "What comes next",
    ]);
    expect(prose.assumptions).toEqual(["Monthly figures."]);
    const shown = [prose.title, ...prose.sections.map((section) => section.heading), ...prose.assumptions];
    expect(shown.join(" ")).not.toContain(UNVERIFIED_MARKER);
    // A body keeps its marker: the repair rewrites it once, then takes the sentence out.
    expect(prose.sections[1]?.body).toBe(`Burn was ${UNVERIFIED_MARKER} a month.`);
    expect(guard.flagged).toEqual([
      { section: -1, text: "14" },
      { section: 0, text: "35%" },
      { section: 1, text: "1234" },
      { section: -1, text: "5%" },
    ]);
    expect(guard.total).toBe(4);
  });

  it("never counts the reader's own question against the model when it stands in as the title", () => {
    const draft = parseNarration(
      JSON.stringify({ sections: [{ id: "position", heading: "Where cash sits", body: "Cash was 900." }] }),
      SECTIONS,
      "Does Rp 500 juta last to March?",
    );
    const { prose, guard } = guardNarration(draft, [900]);
    expect(prose.title).toBe("Does Rp 500 juta last to March?");
    expect(guard.total).toBe(0);
  });

  it("leaves prose whose every figure traces exactly as it was written", () => {
    const draft = draftOf({
      title: "Cash at 900",
      sections: [{ id: "position", heading: "900 in the bank", body: "Cash was 900 in 2025." }],
      assumptions: ["Figures for 2025."],
    });
    const { prose, guard } = guardNarration(draft, [900]);
    expect(prose).toEqual({
      title: "Cash at 900",
      sections: [{ id: "position", heading: "900 in the bank", body: "Cash was 900 in 2025." }],
      assumptions: ["Figures for 2025."],
    });
    expect(guard).toEqual({ flagged: [], total: 0 });
  });
});

// The appraisal rule "no buy, sell or fund directive" lived in the prompt only. The scope judge is
// the code that enforces it for every task: advice is found here, rewritten once and dropped by the
// hold in `scope.ts`, and the figures are untouched by any of it.
describe("adviceSentencesIn", () => {
  it("finds a sentence that tells the reader what to do, in English", () => {
    expect(adviceSentencesIn("Cash was 900. You should sell the asset now. Burn held.", [])).toEqual([
      "You should sell the asset now.",
    ]);
    expect(adviceSentencesIn("We recommend funding the project in full.", [])).toHaveLength(1);
  });

  it("finds it in Indonesian", () => {
    expect(adviceSentencesIn("Kas stabil. Sebaiknya Anda menjual aset itu. Beban tetap.", [])).toEqual([
      "Sebaiknya Anda menjual aset itu.",
    ]);
    expect(adviceSentencesIn("Kami sarankan untuk menolak proyek ini.", [])).toHaveLength(1);
  });

  it("leaves a sentence that describes the figures", () => {
    expect(adviceSentencesIn("NPV is positive at 14000, so the plan returns more than it costs.", [])).toEqual([]);
    expect(adviceSentencesIn("The payback is 3.2 years. Burn is lower than last quarter.", [])).toEqual([]);
  });

  it("leaves a sentence that reports what a document says", () => {
    expect(adviceSentencesIn("The loan agreement states that the borrower must repay by March.", [])).toEqual([]);
  });

  it("leaves a sentence the person's own text already contains", () => {
    const sources = ["Note from the CFO: you should review the outlay before the board meets."];
    expect(adviceSentencesIn("You should review the outlay before the board meets.", sources)).toEqual([]);
    expect(adviceSentencesIn("You should review the outlay before the board meets.", [])).toHaveLength(1);
  });

  it("looks at every paragraph", () => {
    const body = "Cash was 900.\n\nWe suggest cutting rent.\n\nBurn held.";
    expect(adviceSentencesIn(body, [])).toEqual(["We suggest cutting rent."]);
  });

  it("finds nothing in an empty body", () => {
    expect(adviceSentencesIn("", [])).toEqual([]);
  });
});

describe("guardNarration: the scope judge", () => {
  it("reports the sections that advise, by index, without changing the prose or the figure guard", () => {
    const draft = draftOf({
      title: "Cash at 900",
      sections: [
        { id: "position", heading: "Where cash sits", body: "Cash was 900. You should sell the asset." },
        { id: "outlook", heading: "What next", body: "Burn held at 900." },
      ],
      assumptions: ["Monthly figures."],
    });
    const { prose, guard, advice } = guardNarration(draft, [900], []);
    expect(advice).toEqual([{ section: 0, sentences: ["You should sell the asset."] }]);
    expect(prose.sections[0]?.body).toBe("Cash was 900. You should sell the asset.");
    expect(guard).toEqual({ flagged: [], total: 0 });
  });

  it("reports nothing when no section advises, and when no sources are given", () => {
    const draft = draftOf({
      title: "Cash at 900",
      sections: [{ id: "position", heading: "Where cash sits", body: "Cash was 900." }],
      assumptions: [],
    });
    expect(guardNarration(draft, [900]).advice).toEqual([]);
  });

  it("does not report advice the person's own source text already holds", () => {
    const draft = draftOf({
      title: "Cash at 900",
      sections: [
        { id: "position", heading: "Where cash sits", body: "Cash was 900. We recommend a review before March." },
      ],
      assumptions: [],
    });
    const sources = ["Auditor: we recommend a review before March."];
    expect(guardNarration(draft, [900], sources).advice).toEqual([]);
  });
});
