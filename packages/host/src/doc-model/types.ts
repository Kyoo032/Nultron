/**
 * The editable document model. One spec describes a Word document or an Excel workbook; the
 * renderers in this folder turn it into bytes. A section id or a sheet id is stable, so a later tool
 * can replace one part and keep every other part as it was.
 *
 * Shape limits are checked in `limits.ts` (they are totals across the whole spec, which a plain zod
 * `.max` cannot express). Parsing goes through `parseDocSpec` / `parseSheetSpec`, which run both.
 */
import { z } from "zod";
import { DOC_THEME_NAMES } from "./themes";
import { assertDocLimits, assertSheetLimits } from "./limits";
import { DocModelError } from "./errors";

const CELL_VALUE = z.union([z.string(), z.number(), z.null()]);
const ID = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, '-' or '_' only");
const THEME = z.enum(DOC_THEME_NAMES).default("plain");

const paragraphBlock = z.object({ type: z.literal("paragraph"), text: z.string() });
const bulletsBlock = z.object({ type: z.literal("bullets"), items: z.array(z.string()).min(1) });
const numberedBlock = z.object({ type: z.literal("numbered"), items: z.array(z.string()).min(1) });
const quoteBlock = z.object({ type: z.literal("quote"), text: z.string() });
const pageBreakBlock = z.object({ type: z.literal("pageBreak") });
// Row width against the column count is checked in `limits.ts`: a zod refinement would turn this
// object into an effect, and the discriminated union needs a plain object.
const tableBlock = z.object({
  type: z.literal("table"),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(CELL_VALUE)),
});

export const blockSchema = z.discriminatedUnion("type", [
  paragraphBlock,
  bulletsBlock,
  numberedBlock,
  quoteBlock,
  pageBreakBlock,
  tableBlock,
]);

export const sectionSchema = z.object({
  id: ID,
  heading: z.string().max(300).optional(),
  blocks: z.array(blockSchema),
});

export const docSpecSchema = z.object({
  kind: z.literal("document"),
  title: z.string().min(1).max(300),
  theme: THEME,
  titlePage: z.boolean().default(false),
  sections: z.array(sectionSchema),
});

export const COLUMN_TYPES = ["text", "number", "currency", "percent", "date"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

const columnSchema = z.object({
  key: ID,
  header: z.string().min(1).max(200),
  type: z.enum(COLUMN_TYPES),
  width: z.number().positive().max(100).optional(),
});

const sheetSchema = z.object({
  id: ID,
  name: z.string().min(1).max(200),
  columns: z.array(columnSchema).min(1),
  rows: z.array(z.record(z.string(), CELL_VALUE)),
  totals: z.boolean().default(false),
  freezeHeader: z.boolean().default(true),
});

export const sheetSpecSchema = z.object({
  kind: z.literal("workbook"),
  title: z.string().min(1).max(300),
  theme: THEME,
  sheets: z.array(sheetSchema),
});

export type Block = z.infer<typeof blockSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type DocSpec = z.infer<typeof docSpecSchema>;
export type Column = z.infer<typeof columnSchema>;
export type SheetSpec = z.infer<typeof sheetSpecSchema>;
export type Sheet = z.infer<typeof sheetSchema>;
export type CellValue = z.infer<typeof CELL_VALUE>;

export { DocModelError } from "./errors";

function zodMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`).join("; ");
}

/** Validate an unknown value as a document spec. Refuses with a `DocModelError`; never truncates. */
export function parseDocSpec(input: unknown): DocSpec {
  const parsed = docSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocModelError(`invalid document spec: ${zodMessage(parsed.error)}`);
  }
  assertDocLimits(parsed.data);
  return parsed.data;
}

/** Validate an unknown value as a workbook spec. Refuses with a `DocModelError`; never truncates. */
export function parseSheetSpec(input: unknown): SheetSpec {
  const parsed = sheetSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocModelError(`invalid workbook spec: ${zodMessage(parsed.error)}`);
  }
  assertSheetLimits(parsed.data);
  return parsed.data;
}
