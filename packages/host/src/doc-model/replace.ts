/**
 * Pure edits on a spec: replace one section or one sheet, or restyle the whole thing. Each returns a
 * new object and never mutates the input. Every other part is carried over unchanged, and the result
 * goes back through the parser, so an edit cannot push a spec past a cap or break an id.
 */
import { DOC_THEME_NAMES, type DocThemeName } from "./themes";
import { DocModelError } from "./errors";
import { parseDocSpec, parseSheetSpec, type DocSpec, type Section, type Sheet, type SheetSpec } from "./types";

/**
 * Replace the section with id `id`. The new section takes that id, so a reference to it stays valid.
 * An unknown id is refused, never a silent no-op.
 */
export function replaceSection(doc: DocSpec, id: string, section: Section): DocSpec {
  const index = doc.sections.findIndex((existing) => existing.id === id);
  if (index === -1) {
    throw new DocModelError(`no section "${id}" in this document`);
  }
  const sections = doc.sections.map((existing, position) => (position === index ? { ...section, id } : existing));
  return parseDocSpec({ ...doc, sections });
}

/** Replace the sheet with id `id`. The new sheet takes that id. An unknown id is refused. */
export function replaceSheet(book: SheetSpec, id: string, sheet: Sheet): SheetSpec {
  const index = book.sheets.findIndex((existing) => existing.id === id);
  if (index === -1) {
    throw new DocModelError(`no sheet "${id}" in this workbook`);
  }
  const sheets = book.sheets.map((existing, position) => (position === index ? { ...sheet, id } : existing));
  return parseSheetSpec({ ...book, sheets });
}

/** The same content in another theme. Only the `theme` field changes. */
export function restyle<T extends { readonly theme: DocThemeName }>(spec: T, theme: DocThemeName): T {
  if (!(DOC_THEME_NAMES as readonly string[]).includes(theme)) {
    throw new DocModelError(`unknown theme "${theme}", use one of ${DOC_THEME_NAMES.join(", ")}`);
  }
  return { ...spec, theme };
}
