/**
 * Text that can be written into an XML part (a slide, a notes page, `docProps/core.xml`).
 *
 * XML 1.0 allows tab, line feed, carriage return and the ranges U+0020 to U+D7FF, U+E000 to U+FFFD and
 * U+10000 and up. Anything else in a part makes it not well-formed, and PowerPoint answers a file that
 * holds one with "needs repair". The PowerPoint writer escapes `& < > " '` and nothing more, so the
 * characters this removes reach the file as they came: a form feed that a PDF reader leaves at every
 * page break, a NUL, an escape code from a pasted terminal log.
 *
 * Form feed and vertical tab are whitespace, so they become a space (two words a page break separated
 * stay two words). Every other character XML refuses is removed, and so is a surrogate with no partner.
 * Text that has nothing to remove comes back as the same string.
 */
const TAB = 0x9;
const LINE_FEED = 0xa;
const VERTICAL_TAB = 0xb;
const FORM_FEED = 0xc;
const CARRIAGE_RETURN = 0xd;
const FIRST_PRINTABLE = 0x20;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;
const PRIVATE_USE_FIRST = 0xe000;
/** U+FFFE and U+FFFF are not characters: the range below ends before them. */
const LAST_ALLOWED_BMP = 0xfffd;

function isKeptUnit(unit: number): boolean {
  return (
    unit === TAB ||
    unit === LINE_FEED ||
    unit === CARRIAGE_RETURN ||
    (unit >= FIRST_PRINTABLE && unit < HIGH_SURROGATE_FIRST) ||
    (unit >= PRIVATE_USE_FIRST && unit <= LAST_ALLOWED_BMP)
  );
}

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_FIRST && unit <= LOW_SURROGATE_LAST;
}

export function stripXmlIllegalChars(text: string): string {
  let cleaned = "";
  let changed = false;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (isKeptUnit(unit)) {
      cleaned += text.charAt(index);
    } else if (unit === VERTICAL_TAB || unit === FORM_FEED) {
      cleaned += " ";
      changed = true;
    } else if (
      unit >= HIGH_SURROGATE_FIRST &&
      unit <= HIGH_SURROGATE_LAST &&
      isLowSurrogate(text.charCodeAt(index + 1))
    ) {
      cleaned += text.slice(index, index + 2);
      index += 1;
    } else {
      changed = true;
    }
  }
  return changed ? cleaned : text;
}
