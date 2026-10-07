import { describe, expect, it } from "vitest";
import { isXmlChar, firstXmlIllegalChar } from "./xml-test-support";
import { stripXmlIllegalChars } from "./xml-text";

const EMOJI = String.fromCodePoint(0x1f600);
const NOT_CHARACTERS = String.fromCharCode(0xfffe, 0xffff);

describe("stripXmlIllegalChars", () => {
  it("leaves ordinary text, tabs, line breaks, accents, CJK and emoji alone", () => {
    const text = `Rencana toko\tkedua\r\nPendapatan naik 12% ${String.fromCharCode(0xe9, 0xe8)} ${String.fromCharCode(0x65e5, 0x672c)} ${EMOJI}`;
    expect(stripXmlIllegalChars(text)).toBe(text);
  });

  it("removes every control character XML 1.0 forbids", () => {
    const forbidden = [
      "\u0000",
      "\u0001",
      "\u0002",
      "\u0003",
      "\u0004",
      "\u0005",
      "\u0006",
      "\u0007",
      "\u0008",
      "\u000e",
      "\u000f",
      "\u0010",
      "\u001b",
      "\u001f",
    ];
    for (const char of forbidden) {
      expect(stripXmlIllegalChars(`a${char}b`), JSON.stringify(char)).toBe("ab");
    }
  });

  it("turns a form feed or a vertical tab into a space, so two PDF pages do not run together", () => {
    expect(stripXmlIllegalChars("end of page one\u000cstart of page two")).toBe("end of page one start of page two");
    expect(stripXmlIllegalChars("a\u000bb")).toBe("a b");
  });

  it("removes U+FFFE and U+FFFF, which are not characters", () => {
    expect(stripXmlIllegalChars(`a${NOT_CHARACTERS.charAt(0)}b${NOT_CHARACTERS.charAt(1)}c`)).toBe("abc");
  });

  it("removes a lone surrogate and keeps a real pair", () => {
    expect(stripXmlIllegalChars("a\ud800b")).toBe("ab");
    expect(stripXmlIllegalChars("a\udc00b")).toBe("ab");
    expect(stripXmlIllegalChars(`a${EMOJI}b`)).toBe(`a${EMOJI}b`);
    expect(stripXmlIllegalChars("a\ud83d")).toBe("a");
    expect(stripXmlIllegalChars(`${EMOJI.charAt(1)}${EMOJI}`)).toBe(EMOJI);
  });

  it("leaves nothing XML 1.0 refuses, whatever the input is made of", () => {
    let everyUnit = "";
    for (let code = 0; code <= 0xffff; code += 1) {
      everyUnit += String.fromCharCode(code);
    }
    const cleaned = stripXmlIllegalChars(everyUnit);
    expect(firstXmlIllegalChar(cleaned)).toBeNull();
    // The three whitespace controls XML allows survive.
    expect(cleaned.includes("\t")).toBe(true);
    expect(cleaned.includes("\n")).toBe(true);
    expect(cleaned.includes("\r")).toBe(true);
  });

  it("answers the same string when there was nothing to remove", () => {
    expect(stripXmlIllegalChars("")).toBe("");
    expect(stripXmlIllegalChars("clean")).toBe("clean");
  });
});

describe("firstXmlIllegalChar (the checker the other tests lean on)", () => {
  it("names the first character XML cannot hold, and is silent about clean text", () => {
    expect(firstXmlIllegalChar("a\u000cb")).toBe("U+000C");
    expect(firstXmlIllegalChar("ok\u0000\u0001")).toBe("U+0000");
    expect(firstXmlIllegalChar("a\ud800b")).toBe("U+D800");
    expect(firstXmlIllegalChar(`a${NOT_CHARACTERS}`)).toBe("U+FFFE");
    expect(firstXmlIllegalChar(`tab\there\r\nand ${EMOJI}`)).toBeNull();
    expect(firstXmlIllegalChar("")).toBeNull();
  });

  it("agrees with isXmlChar on the boundaries", () => {
    for (const [codePoint, allowed] of [
      [0x8, false],
      [0x9, true],
      [0xb, false],
      [0xd, true],
      [0x1f, false],
      [0x20, true],
      [0xd7ff, true],
      [0xd800, false],
      [0xe000, true],
      [0xfffd, true],
      [0xfffe, false],
      [0x10000, true],
      [0x10ffff, true],
    ] as const) {
      expect(isXmlChar(codePoint), `U+${codePoint.toString(16)}`).toBe(allowed);
    }
  });
});
