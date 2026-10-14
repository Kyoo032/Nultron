/**
 * Reading the four document tools' results for the Chat card. Pure data in, plain data out, like
 * `deck-result.ts`: the card is rebuilt from the saved call alone, so a thread opened tomorrow draws the
 * same card.
 *
 * The answers are the host's own (`packages/host/src/doc-tools/doc-save.ts`):
 * - `create_document` and `create_workbook` answer `{ ok, artifactId, title, format, filename, summary }`;
 * - `revise_document` answers the same, for the revised copy, and the original is left as it was;
 * - `import_document` answers `{ ok, artifactId, title, format, parts, summary }` and names no file;
 * - a refusal is `{ ok: false, reason, message }` and shows no card.
 * `summary` is English host text, so the card does not show it. The part count comes from the call's own
 * input (the sections of a new document, the sheets of a new workbook) or from the parts an import found.
 * A revision's input is only the part it changes, so a revision shows no count.
 */
import { artifactFilename, DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import { asRecord, readList, readString, type Rec } from "./results";

export const DOC_TOOL_KEYS = ["create_document", "create_workbook", "revise_document", "import_document"] as const;

export type DocToolKey = (typeof DOC_TOOL_KEYS)[number];
export type DocFormat = "docx" | "pdf" | "xlsx";

const MIME_BY_FORMAT: Readonly<Record<DocFormat, ArtifactMime>> = {
  docx: DOCX_MIME,
  pdf: PDF_MIME,
  xlsx: XLSX_MIME,
};

export function isDocTool(key: string): key is DocToolKey {
  return (DOC_TOOL_KEYS as readonly string[]).includes(key);
}

export type DocCardModel = {
  readonly artifactId: string;
  readonly format: DocFormat;
  readonly title: string;
  /** The name the save dialog offers: the host's own when it sent one, else the name it would give. */
  readonly filename: string;
  /** True for a revised copy, which says the original is unchanged. */
  readonly revised: boolean;
  /** Sections of a document or sheets of a workbook, when the call says how many there are. */
  readonly parts: { readonly kind: "section" | "sheet"; readonly count: number } | null;
};

function readFormat(value: unknown): DocFormat | null {
  return value === "docx" || value === "pdf" || value === "xlsx" ? value : null;
}

/** How many entries a list holds, or null when the field is not a list at all. */
function listLength(record: Rec | null, key: string): number | null {
  const list = readList(record, key);
  return list ? list.length : null;
}

function partCount(toolKey: DocToolKey, input: Rec | null, result: Rec): number | null {
  if (toolKey === "create_document") {
    return listLength(asRecord(input?.spec), "sections");
  }
  if (toolKey === "create_workbook") {
    return listLength(asRecord(input?.spec), "sheets");
  }
  if (toolKey === "import_document") {
    return listLength(result, "parts");
  }
  return null;
}

/** The card for one finished document call, or null when it made no file (a refusal, or an answer that is not one). */
export function readDocResult(toolKey: string, input: unknown, output: unknown): DocCardModel | null {
  const result = asRecord(output);
  if (!isDocTool(toolKey) || result?.ok !== true) {
    return null;
  }
  const artifactId = readString(result, "artifactId");
  const format = readFormat(result.format);
  const title = readString(result, "title")?.trim();
  if (!artifactId || !format || !title) {
    return null;
  }
  const count = partCount(toolKey, asRecord(input), result);
  return {
    artifactId,
    format,
    title,
    filename: readString(result, "filename") ?? artifactFilename(title, MIME_BY_FORMAT[format]),
    revised: toolKey === "revise_document",
    parts: count === null ? null : { kind: format === "xlsx" ? "sheet" : "section", count },
  };
}
