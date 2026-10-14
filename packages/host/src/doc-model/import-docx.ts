/**
 * Word and PDF files to a document spec. The local converter (`file-extract`) turns the file into
 * Markdown, on this machine and with no network, and `import-markdown.ts` reads that Markdown into
 * sections and blocks. A scan that the converter refuses as `needs_ocr` reaches the caller as the same
 * `FileExtractError`, so the chat can say why nothing was imported.
 */
import { extractFile, type ExtractFileOptions, FileExtractError } from "../file-extract";
import { docSpecFromMarkdown, type MarkdownImportOptions } from "./import-markdown";
import { parseDocSpec, type DocSpec } from "./types";

export type DocImportOptions = MarkdownImportOptions & {
  /** Passed to the converter. Tests use it to stand in for a platform without the native binding. */
  readonly extract?: ExtractFileOptions;
};

/** The converter marks each PDF page with a comment line. It is not content, so it is removed. */
const PAGE_MARKER_LINE = /^<!-- page \d+ -->\s*$/gm;

/**
 * The renderer's title page is a heading with nothing under it, so the converter reads it as an empty
 * first section. With no title given, that heading becomes the title and the empty section goes, so a
 * file that is imported, rendered and imported again keeps the same sections and does not grow.
 */
function promoteTitlePage(spec: DocSpec): DocSpec {
  const [first, ...rest] = spec.sections;
  const isTitlePage =
    first !== undefined &&
    first.heading !== undefined &&
    first.heading.trim().length > 0 &&
    first.blocks.every((block) => block.type === "pageBreak");
  if (!isTitlePage || rest.length === 0) {
    return spec;
  }
  return parseDocSpec({
    ...spec,
    title: first.heading,
    titlePage: true,
    sections: rest.map((section, position) => ({ ...section, id: `s${position + 1}` })),
  });
}

async function docSpecFromFile(bytes: Uint8Array, filename: string, options: DocImportOptions): Promise<DocSpec> {
  const extracted = await extractFile({ bytes, filename }, options.extract);
  const markdown = extracted.markdown.replace(PAGE_MARKER_LINE, "");
  const spec = docSpecFromMarkdown(markdown, { title: options.title, theme: options.theme });
  return options.title === undefined ? promoteTitlePage(spec) : spec;
}

/** Read a .docx file into the editable document model. Throws `FileExtractError` when it cannot. */
export function docSpecFromDocx(bytes: Uint8Array, options: DocImportOptions = {}): Promise<DocSpec> {
  return docSpecFromFile(bytes, "document.docx", options);
}

/** Read a PDF into the editable document model. A scanned PDF throws `FileExtractError` `needs_ocr`. */
export function docSpecFromPdf(bytes: Uint8Array, options: DocImportOptions = {}): Promise<DocSpec> {
  return docSpecFromFile(bytes, "document.pdf", options);
}

export { FileExtractError };
