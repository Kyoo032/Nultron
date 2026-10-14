/**
 * Text for the PDF renderer: characters the standard Helvetica fonts can draw (WinAnsi), word wrapping
 * across styled runs, and a safe stand-in for everything else.
 *
 * The standard fonts cannot embed Chinese, emoji or most symbols. A character they cannot draw is
 * first decomposed and its accents dropped ("é" to "e"), and failing that becomes "?". Characters are
 * walked by code point, so an emoji (two UTF-16 units) is one character, not two broken halves.
 */
import type { PDFFont } from "pdf-lib";

export type Segment = { readonly text: string; readonly font: PDFFont };
export type LinePiece = { readonly text: string; readonly font: PDFFont };
export type Line = readonly LinePiece[];

const FALLBACK = "?";
const COMBINING_MARKS = /\p{M}/gu;

function drawable(char: string, font: PDFFont): boolean {
  try {
    font.encodeText(char);
    return true;
  } catch {
    return false;
  }
}

/** Keeps a character as it is when the font draws it, otherwise a plain ASCII stand-in. */
export function printable(char: string, font: PDFFont): string {
  if (char === "\t") {
    return " ";
  }
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) {
    return "";
  }
  if (drawable(char, font)) {
    return char;
  }
  const plain = char.normalize("NFKD").replace(COMBINING_MARKS, "");
  const usable = plain !== "" && Array.from(plain).every((part) => drawable(part, font));
  return usable ? plain : FALLBACK;
}

/** A whole string made drawable, one code point at a time. Line breaks are kept for the wrapper. */
export function toDrawable(text: string, font: PDFFont): string {
  return Array.from(text)
    .map((char) => (char === "\n" ? "\n" : printable(char, font)))
    .join("");
}

/** Collects pieces into lines and breaks a line when the next piece would overflow it. */
class LineBuilder {
  readonly lines: LinePiece[][] = [];
  private current: LinePiece[] = [];
  private used = 0;

  constructor(private readonly width: number) {}

  /** Adds a piece. Spaces never start a line; a word that does not fit moves to the next line. */
  add(piece: LinePiece, size: number): void {
    const measured = piece.font.widthOfTextAtSize(piece.text, size);
    const isSpace = piece.text.trim() === "";
    if (isSpace && this.current.length === 0) {
      return;
    }
    if (!isSpace && this.current.length > 0 && this.used + measured > this.width) {
      this.breakLine();
    }
    this.current.push(piece);
    this.used += measured;
  }

  /** A word wider than the column is split by character, so no text runs past the page edge. */
  addWord(word: string, font: PDFFont, size: number): void {
    if (font.widthOfTextAtSize(word, size) <= this.width) {
      this.add({ text: word, font }, size);
      return;
    }
    for (const char of Array.from(word)) {
      const measured = font.widthOfTextAtSize(char, size);
      if (this.used + measured > this.width && this.current.length > 0) {
        this.breakLine();
      }
      this.current.push({ text: char, font });
      this.used += measured;
    }
  }

  breakLine(): void {
    while (this.current.length > 0 && this.current[this.current.length - 1].text.trim() === "") {
      this.current.pop();
    }
    this.lines.push(this.current);
    this.current = [];
    this.used = 0;
  }

  finish(): Line[] {
    this.breakLine();
    return this.lines;
  }
}

/** Greedy word wrap across runs in different fonts. Hard line breaks are honoured. */
export function wrapSegments(segments: readonly Segment[], width: number, size: number): Line[] {
  const builder = new LineBuilder(width);
  for (const segment of segments) {
    toDrawable(segment.text, segment.font)
      .split("\n")
      .forEach((part, partIndex) => {
        if (partIndex > 0) {
          builder.breakLine();
        }
        for (const token of part.split(/( +)/)) {
          if (token === "") {
            continue;
          }
          if (token.trim() === "") {
            builder.add({ text: token, font: segment.font }, size);
          } else {
            builder.addWord(token, segment.font, size);
          }
        }
      });
  }
  const lines = builder.finish();
  return lines.length > 0 ? lines : [[]];
}
