import { describe, expect, it } from "vitest";
import { ASK_COPY, TAP_SUMMARY_MAX, askCopy, speakable, tapSummary, voiceNote } from "./ask-speech";
import type { VoiceLocale } from "./turns";

const LOCALES: readonly VoiceLocale[] = ["en", "id"];
const MARKUP = /[*_`#>|[\]{}<]|https?:\/\//;

describe("the fixed sentences ask_nultron speaks", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      const copy = ASK_COPY[locale];

      it("has every sentence, short and plain enough to say aloud", () => {
        for (const [key, text] of Object.entries(copy)) {
          expect(text.trim().length, `${locale}.${key} is empty`).toBeGreaterThan(0);
          expect(text.length, `${locale}.${key} is long for speech`).toBeLessThanOrEqual(120);
          expect(text, `${locale}.${key} has markup`).not.toMatch(MARKUP);
        }
      });

      it("names the same keys as the other language", () => {
        expect(Object.keys(copy).sort()).toEqual(Object.keys(ASK_COPY.en).sort());
      });
    });
  }

  it("does not repeat English in the Indonesian copy", () => {
    for (const key of Object.keys(ASK_COPY.en) as Array<keyof typeof ASK_COPY.en>) {
      expect(ASK_COPY.id[key], key).not.toBe(ASK_COPY.en[key]);
    }
  });

  it("reads an unknown locale as English instead of throwing", () => {
    expect(askCopy("fr" as VoiceLocale)).toBe(ASK_COPY.en);
  });

  it("tells the person a card is on the screen and one tap starts it", () => {
    expect(ASK_COPY.en.needsTap).toMatch(/screen/i);
    expect(ASK_COPY.en.needsTap).toMatch(/tap/i);
    expect(ASK_COPY.id.needsTap).toMatch(/layar/i);
    expect(ASK_COPY.id.needsTap).toMatch(/ketuk/i);
  });
});

describe("the voice note", () => {
  it("asks for three short spoken sentences with no markup, in the session's language", () => {
    const en = voiceNote("en");
    expect(en).toContain("three short sentences");
    expect(en).toMatch(/no markdown/i);
    expect(en).toMatch(/no lists/i);
    expect(en).toMatch(/no links/i);
    expect(en).toMatch(/no file paths/i);
    expect(en).toMatch(/numbers and currency/i);
    expect(en).toMatch(/does not have the answer/i);
    expect(en).toContain("English");
    expect(voiceNote("id")).toContain("Indonesian");
  });

  it("sends write, send, paid and long requests to request_tap", () => {
    expect(voiceNote("en")).toContain("request_tap");
    expect(voiceNote("id")).toContain("request_tap");
  });
});

describe("speakable", () => {
  it("leaves plain speech alone", () => {
    expect(speakable("Revenue was twelve hundred dollars. It rose five percent.")).toBe(
      "Revenue was twelve hundred dollars. It rose five percent.",
    );
  });

  it("drops emphasis, headings, bullets and numbering but keeps the words", () => {
    const out = speakable("## Summary\n\n**Revenue** rose.\n\n- first item\n- second item\n\n1. one\n2. two");
    expect(out).toBe("Summary Revenue rose. first item second item one two");
    expect(out).not.toMatch(MARKUP);
  });

  it("keeps the words of a link and drops the address", () => {
    expect(speakable("See [the report](https://example.com/a?b=1) for more.")).toBe("See the report for more.");
    expect(speakable("Open https://example.com/x now")).toBe("Open now");
  });

  it("drops source markers and images", () => {
    expect(speakable("It rose [1] and then fell [2, 3].")).toBe("It rose and then fell.");
    expect(speakable("Look ![chart](/api/v1/media/abc/file) here")).toBe("Look here");
  });

  it("removes code fences and inline code marks but keeps the code's words", () => {
    expect(speakable("Run `ls` first.\n```sh\necho hi\n```")).toBe("Run ls first. echo hi");
  });

  it("reads a table as separated words", () => {
    const out = speakable("| Name | Total |\n| --- | --- |\n| Ada | 5 |");
    expect(out).not.toMatch(/[|]/);
    expect(out).toContain("Ada");
    expect(out).toContain("Total");
  });

  it("collapses line breaks and extra spaces into one run", () => {
    expect(speakable("One.\n\n\nTwo.   Three.")).toBe("One. Two. Three.");
  });

  it("returns an empty string for text that was only markup", () => {
    expect(speakable("![x](y)\n\n---\n")).toBe("");
    expect(speakable("")).toBe("");
  });
});

describe("tapSummary", () => {
  it("uses the model's line, flattened", () => {
    expect(tapSummary("Make a deck\nabout Q3", "ignored")).toBe("Make a deck about Q3");
  });

  it("falls back to the person's own request when the model gave nothing", () => {
    expect(tapSummary("  ", "make me a deck")).toBe("make me a deck");
    expect(tapSummary(undefined, "make me a deck")).toBe("make me a deck");
    expect(tapSummary(42, "make me a deck")).toBe("make me a deck");
  });

  it("cuts a long line at a word", () => {
    const long = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
    const out = tapSummary(long, "x");
    expect(out.length).toBeLessThanOrEqual(TAP_SUMMARY_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });
});
