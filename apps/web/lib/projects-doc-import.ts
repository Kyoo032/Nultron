import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import { docPagePath } from "@/components/doc-page/doc-format";
import { DocsError } from "@/lib/docs-client";
import type { ProjectFile } from "@/lib/projects-client";
import { fileKind } from "@/lib/projects-view";

export type ProjectFileWithEditable = ProjectFile & { readonly editable?: boolean };

const IMPORTABLE_MIMES: ReadonlySet<string> = new Set([DOCX_MIME, XLSX_MIME, PDF_MIME]);
const ALREADY_EDITABLE_CODE = "already_editable";

export function canImportAsDocument(file: ProjectFileWithEditable): boolean {
  return file.kind === "artifact" && IMPORTABLE_MIMES.has(file.mime) && file.editable === false;
}

export function opensInDocPage(file: ProjectFile): boolean {
  const kind = fileKind(file.mime);
  return file.kind === "artifact" && file.editable === true && (kind === "document" || kind === "sheet");
}

export type ImportMessageKey =
  | "projects.files.importFailed"
  | "projects.files.importTooLarge"
  | "projects.files.importNotEditable"
  | "projects.files.importAlreadyEditable"
  | "projects.files.importUnavailable"
  | "projects.files.importNotFound";

const MESSAGE_BY_STATUS: Partial<Record<number, ImportMessageKey>> = {
  404: "projects.files.importNotFound",
  409: "projects.files.importNotEditable",
  413: "projects.files.importTooLarge",
  503: "projects.files.importUnavailable",
};

export function importMessageKey(error: unknown): ImportMessageKey {
  if (error instanceof DocsError) {
    if (error.code === ALREADY_EDITABLE_CODE) {
      return "projects.files.importAlreadyEditable";
    }
    return MESSAGE_BY_STATUS[error.status] ?? "projects.files.importFailed";
  }
  return "projects.files.importFailed";
}

export type ImportOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly messageKey: ImportMessageKey };

export type ImportDeps = {
  readonly importDoc: (artifactId: string) => Promise<string>;
  readonly navigate: (path: string) => void;
};

export async function importAsDocument(fileId: string, workspaceId: string, deps: ImportDeps): Promise<ImportOutcome> {
  let newId: string;
  try {
    newId = await deps.importDoc(fileId);
  } catch (error) {
    return { ok: false, messageKey: importMessageKey(error) };
  }
  const path = docPagePath(newId, workspaceId);
  deps.navigate(path);
  return { ok: true, path };
}
