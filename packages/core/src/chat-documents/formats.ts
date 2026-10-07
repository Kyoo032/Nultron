/**
 * Which documents the Chat composer takes, and which reader each extension belongs to.
 *
 * One table, read by both sides: the renderer builds the file input's `accept` list and the
 * "is this a document" check from it, and the host's local reader (`file-extract/detect.ts`) names a
 * file's format from the same table when the native converter is not there. Nothing here is
 * host-specific, so the renderer can import it without reaching into the host.
 *
 * `.csv` is on the table because the reader converts it, but Chat keeps sending a CSV as plain text
 * the way it always has, so it is not a Chat *document* (see {@link CHAT_DOCUMENT_EXTENSIONS}).
 */

/** The format names the local reader works in. */
export type DocumentFormat =
  | "doc"
  | "docx"
  | "odt"
  | "pdf"
  | "ppt"
  | "pptx"
  | "rtf"
  | "epub"
  | "xlsx"
  | "ods"
  | "odp"
  | "csv";

/**
 * Extension (lower case, no dot) to the format the reader uses. A legacy `.xls` and a macro-enabled
 * `.xlsm` are read as workbooks.
 */
export const DOCUMENT_FORMAT_BY_EXTENSION = {
  csv: "csv",
  doc: "doc",
  docx: "docx",
  epub: "epub",
  odp: "odp",
  ods: "ods",
  odt: "odt",
  pdf: "pdf",
  ppt: "ppt",
  pptx: "pptx",
  rtf: "rtf",
  xls: "xlsx",
  xlsm: "xlsx",
  xlsx: "xlsx",
} as const satisfies Readonly<Record<string, DocumentFormat>>;

type KnownExtension = keyof typeof DOCUMENT_FORMAT_BY_EXTENSION;

/** Extensions Chat reads as documents: everything the reader converts except `.csv`. */
export const CHAT_DOCUMENT_EXTENSIONS: ReadonlyArray<Exclude<KnownExtension, "csv">> = (
  Object.keys(DOCUMENT_FORMAT_BY_EXTENSION) as KnownExtension[]
).filter((extension): extension is Exclude<KnownExtension, "csv"> => extension !== "csv");

/** The `accept` list for a file input: the dotted extensions, nothing the reader cannot open. */
export const CHAT_DOCUMENT_ACCEPT: string = CHAT_DOCUMENT_EXTENSIONS.map((extension) => `.${extension}`).join(",");

/** The lower-case extension of a file name, without the dot. Empty when there is none. */
export function documentExtension(filename: string): string {
  const base = filename.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** True when the name's extension is a document Chat reads. A name is a claim; the host checks the bytes. */
export function isChatDocumentName(filename: string): boolean {
  return (CHAT_DOCUMENT_EXTENSIONS as ReadonlyArray<string>).includes(documentExtension(filename));
}
