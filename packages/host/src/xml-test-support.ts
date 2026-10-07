/**
 * What the tests that guard XML output ask: is there a character in this text that XML 1.0 cannot hold?
 *
 * A regular expression over the control range is the obvious way to ask, and the linter forbids control
 * characters in a regex for good reason, so this walks the text by code point instead. The ranges are
 * the "Char" production of XML 1.0, spelled with numbers so nothing rewrites a boundary into a raw byte.
 */
export function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** The first character of `text` XML 1.0 cannot hold, as `U+000C`, or null when every one is fine. */
export function firstXmlIllegalChar(text: string): string | null {
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isXmlChar(codePoint)) {
      return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return null;
}

/**
 * The same question asked of every string inside a value (an outline, a slide). Not of its JSON text:
 * `JSON.stringify` writes a control character as the six characters `\u0000`, which no check of the
 * text would ever catch.
 */
export function firstXmlIllegalCharIn(value: unknown): string | null {
  if (typeof value === "string") {
    return firstXmlIllegalChar(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstXmlIllegalCharIn(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    return firstXmlIllegalCharIn(Object.values(value));
  }
  return null;
}
