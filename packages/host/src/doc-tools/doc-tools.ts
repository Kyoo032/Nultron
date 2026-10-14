/**
 * The four chat tools for Word, Excel and PDF files: create, create a workbook, revise one part, and
 * import a stored file. PowerPoint stays `build_deck`.
 *
 * `internal` trust, like `build_deck`: the answer is the host's own (an id, a title, a part list, or a
 * refusal written here), so it is not scanned as untrusted output.
 */
import { defineTool, registerTool } from "@agentforge/core";
import { createDocumentForTenant, createWorkbookForTenant } from "./create-document";
import { importDocumentForTenant } from "./import-document";
import { reviseDocumentForTenant } from "./revise-document";
import {
  createDocumentSchema,
  createWorkbookSchema,
  importDocumentSchema,
  reviseDocumentSchema,
} from "./doc-tool-schemas";

const CREATE_DOCUMENT_DESCRIPTION = [
  "Make a Word (docx) or PDF file from a document spec you write, and save it for the owner.",
  "The spec has a title and sections; each section has an id (letters, digits, '-' or '_'), an optional heading, and blocks (paragraph, bullets, numbered, quote, pageBreak, or table with columns and rows).",
  "Write the whole document in the language of the conversation. Use only facts the owner gave you or that you looked up, and leave a figure out rather than guessing one.",
  "If the answer is a refusal, fix exactly what it names and call create_document again with the whole spec.",
  "When it answers ok, tell the owner the file is ready, its title, and the sections it has. Keep the returned artifactId: revise_document needs it to change one section later.",
].join(" ");

const CREATE_WORKBOOK_DESCRIPTION = [
  "Make an Excel (xlsx) workbook from a sheet spec you write, and save it for the owner.",
  "Each sheet has an id, a name, columns (key, header, and type: text, number, currency, percent or date), and rows (an object per row, keyed by column key).",
  "Put numbers in number-type columns, never in text. Use only figures the owner gave you or that you computed; leave a figure out rather than guessing one.",
  "If the answer is a refusal, fix exactly what it names and call create_workbook again with the whole spec.",
  "When it answers ok, tell the owner the workbook is ready and what its sheets hold. Keep the artifactId for later revisions.",
].join(" ");

const REVISE_DOCUMENT_DESCRIPTION = [
  "Change one part of a file you or the owner made, and save the result as a NEW file. The original is kept as it was.",
  "For a document, give sectionId and section (its new content: an optional heading and its blocks). For a workbook, give sheetId and sheet (a name, columns and rows).",
  "A theme restyles the whole file. A format of docx or pdf saves a document in that type.",
  "Only the part you name changes; everything else in the file stays the same. Give only what changes.",
  "When it answers ok, tell the owner the new file is ready and that the original is unchanged. Use the new artifactId for any further revision.",
].join(" ");

const IMPORT_DOCUMENT_DESCRIPTION = [
  "Read a stored Word, Excel or PDF file into an editable copy, and save that copy for the owner.",
  "It answers the new artifactId and the parts it found: section ids with headings for a document, sheet ids with names for a workbook.",
  "Use those ids with revise_document to change one part. The copy is rebuilt from the text and structure that were read, so its styling may differ from the original.",
  "If the answer is a refusal, tell the owner which file type or problem it names.",
].join(" ");

export const createDocumentTool = defineTool({
  key: "create_document",
  name: "Create a document",
  description: CREATE_DOCUMENT_DESCRIPTION,
  schema: createDocumentSchema,
  trust: "internal",
  execute: (args, tenant) => createDocumentForTenant(args, tenant),
});

export const createWorkbookTool = defineTool({
  key: "create_workbook",
  name: "Create a workbook",
  description: CREATE_WORKBOOK_DESCRIPTION,
  schema: createWorkbookSchema,
  trust: "internal",
  execute: (args, tenant) => createWorkbookForTenant(args, tenant),
});

export const reviseDocumentTool = defineTool({
  key: "revise_document",
  name: "Revise a document",
  description: REVISE_DOCUMENT_DESCRIPTION,
  schema: reviseDocumentSchema,
  trust: "internal",
  execute: (args, tenant) => reviseDocumentForTenant(args, tenant),
});

export const importDocumentTool = defineTool({
  key: "import_document",
  name: "Import a document",
  description: IMPORT_DOCUMENT_DESCRIPTION,
  schema: importDocumentSchema,
  trust: "internal",
  execute: (args, tenant) => importDocumentForTenant(args, tenant),
});

export const DOC_TOOLS = [createDocumentTool, createWorkbookTool, reviseDocumentTool, importDocumentTool] as const;

/** Registered next to the deck tools by `ensureToolsRegistered`. */
export function registerDocTools(): void {
  for (const tool of DOC_TOOLS) {
    registerTool(tool);
  }
}
