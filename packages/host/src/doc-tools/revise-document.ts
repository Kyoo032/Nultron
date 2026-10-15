/**
 * `revise_document`: one part of a saved file changes, and the owner gets a new file.
 *
 * The file is loaded through the artifact store, so the visibility rule applies: another person's file
 * (or another company's) answers "not found", exactly as a missing id does. The stored spec is opened,
 * one section or sheet is replaced through the document model's own edit helpers (`replaceSection`,
 * `replaceSheet`, `restyle`), and the result is rendered and saved as a NEW artifact. The original row
 * is never touched, so a revision never loses the earlier version.
 *
 * Refusals are values, the same as the other document tools. The internal `ReviseRefusal` only carries a
 * refusal up to the one place that turns it into the model-facing answer.
 */
import {
  DOCX_MIME,
  PDF_MIME,
  XLSX_MIME,
  artifactFilename,
  type ArtifactMime,
  type ArtifactRecord,
} from "@agentforge/core/artifacts";
import { isServerMode, virtualAgentFor, type TenantContext } from "@agentforge/core";
import {
  DocModelError,
  parseDocSpec,
  parseSheetSpec,
  renderDocx,
  renderPdf,
  renderXlsx,
  replaceSection,
  replaceSheet,
  restyle,
  type DocSpec,
  type SheetSpec,
} from "../doc-model";
import { DOC_THEME_NAMES, type DocThemeName } from "../doc-model/themes";
import { artifactStore } from "../artifacts";
import { docVersionStore, proposalStore } from "../doc-versions";
import { findMemberProject, findVisibleFile } from "../projects/store";
import { log } from "../log";
import { currentToolRun } from "../tool-run-context";
import { readEditableSpec, specMeta, type EditableSpec } from "./doc-meta";
import {
  QUOTA_MESSAGE,
  UNAVAILABLE_MESSAGE,
  refuse,
  saveRenderedArtifact,
  type DocRefusal,
  type DocToolResult,
} from "./doc-save";

export type ReviseDocumentInput = {
  readonly artifactId: string;
  readonly sectionId?: string;
  readonly section?: Record<string, unknown>;
  readonly sheetId?: string;
  readonly sheet?: Record<string, unknown>;
  readonly theme?: string;
  readonly format?: string;
};

export type PendingRevision = {
  readonly ok: true;
  readonly pending: true;
  readonly artifactId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly sectionId: string;
  readonly summary: string;
};

export type ReviseDocumentResult = DocToolResult | PendingRevision;

class ReviseRefusal extends Error {
  readonly reason: DocRefusal;
  constructor(reason: DocRefusal, message: string) {
    super(message);
    this.name = "ReviseRefusal";
    this.reason = reason;
  }
}

const NOT_FOUND_MESSAGE = "No file with that id is visible to you. Check the id, or ask the owner which file it is.";
const NOT_EDITABLE_MESSAGE = "This file was not made by the document tools, so it cannot be revised here.";
const DOCUMENT_FORMATS: Readonly<Record<string, ArtifactMime>> = { docx: DOCX_MIME, pdf: PDF_MIME };

function isDocTheme(value: string): value is DocThemeName {
  return (DOC_THEME_NAMES as readonly string[]).includes(value);
}

function requestsAnyChange(input: ReviseDocumentInput): boolean {
  return (
    input.sectionId !== undefined ||
    input.section !== undefined ||
    input.sheetId !== undefined ||
    input.sheet !== undefined ||
    input.theme !== undefined ||
    input.format !== undefined
  );
}

/** One section, parsed on its own so a bad shape is named by the document model before the whole spec is touched. */
function parsedSection(spec: DocSpec, id: string, raw: Record<string, unknown>) {
  return parseDocSpec({ kind: "document", title: spec.title, theme: spec.theme, sections: [{ ...raw, id }] })
    .sections[0];
}

function parsedSheet(book: SheetSpec, id: string, raw: Record<string, unknown>) {
  return parseSheetSpec({ kind: "workbook", title: book.title, theme: book.theme, sheets: [{ ...raw, id }] }).sheets[0];
}

function sectionPart(input: ReviseDocumentInput): { readonly id: string; readonly raw: Record<string, unknown> } {
  if (input.sectionId === undefined || input.section === undefined) {
    throw new ReviseRefusal(
      "invalid",
      "sectionId and section go together: give the id of the section and its new content.",
    );
  }
  return { id: input.sectionId, raw: input.section };
}

function reviseDocument(spec: DocSpec, input: ReviseDocumentInput): DocSpec {
  if (input.sheetId !== undefined || input.sheet !== undefined) {
    throw new ReviseRefusal("invalid", "This file is a document: use sectionId and section, not sheetId and sheet.");
  }
  let next = spec;
  if (input.sectionId !== undefined || input.section !== undefined) {
    const part = sectionPart(input);
    next = replaceSection(next, part.id, parsedSection(next, part.id, part.raw));
  }
  return input.theme === undefined ? next : restyle(next, requireTheme(input.theme));
}

function reviseWorkbook(book: SheetSpec, input: ReviseDocumentInput): SheetSpec {
  if (input.sectionId !== undefined || input.section !== undefined) {
    throw new ReviseRefusal("invalid", "This file is a workbook: use sheetId and sheet, not sectionId and section.");
  }
  let next = book;
  if (input.sheetId !== undefined || input.sheet !== undefined) {
    if (input.sheetId === undefined || input.sheet === undefined) {
      throw new ReviseRefusal(
        "invalid",
        "sheetId and sheet go together: give the id of the sheet and its new content.",
      );
    }
    next = replaceSheet(next, input.sheetId, parsedSheet(next, input.sheetId, input.sheet));
  }
  return input.theme === undefined ? next : restyle(next, requireTheme(input.theme));
}

function requireTheme(value: string): DocThemeName {
  if (!isDocTheme(value)) {
    throw new ReviseRefusal("invalid", `theme must be one of ${DOC_THEME_NAMES.join(", ")}.`);
  }
  return value;
}

/** The format a revision is saved as. A document may change between docx and pdf; a workbook stays xlsx. */
function targetFormat(editable: EditableSpec, currentMime: string, requested: string | undefined): string {
  if (editable.kind === "workbook") {
    if (requested !== undefined && requested !== "xlsx") {
      throw new ReviseRefusal("bad_format", "A workbook stays an Excel file: leave format out.");
    }
    return "xlsx";
  }
  const current = currentMime === PDF_MIME ? "pdf" : "docx";
  const format = requested ?? current;
  if (DOCUMENT_FORMATS[format] === undefined) {
    throw new ReviseRefusal("bad_format", "format must be docx or pdf: docx is a Word file, pdf is a PDF.");
  }
  return format;
}

async function renderFor(format: string, editable: EditableSpec, spec: DocSpec | SheetSpec): Promise<Uint8Array> {
  if (editable.kind === "workbook") {
    return renderXlsx(spec as SheetSpec);
  }
  return format === "pdf" ? renderPdf(spec as DocSpec) : renderDocx(spec as DocSpec);
}

const SECTION_WITH_RESTYLE_MESSAGE =
  "A section change to a file in a Workspace waits for the person to Keep it, so give sectionId and section alone. Make a theme or format change in a separate call.";

function isWorkspaceSectionChange(input: ReviseDocumentInput, editable: EditableSpec): boolean {
  return (
    editable.kind === "document" &&
    (input.sectionId !== undefined || input.section !== undefined) &&
    input.sheetId === undefined &&
    input.sheet === undefined
  );
}

function restylesToo(input: ReviseDocumentInput): boolean {
  return input.theme !== undefined || input.format !== undefined;
}

function isInLiveWorkspace(tenant: TenantContext, artifactId: string): boolean {
  if (!isServerMode()) {
    return false;
  }
  const projectId = findVisibleFile(tenant, artifactId)?.project_id ?? null;
  if (projectId === null) {
    return false;
  }
  const project = findMemberProject(tenant, projectId);
  return project !== null && project.archived_at === null;
}

type ProposalRefusal = "not_found" | "not_editable" | "quota" | "bad_base" | "bad_section";

function proposalRefusal(reason: ProposalRefusal): DocToolResult {
  switch (reason) {
    case "not_found":
      return refuse("not_found", NOT_FOUND_MESSAGE);
    case "not_editable":
      return refuse("not_editable", NOT_EDITABLE_MESSAGE);
    case "quota":
      return refuse("quota", QUOTA_MESSAGE);
    case "bad_section":
      return refuse(
        "invalid",
        "That section could not be changed. Check its id and its content, then call the tool again.",
      );
    case "bad_base":
      return refuse("unavailable", UNAVAILABLE_MESSAGE);
  }
}

function pendingSummary(sectionId: string): string {
  return `The change to section "${sectionId}" is waiting for the person to Keep it. No new file was saved, and the file is unchanged until they Keep it. Tell the owner the change is ready to keep in the Workspace. Use the same artifactId for any further revision.`;
}

async function proposeSectionChange(
  input: ReviseDocumentInput,
  tenant: TenantContext,
  record: ArtifactRecord,
): Promise<ReviseDocumentResult> {
  const first = docVersionStore().ensureFirstVersion(tenant, record.id);
  if (!first.ok) {
    return proposalRefusal(first.reason);
  }
  const head = docVersionStore().getVersion(tenant, record.id, first.head.version);
  if (head === null || head.spec.kind !== "document") {
    return proposalRefusal("not_editable");
  }
  const part = sectionPart(input);
  const edited = reviseDocument(head.spec.spec, input);
  const section = edited.sections.find((candidate) => candidate.id === part.id);
  if (section === undefined) {
    return proposalRefusal("bad_section");
  }
  const created = proposalStore().createProposal(tenant, record.id, {
    sectionId: part.id,
    section,
    baseVersion: first.head.version,
    agentId: currentToolRun()?.mode ?? virtualAgentFor("chat").id,
  });
  if (!created.ok) {
    return proposalRefusal(created.reason);
  }
  return {
    ok: true,
    pending: true,
    artifactId: record.id,
    proposalId: created.proposal.id,
    title: record.title,
    sectionId: part.id,
    summary: pendingSummary(part.id),
  };
}

/** Apply the revision and save the new file. Each refusal is a value; nothing is written before it passes. */
async function reviseOnce(input: ReviseDocumentInput, tenant: TenantContext): Promise<ReviseDocumentResult> {
  const record = artifactStore().get(tenant, input.artifactId);
  if (!record) {
    return refuse("not_found", NOT_FOUND_MESSAGE);
  }
  const editable = readEditableSpec(record);
  if (editable === null) {
    return refuse("not_editable", NOT_EDITABLE_MESSAGE);
  }
  if (!requestsAnyChange(input)) {
    return refuse(
      "nothing_to_change",
      "Nothing to change: give a sectionId and section, a sheetId and sheet, a theme, or a format.",
    );
  }
  if (isWorkspaceSectionChange(input, editable) && isInLiveWorkspace(tenant, record.id)) {
    return restylesToo(input)
      ? refuse("invalid", SECTION_WITH_RESTYLE_MESSAGE)
      : proposeSectionChange(input, tenant, record);
  }
  const format = targetFormat(editable, record.mime, input.format);
  const mime = format === "xlsx" ? XLSX_MIME : DOCUMENT_FORMATS[format];
  const spec =
    editable.kind === "workbook" ? reviseWorkbook(editable.spec, input) : reviseDocument(editable.spec, input);
  let bytes: Uint8Array;
  try {
    bytes = await renderFor(format, editable, spec);
  } catch (error) {
    log.warn("doc_tool_render_failed", { format, detail: error instanceof Error ? error.name : "error" });
    return refuse("unavailable", "The revised file could not be made right now. Tell the owner, and do not retry.");
  }
  const title = `${record.title} (revised)`;
  const saved = await saveRenderedArtifact(tenant, {
    mode: record.mode,
    kind: record.kind,
    title,
    mime,
    bytes,
    meta: specMeta(spec, record.id),
  });
  if (!saved.ok) {
    return saved;
  }
  return {
    ok: true,
    artifactId: saved.artifactId,
    title,
    format,
    filename: artifactFilename(title, mime),
    summary: `Saved a revised copy as ${format}. The original file is unchanged.`,
  };
}

export async function reviseDocumentForTenant(
  input: ReviseDocumentInput,
  tenant: TenantContext,
): Promise<ReviseDocumentResult> {
  try {
    return await reviseOnce(input, tenant);
  } catch (error) {
    if (error instanceof ReviseRefusal) {
      return refuse(error.reason, error.message);
    }
    if (error instanceof DocModelError) {
      return refuse("invalid", error.message);
    }
    throw error;
  }
}
