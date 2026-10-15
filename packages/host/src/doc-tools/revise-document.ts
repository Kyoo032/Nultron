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
import { agentForProposal } from "../doc-versions/proposal-agent";
import { findMemberProject, findVisibleFile } from "../projects/store";
import { log } from "../log";
import { currentToolRun, type ToolRun } from "../tool-run-context";
import { readEditableSpec, specMeta, type EditableSpec } from "./doc-meta";
import { QUOTA_MESSAGE, refuse, saveRenderedArtifact, type DocRefusal, type DocToolResult } from "./doc-save";

export type ReviseDocumentInput = {
  readonly artifactId: string;
  readonly sectionId?: string;
  readonly section?: Record<string, unknown>;
  readonly sheetId?: string;
  readonly sheet?: Record<string, unknown>;
  readonly theme?: string;
  readonly format?: string;
  readonly baseVersion?: number;
};

export type PendingRevision = {
  readonly ok: true;
  readonly pending: true;
  readonly artifactId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly sectionId: string;
  readonly baseVersion: number;
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
const AGENT_NOT_IN_WORKSPACE_MESSAGE =
  "The agent you are chatting with is not in this Workspace, so it cannot change this file. Tell the owner that a member can bring this agent into the Workspace, and do not call this again for this file with this agent.";
const STALE_SECTION_MESSAGE =
  "This section changed after the version this change was based on, so nothing was changed. Tell the owner that the section changed, and ask them to repeat the request. Do not call this again with the same change.";
const BAD_BASE_MESSAGE =
  "baseVersion must be a version of this file, from 1 up to its latest. Leave baseVersion out and call again.";
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

function liveWorkspaceProjectId(tenant: TenantContext, artifactId: string): string | null {
  if (!isServerMode()) {
    return null;
  }
  const projectId = findVisibleFile(tenant, artifactId)?.project_id ?? null;
  if (projectId === null) {
    return null;
  }
  const project = findMemberProject(tenant, projectId);
  return project !== null && project.archived_at === null ? projectId : null;
}

const PINNED_RUNS_CAP = 1000;
const runPinnedVersions = new Map<string, Map<string, number>>();

function pinsOfRun(runId: string): Map<string, number> {
  const existing = runPinnedVersions.get(runId);
  if (existing !== undefined) {
    return existing;
  }
  if (runPinnedVersions.size >= PINNED_RUNS_CAP) {
    const oldest = runPinnedVersions.keys().next().value;
    if (oldest !== undefined) {
      runPinnedVersions.delete(oldest);
    }
  }
  const created = new Map<string, number>();
  runPinnedVersions.set(runId, created);
  return created;
}

function pinnedVersionOf(run: ToolRun | undefined, artifactId: string, head: number): number {
  if (run === undefined) {
    return head;
  }
  const pins = pinsOfRun(run.runId);
  const pinned = pins.get(artifactId);
  if (pinned !== undefined) {
    return pinned;
  }
  pins.set(artifactId, head);
  return head;
}

function baseVersionFor(requested: number | undefined, pinned: number, head: number): number | null {
  if (requested === undefined) {
    return pinned;
  }
  return Number.isInteger(requested) && requested >= 1 && requested <= head ? Math.min(requested, pinned) : null;
}

type ProposalRefusal = "not_found" | "not_editable" | "quota" | "bad_base" | "bad_section" | "section_changed";

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
      return refuse("invalid", BAD_BASE_MESSAGE);
    case "section_changed":
      return refuse("unavailable", STALE_SECTION_MESSAGE);
  }
}

function pendingSummary(sectionId: string, baseVersion: number): string {
  return `The change to section "${sectionId}", based on version ${baseVersion}, is waiting for the person to Keep it. No new file was saved, and the file is unchanged until they Keep it. Tell the owner the change is ready to keep in the Workspace. Use the same artifactId for any further revision.`;
}

async function proposeSectionChange(
  input: ReviseDocumentInput,
  tenant: TenantContext,
  record: ArtifactRecord,
  projectId: string,
): Promise<ReviseDocumentResult> {
  const run = currentToolRun();
  const agent = await agentForProposal(tenant, projectId, run?.mode ?? virtualAgentFor("chat").id);
  if (agent === null) {
    return refuse("unavailable", AGENT_NOT_IN_WORKSPACE_MESSAGE);
  }
  const first = docVersionStore().ensureFirstVersion(tenant, record.id);
  if (!first.ok) {
    return proposalRefusal(first.reason);
  }
  const head = docVersionStore().getVersion(tenant, record.id, first.head.version);
  if (head === null || head.spec.kind !== "document") {
    return proposalRefusal("not_editable");
  }
  const baseVersion = baseVersionFor(
    input.baseVersion,
    pinnedVersionOf(run, record.id, first.head.version),
    first.head.version,
  );
  if (baseVersion === null) {
    return refuse("invalid", BAD_BASE_MESSAGE);
  }
  const part = sectionPart(input);
  const changedAt = docVersionStore().sectionAuthors(tenant, record.id)?.[part.id]?.version ?? 0;
  if (changedAt > baseVersion) {
    return refuse("unavailable", STALE_SECTION_MESSAGE);
  }
  const edited = reviseDocument(head.spec.spec, input);
  const section = edited.sections.find((candidate) => candidate.id === part.id);
  if (section === undefined) {
    return proposalRefusal("bad_section");
  }
  const created = proposalStore().createProposal(tenant, record.id, {
    sectionId: part.id,
    section,
    baseVersion,
    agentId: agent.id,
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
    baseVersion,
    summary: pendingSummary(part.id, baseVersion),
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
  if (isWorkspaceSectionChange(input, editable)) {
    const projectId = liveWorkspaceProjectId(tenant, record.id);
    if (projectId !== null) {
      return restylesToo(input)
        ? refuse("invalid", SECTION_WITH_RESTYLE_MESSAGE)
        : proposeSectionChange(input, tenant, record, projectId);
    }
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
