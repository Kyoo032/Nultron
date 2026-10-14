/**
 * What the model hands the four document tools. Like `deck-schema.ts`, this sets the SHAPE only and no
 * ceiling: the SDK checks a tool call against the schema before `execute`, and an argument that fails there
 * ends the whole turn, which the model never sees explained. Every cap (sections, blocks, sheets, rows,
 * text bytes, cell types, theme names) is enforced by the document model's parsers, and the refusal names
 * the field and the limit, so the model can fix it and call again.
 *
 * The field descriptions are what the model reads, so they say what each part is and what it must hold.
 */
import { z } from "zod";

const SECTION_ID = z
  .string()
  .describe(
    "A short id for this section, letters digits '-' or '_' only, e.g. intro or budget. Stable: use it to revise this section later.",
  );

const blockSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'One block. type is one of: "paragraph" (text), "bullets" (items), "numbered" (items), "quote" (text), "pageBreak" (no fields), "table" (columns: string[], rows: cell arrays). Items and cells are plain text or numbers.',
  );

const sectionSchema = z.object({
  id: SECTION_ID,
  heading: z.string().optional().describe("The section's heading, shown above its blocks."),
  blocks: z.array(blockSchema).describe("The section's blocks, in the order they are read."),
});

/** A document spec as the model writes it. `kind` is set by the host, not the model. */
export const docSpecInputSchema = z.object({
  title: z.string().describe("The document's title, shown on its first page."),
  titlePage: z.boolean().optional().describe("true to put the title on a page of its own."),
  sections: z
    .array(sectionSchema)
    .describe("The sections, in order. Each has an id, an optional heading and its blocks."),
});

const columnSchema = z.object({
  key: z.string().describe("The column's key, the name the rows use for its cells."),
  header: z.string().describe("The column's heading as shown to the reader."),
  type: z.string().describe('One of "text", "number", "currency", "percent", "date" (dates as YYYY-MM-DD).'),
  width: z.number().optional().describe("The column width in characters, optional."),
});

const sheetSchema = z.object({
  id: SECTION_ID.describe("A short id for this sheet. Stable: use it to revise this sheet later."),
  name: z.string().describe("The sheet's tab name."),
  columns: z.array(columnSchema).describe("The columns, in order, each with a key, a header and a type."),
  rows: z.array(z.record(z.string(), z.unknown())).describe("The rows: an object per row, from column key to value."),
  totals: z.boolean().optional().describe("true to add a totals row under the numeric columns."),
  freezeHeader: z.boolean().optional().describe("true to keep the header row visible while scrolling (the default)."),
});

/** A workbook spec as the model writes it. `kind` is set by the host, not the model. */
export const sheetSpecInputSchema = z.object({
  title: z.string().describe("The workbook's title."),
  sheets: z.array(sheetSchema).describe("The sheets, in tab order."),
});

const themeField = z.string().optional().describe('The look: "plain" (the default), "corporate" or "modern".');

export const createDocumentSchema = z.object({
  format: z.string().describe('The file type: "docx" (a Word file) or "pdf" (a PDF).'),
  spec: docSpecInputSchema,
  theme: themeField,
});

export const createWorkbookSchema = z.object({
  spec: sheetSpecInputSchema,
  theme: themeField,
});

export const reviseDocumentSchema = z.object({
  artifactId: z
    .string()
    .describe("The id of the file to revise, from create_document, create_workbook, import_document or the owner."),
  sectionId: z.string().optional().describe("The id of the section to replace (a document)."),
  section: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The section's new content: an optional heading and its blocks. Its id is the sectionId."),
  sheetId: z.string().optional().describe("The id of the sheet to replace (a workbook)."),
  sheet: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The sheet's new content: a name, columns and rows. Its id is the sheetId."),
  theme: z.string().optional().describe('Restyle the whole file: "plain", "corporate" or "modern".'),
  format: z
    .string()
    .optional()
    .describe('For a document only: "docx" or "pdf", to export the revised document in that type.'),
});

export const importDocumentSchema = z.object({
  artifactId: z.string().describe("The id of a stored Word, Excel or PDF file to import into an editable copy."),
});

export type CreateDocumentArgs = z.infer<typeof createDocumentSchema>;
export type CreateWorkbookArgs = z.infer<typeof createWorkbookSchema>;
export type ReviseDocumentArgs = z.infer<typeof reviseDocumentSchema>;
export type ImportDocumentArgs = z.infer<typeof importDocumentSchema>;
