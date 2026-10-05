import { describe, expect, it } from "vitest";
import type { CheckVerdict } from "@agentforge/core/harness";
import type { PresentationOutline, PresentationSlide } from "./presentation-outline";
import { MAX_OUTLINE_SLIDES, presentationCheckNotes, presentationChecks } from "./presentation-checks";

function slide(over: Partial<PresentationSlide> = {}): PresentationSlide {
  return {
    kind: "bullets",
    heading: "Billing moves on Monday",
    subhead: "",
    bullets: ["The new vendor takes over invoices from the first of the month."],
    aside: "",
    notes: "",
    shapes: [],
    ...over,
  };
}

/** A mixed-kind deck, so the export draws each slide as its own kind (a deck of only bullets is re-laid out). */
function outline(slides: PresentationSlide[]): PresentationOutline {
  return { title: "Vendor switch", slides };
}

const MIXED = [
  slide({ kind: "section", heading: "The switch is a Monday decision", subhead: "One owner, one date." }),
  slide({
    kind: "split",
    heading: "Billing moves first",
    bullets: ["Invoices go out from the new vendor.", "Old invoices are paid from the old account."],
    aside: "Nothing changes for the customer.",
  }),
  slide({ heading: "Support follows a week later" }),
  slide({ kind: "close", heading: "Approve by Friday", bullets: ["Sign the order by 17:00."] }),
];

function verdicts(deck: PresentationOutline, expected: number | null = null): Record<string, CheckVerdict> {
  return Object.fromEntries(presentationChecks(expected).map((check) => [check.id, check.run(deck) as CheckVerdict]));
}

describe("presentation checks", () => {
  it("passes a well-formed outline on every check", () => {
    const result = verdicts(outline(MIXED), 4);
    expect(result).toEqual({
      slide_count: { ok: true },
      slide_content: { ok: true },
      duplicate_title: { ok: true },
      slide_fit: { ok: true },
    });
    expect(presentationCheckNotes(outline(MIXED), 4)).toEqual([]);
  });

  it("lists the checks in the order the repair note reports them", () => {
    expect(presentationChecks(null).map((check) => check.id)).toEqual([
      "slide_count",
      "slide_content",
      "duplicate_title",
      "slide_fit",
    ]);
  });

  describe("slide count", () => {
    it("fails an outline that does not hold the requested number of content slides", () => {
      expect(verdicts(outline(MIXED), 3).slide_count).toEqual({
        ok: false,
        check: "slide_count",
        error: 'The outline has 4 items in "slides", but the request asked for 3.',
        why: 'The request asked for 4 slides in total. The title slide is one of them and is not in "slides".',
        fix: 'Return the whole outline with exactly 3 items in "slides".',
      });
      expect(presentationCheckNotes(outline(MIXED), 3)).toEqual([
        { check: "slide_count", slides: [], expected: 3, found: 4 },
      ]);
    });

    it("sets no count to match when the request set none, and caps the deck at the prompt's maximum", () => {
      const fourteen = outline(
        Array.from({ length: MAX_OUTLINE_SLIDES }, (_, i) => slide({ heading: `Claim ${i + 1}` })),
      );
      expect(verdicts(fourteen).slide_count).toEqual({ ok: true });
      const fifteen = outline(
        Array.from({ length: MAX_OUTLINE_SLIDES + 1 }, (_, i) => slide({ heading: `Claim ${i + 1}` })),
      );
      expect(verdicts(fifteen).slide_count).toEqual({
        ok: false,
        check: "slide_count",
        error: "The outline has 15 slides, more than the 14 a deck may have.",
        why: "Past that many slides the deck is too long to present and does not fit the way it is shown.",
        fix: 'Return the whole outline with at most 14 items in "slides", merging or dropping the weakest.',
      });
    });
  });

  describe("slide content", () => {
    it("names a slide with no heading and a slide with no bullet or body text", () => {
      const deck = outline([
        slide({ heading: "   " }),
        slide({ heading: "Support follows", bullets: ["  "] }),
        slide({ heading: "Approve by Friday" }),
      ]);
      expect(verdicts(deck).slide_content).toEqual({
        ok: false,
        check: "slide_content",
        error:
          'Slides with nothing to present: item 1 of "slides" has no heading; item 2 of "slides" ("Support follows") has no bullet or body text.',
        why: "A slide needs a heading and something under it, or it exports as an empty page.",
        fix: "Give each of those slides a heading and at least one bullet, subhead or aside, then return the whole outline.",
      });
      expect(presentationCheckNotes(deck, null)).toEqual([{ check: "slide_content", slides: [1, 2] }]);
    });

    it("counts a subhead or an aside as body text", () => {
      const deck = outline([
        slide({ heading: "Opener", bullets: [], subhead: "One line under it." }),
        slide({ heading: "Pointer", bullets: [], aside: "Point at this." }),
      ]);
      expect(verdicts(deck).slide_content).toEqual({ ok: true });
    });
  });

  describe("duplicate titles", () => {
    it("fails two slides whose headings differ only in case, spacing and punctuation", () => {
      const deck = outline([
        slide({ heading: "Billing moves first" }),
        slide({ heading: "Support follows" }),
        slide({ heading: "  billing  MOVES first! " }),
      ]);
      expect(verdicts(deck).duplicate_title).toEqual({
        ok: false,
        check: "duplicate_title",
        error:
          'Slides share a heading: item 1 of "slides" ("Billing moves first") and item 3 of "slides" ("billing  MOVES first!") share one heading.',
        why: "Two slides with the same heading cannot be told apart in the filmstrip or when presenting.",
        fix: "Rewrite those headings so each makes its own claim, then return the whole outline.",
      });
      expect(presentationCheckNotes(deck, null)).toEqual([{ check: "duplicate_title", slides: [1, 3] }]);
    });

    it("does not count two blank headings as a repeat; the content check owns them", () => {
      const deck = outline([slide({ heading: " " }), slide({ heading: "" })]);
      expect(verdicts(deck).duplicate_title).toEqual({ ok: true });
    });
  });

  describe("slide fit", () => {
    const withSlide = (index: number, over: Partial<PresentationSlide>) =>
      outline(MIXED.map((item, i) => (i === index ? { ...item, ...over } : item)));

    it("fails a heading past two lines of the exported heading box", () => {
      const long = "word ".repeat(24).trim();
      expect(long).toHaveLength(119);
      expect(verdicts(withSlide(2, { heading: long })).slide_fit).toEqual({
        ok: false,
        check: "slide_fit",
        error: `Too much text to fit the exported slide: item 3 of "slides" ("${long}"): heading.`,
        why: "The exported PowerPoint slide has fixed boxes, so extra text runs off the slide.",
        fix: "Shorten those parts (fewer or shorter bullets, a shorter heading) and return the whole outline.",
      });
      expect(verdicts(withSlide(2, { heading: "word ".repeat(20).trim() })).slide_fit).toEqual({ ok: true });
    });

    it("fails eight two-line bullets in the body box, and passes five", () => {
      const bullet = "b".repeat(150);
      expect(verdicts(withSlide(2, { bullets: Array(5).fill(bullet) })).slide_fit).toEqual({ ok: true });
      const eight = verdicts(withSlide(2, { bullets: Array(8).fill(bullet) })).slide_fit;
      expect(eight).toMatchObject({ ok: false, check: "slide_fit" });
      expect(presentationCheckNotes(withSlide(2, { bullets: Array(8).fill(bullet) }), null)).toEqual([
        { check: "slide_fit", slides: [3] },
      ]);
    });

    it("holds a split slide's bullets to its narrower box and its aside to the aside box", () => {
      const narrow = verdicts(withSlide(1, { bullets: Array(5).fill("c".repeat(170)) })).slide_fit;
      expect(narrow).toMatchObject({ ok: false });
      expect((narrow as { error: string }).error).toContain('item 2 of "slides" ("Billing moves first"): bullets');
      const aside = verdicts(withSlide(1, { aside: "a".repeat(600) })).slide_fit;
      expect((aside as { error: string }).error).toContain("aside");
      expect(verdicts(withSlide(1, { aside: "a".repeat(300) })).slide_fit).toEqual({ ok: true });
    });

    it("measures the layout the export draws, not the kind the model named", () => {
      const wide = Array(6).fill("d".repeat(170));
      // A deck of only bullets is re-laid out: the last slide closes and a middle one with three bullets
      // splits, taking its last bullet as the aside. Five 4-line bullets do not fit the 6.6 in split box.
      const flat = outline([
        slide({ heading: "First claim" }),
        slide({ heading: "Middle claim", bullets: wide }),
        slide({ heading: "Last claim" }),
      ]);
      expect(verdicts(flat).slide_fit).toMatchObject({ ok: false });
      expect(presentationCheckNotes(flat, null)).toEqual([{ check: "slide_fit", slides: [2] }]);
      // The same bullets on a slide that stays a bullets slide are two lines each in the 11.7 in box.
      const mixed = outline([
        slide({ kind: "section", heading: "Opener", subhead: "One line." }),
        slide({ heading: "Middle claim", bullets: wide }),
        slide({ kind: "close", heading: "Last claim" }),
      ]);
      expect(verdicts(mixed).slide_fit).toEqual({ ok: true });
    });
  });

  it("names every failing check with its slides in the wire notes, and no English", () => {
    const deck = outline([
      slide({ heading: "Same", bullets: [] }),
      slide({ heading: "Same", bullets: ["Something under it."] }),
    ]);
    expect(presentationCheckNotes(deck, 3)).toEqual([
      { check: "slide_count", slides: [], expected: 3, found: 2 },
      { check: "slide_content", slides: [1] },
      { check: "duplicate_title", slides: [1, 2] },
    ]);
  });
});
