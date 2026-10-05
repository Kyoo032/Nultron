import { describe, expect, it } from "vitest";
import { checkDraftAgainstSource } from "./source-check";

const draft = {
  title: "Field note for the week",
  sections: [
    {
      heading: "What shipped",
      body: "The rail on this desk already shows every work mode. The installer was last built in August.",
    },
  ],
};

describe("checkDraftAgainstSource", () => {
  it("does nothing without a source", () => {
    expect(checkDraftAgainstSource(draft, "  ")).toEqual({ checked: false, reason: "no_source", items: [] });
  });

  it("marks a sentence the source does not support and keeps one it does", () => {
    const result = checkDraftAgainstSource(draft, "The rail on this desk already shows every work mode.");
    expect(result.checked).toBe(true);
    const supported = result.items.filter((item) => item.supported).map((item) => item.sentence);
    const unsupported = result.items.filter((item) => !item.supported).map((item) => item.sentence);
    expect(supported.some((sentence) => sentence.includes("every work mode"))).toBe(true);
    expect(unsupported.some((sentence) => sentence.includes("August"))).toBe(true);
  });

  it("marks a sentence that states a number the source never stated", () => {
    const numbered = {
      title: "Field note",
      sections: [
        {
          heading: "What shipped",
          body: "The rail on this desk already shows 14 work modes.",
        },
      ],
    };
    const result = checkDraftAgainstSource(numbered, "The rail on this desk already shows every work mode.");
    expect(result.items.some((item) => item.sentence.includes("14") && !item.supported)).toBe(true);
  });

  it("does not hold a title or heading that carries a number to the source", () => {
    const labelled = {
      title: "Q3 field note",
      sections: [
        { heading: "Heading 1", body: "The rail on this desk already shows every work mode." },
        { heading: "2. Risks", body: "The installer was last built in August." },
      ],
    };
    const result = checkDraftAgainstSource(labelled, "The rail on this desk already shows every work mode.");
    // Only the two body sentences are checked: the labels are not sentences.
    expect(result.items.map((item) => [item.sectionIndex, item.supported])).toEqual([
      [0, true],
      [1, false],
    ]);
  });

  it("still checks a heading of six words or more, number or not", () => {
    const longHeading = {
      title: "Field note",
      sections: [{ heading: "Why the rail shows 14 modes on this desk", body: "Nothing else is said here." }],
    };
    const result = checkDraftAgainstSource(longHeading, "The rail on this desk already shows every work mode.");
    expect(result.items).toEqual([
      { sectionIndex: 0, sentence: "Why the rail shows 14 modes on this desk.", supported: false },
    ]);
  });
});
