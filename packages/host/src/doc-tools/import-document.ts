/**
 * `import_document`: a stored Word, Excel or PDF file read into the editable model, then saved again as an
 * editable artifact of the same format.
 *
 * The file is read through the artifact store, so the visibility rule applies (another person's file is
 * "not found"). The bytes are read by the document importers, which run the local converter and never
 * the network, and a scan or a broken file is refused by name. The imported spec is saved sealed in the
 * new artifact's metadata, the same as a created file, so `revise_document` can change one section of it.
 *
 * The file itself is rendered again from the model: a re-saved copy keeps the text, headings, tables and
 * sheets the importer read, not the original file's exact styling.
 */
import { DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import type { TenantContext } from "@agentforge/core";
import { artifactStore } from "../artifacts";
import {
  DocModelError,
  docSpecFromDocx,
  docSpecFromPdf,
  renderDocx,
  renderPdf,
  renderXlsx,
  sheetSpecFromXlsx,
  type DocSpec,
  type SheetSpec,
} from "../doc-model";
import { FileExtractError } from "../file-extract";
import { log } from "../log";
import { specMeta } from "./doc-meta";
import { refuse, saveRenderedArtifact, type DocImportResult } from "./doc-save";

export type ImportDocumentInput = { readonly artifactId: string };

const NOT_FOUND_MESSAGE = "No file with that id is visible to you. Check the id, or ask the owner which file it is.";
const UNSUPPORTED_MESSAGE = "Only Word (docx), Excel (xlsx) and PDF files can be imported. This file is another type.";

type Imported =
  | { readonly kind: "document"; readonly spec: DocSpec; readonly format: "docx" | "pdf" }
  | { readonly kind: "workbook"; readonly spec: SheetSpec; readonly format: "xlsx" };

function formatOf(mime: string): Imported["format"] | null {
  if (mime === DOCX_MIME) {
    return "docx";
  }
  if (mime === PDF_MIME) {
    return "pdf";
  }
  if (mime === XLSX_MIME) {
    return "xlsx";
  }
  return null;
}

/** Read the stored bytes with the importer for their type. A broken or scanned file throws. */
async function readStored(format: Imported["format"], bytes: Uint8Array): Promise<Imported> {
  if (format === "xlsx") {
    return { kind: "workbook", format, spec: await sheetSpecFromXlsx(bytes) };
  }
  const spec = format === "pdf" ? await docSpecFromPdf(bytes) : await docSpecFromDocx(bytes);
  return { kind: "document", format, spec };
}

async function renderImported(imported: Imported): Promise<Uint8Array> {
  if (imported.kind === "workbook") {
    return renderXlsx(imported.spec);
  }
  return imported.format === "pdf" ? renderPdf(imported.spec) : renderDocx(imported.spec);
}

function partsOf(imported: Imported): Array<{ id: string; heading: string }> {
  if (imported.kind === "workbook") {
    return imported.spec.sheets.map((sheet) => ({ id: sheet.id, heading: sheet.name }));
  }
  return imported.spec.sections.map((section) => ({ id: section.id, heading: section.heading ?? "" }));
}

function mimeFor(format: Imported["format"]): ArtifactMime {
  if (format === "xlsx") {
    return XLSX_MIME;
  }
  return format === "pdf" ? PDF_MIME : DOCX_MIME;
}

/** Import the stored file and save it again as an editable artifact. */
export async function importDocumentForTenant(
  input: ImportDocumentInput,
  tenant: TenantContext,
): Promise<DocImportResult> {
  const record = artifactStore().get(tenant, input.artifactId);
  if (!record) {
    return refuse("not_found", NOT_FOUND_MESSAGE);
  }
  const format = formatOf(record.mime);
  if (format === null) {
    return refuse("unsupported", UNSUPPORTED_MESSAGE);
  }
  let imported: Imported;
  try {
    imported = await readStored(format, new Uint8Array(Buffer.from(record.body, "base64")));
  } catch (error) {
    return refuse("unreadable", readFailureMessage(error));
  }
  let bytes: Uint8Array;
  try {
    bytes = await renderImported(imported);
  } catch (error) {
    log.warn("doc_tool_render_failed", { format, detail: error instanceof Error ? error.name : "error" });
    return refuse("unavailable", "The file could not be imported right now. Tell the owner, and do not retry.");
  }
  const title = `${record.title} (imported)`;
  const saved = await saveRenderedArtifact(tenant, {
    mode: record.mode,
    kind: record.kind,
    title,
    mime: mimeFor(format),
    bytes,
    meta: specMeta(imported.spec, record.id),
  });
  if (!saved.ok) {
    return saved;
  }
  const parts = partsOf(imported);
  const noun = imported.kind === "workbook" ? "sheet" : "section";
  return {
    ok: true,
    artifactId: saved.artifactId,
    title,
    format,
    parts,
    summary: `Imported ${parts.length} ${parts.length === 1 ? noun : `${noun}s`}. Revise one with its id.`,
  };
}

/** The model-facing reason a file would not read. Converter failures keep their own fixed sentence. */
function readFailureMessage(error: unknown): string {
  if (error instanceof FileExtractError) {
    return `The file could not be read (${error.code}). ${error.message}`;
  }
  if (error instanceof DocModelError) {
    return `The file could not be read as a document: ${error.message}`;
  }
  return "The file could not be read. It may be damaged or not the type its name says.";
}
