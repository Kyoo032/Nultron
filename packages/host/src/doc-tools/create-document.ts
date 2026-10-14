/**
 * `create_document` and `create_workbook`, without the model: a spec the model wrote in, a saved file out.
 *
 * The model writes the spec in chat; this runs the host's half only. It validates the spec with the
 * document model's own parser (`parseDocSpec` / `parseSheetSpec`, which hold every cap in `limits.ts`),
 * renders it with the matching renderer, and stores the bytes as an artifact. The validated spec is kept
 * sealed in the artifact's metadata so `revise_document` can change one part later.
 *
 * A refusal is a value. A model error (a bad format, a spec over a cap, a cell of the wrong type) names
 * the field so the model can fix it and call again; the per-turn budget keeps that bounded.
 */
import { DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime, artifactFilename } from "@agentforge/core/artifacts";
import { DocModelError, parseDocSpec, parseSheetSpec, renderDocx, renderPdf, renderXlsx } from "../doc-model";
import { log } from "../log";
import { specMeta } from "./doc-meta";
import { refuse, saveRenderedArtifact, type DocToolResult } from "./doc-save";
import type { TenantContext } from "@agentforge/core";

export type CreateDocumentInput = {
  readonly format: string;
  readonly spec: Record<string, unknown>;
  readonly theme?: string;
};

export type CreateWorkbookInput = {
  readonly spec: Record<string, unknown>;
  readonly theme?: string;
};

const DOCUMENT_MIME_BY_FORMAT: Readonly<Record<string, ArtifactMime>> = { docx: DOCX_MIME, pdf: PDF_MIME };
const FORMAT_LABEL: Readonly<Record<string, string>> = { docx: "Word document", pdf: "PDF", xlsx: "Excel workbook" };

function asDocModelError(error: unknown): string {
  return error instanceof DocModelError ? error.message : "The spec is not a valid document.";
}

/** A `docx` or `pdf` file made from a document spec. Any other format is refused by name. */
export async function createDocumentForTenant(
  input: CreateDocumentInput,
  tenant: TenantContext,
): Promise<DocToolResult> {
  const mime = DOCUMENT_MIME_BY_FORMAT[input.format];
  if (mime === undefined) {
    return refuse(
      "bad_format",
      "format must be docx or pdf: docx is a Word file, pdf is a PDF. Call create_document again with one of those.",
    );
  }
  let spec: ReturnType<typeof parseDocSpec>;
  try {
    spec = parseDocSpec({ ...input.spec, kind: "document", theme: input.theme ?? input.spec.theme ?? "plain" });
  } catch (error) {
    return refuse("invalid", asDocModelError(error));
  }
  let bytes: Uint8Array;
  try {
    bytes = input.format === "pdf" ? await renderPdf(spec) : await renderDocx(spec);
  } catch (error) {
    log.warn("doc_tool_render_failed", { format: input.format, detail: error instanceof Error ? error.name : "error" });
    return refuse("unavailable", "The file could not be made right now. Tell the owner, and do not retry.");
  }
  const saved = await saveRenderedArtifact(tenant, {
    mode: "documents",
    kind: "draft",
    title: spec.title,
    mime,
    bytes,
    meta: specMeta(spec),
  });
  if (!saved.ok) {
    return saved;
  }
  const count = spec.sections.length;
  return {
    ok: true,
    artifactId: saved.artifactId,
    title: spec.title,
    format: input.format,
    filename: artifactFilename(spec.title, mime),
    summary: `${FORMAT_LABEL[input.format]} with ${count} ${count === 1 ? "section" : "sections"}.`,
  };
}

/** An `xlsx` workbook made from a sheet spec. */
export async function createWorkbookForTenant(
  input: CreateWorkbookInput,
  tenant: TenantContext,
): Promise<DocToolResult> {
  let book: ReturnType<typeof parseSheetSpec>;
  try {
    book = parseSheetSpec({ ...input.spec, kind: "workbook", theme: input.theme ?? input.spec.theme ?? "plain" });
  } catch (error) {
    return refuse("invalid", asDocModelError(error));
  }
  let bytes: Uint8Array;
  try {
    bytes = await renderXlsx(book);
  } catch (error) {
    log.warn("doc_tool_render_failed", { format: "xlsx", detail: error instanceof Error ? error.name : "error" });
    return refuse("unavailable", "The workbook could not be made right now. Tell the owner, and do not retry.");
  }
  const saved = await saveRenderedArtifact(tenant, {
    mode: "documents",
    kind: "draft",
    title: book.title,
    mime: XLSX_MIME,
    bytes,
    meta: specMeta(book),
  });
  if (!saved.ok) {
    return saved;
  }
  const count = book.sheets.length;
  return {
    ok: true,
    artifactId: saved.artifactId,
    title: book.title,
    format: "xlsx",
    filename: artifactFilename(book.title, XLSX_MIME),
    summary: `${FORMAT_LABEL.xlsx} with ${count} ${count === 1 ? "sheet" : "sheets"}.`,
  };
}
