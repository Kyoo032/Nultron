export const MAX_READ_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lines as a person counts them: a final line break does not start another line. */
export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** UTF-8 size without allocating the encoded copy. A lone surrogate counts 3, as `TextEncoder` writes U+FFFD. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Cut to at most `max` UTF-16 units without leaving half a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const lastUnit = text.charCodeAt(max - 1);
  const end = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}
