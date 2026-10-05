const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

/**
 * The type recorded for a path, from its extension alone. A label for the file list: the body is
 * only ever returned inside a JSON answer, never served under this type, so an `html` file is data
 * here and nothing a browser renders. Anything unknown is plain text.
 */
export function mimeForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "text/plain";
  }
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text/plain";
}
