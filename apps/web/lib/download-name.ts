/**
 * The file name a download response asks for, read from its `Content-Disposition` header.
 *
 * The host sends two forms when a name has anything outside ASCII (`packages/host/src/content-disposition.ts`):
 * a quoted `filename` with `_` standing in for what a header cannot carry, and an RFC 5987
 * `filename*=UTF-8''...` with the real name percent-encoded. Browsers prefer the second, so this does
 * too. Null when the header has no name or one that cannot be decoded: the caller then names the file
 * itself.
 */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended.trim());
      if (decoded) {
        return decoded;
      }
    } catch {
      // A bad escape falls through to the plain form below.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  if (quoted?.trim()) {
    return quoted.trim();
  }
  const bare = /filename\s*=\s*([^\s;]+)/i.exec(header)?.[1];
  return bare ?? null;
}

/** The last part of a slash-separated path: what a saved copy of that file is called. */
export function leafName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || "file";
}
