/**
 * Legal mode — file-layer helpers for the matter store.
 *
 * Layout under `<rootDir>/tenants/<tenantId>/<workspaceId>/<matterId>/` — the tenant prefix is
 * empty for the local tenant, so a pre-Phase-3 matter stays at `<rootDir>/<workspaceId>/<matterId>/`
 * and is read and written in place (see `tenant-paths.ts`):
 *   matter.json              LegalMatterRecord
 *   files/<docId>.docx|pdf   original bytes
 *   parsed/<docId>.json      DocxDocument (cached reader output; a PDF's is made from its text)
 *   parsed/<docId>.pages.json  paragraph anchor -> page, for a PDF whose reader marked its pages
 *   runs/<runId>.json        LegalRunRecord
 *   extract.json             LegalExtractRecord (the latest extraction)
 *   extract-edits.json       the owner's edits and comments on it
 *   asks.json                the questions asked and their answers, capped
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@agentforge/core";
import { type DocxDocument, documentFromPlainText, plainTextPages } from "@agentforge/core/docx";
import { LEGAL_CAPS, LEGAL_FILE_NAME_MAX, legalOutputCopy, type MatterDocCard } from "@agentforge/core/legal";
import { type ExtractFileOptions, FileExtractError, extractFile } from "../file-extract";
import { readDocxUnderCaps } from "../knowledge-extract";
import { localeForRun } from "../run-context";
import { assertPathSegment, tenantScopedRoot } from "../tenant-paths";

/** Per-file cap matches the IPC bytes envelope (tighter than LEGAL_CAPS.maxFileBytes). */
export const LEGAL_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const LEGAL_MATTER_MAX_BYTES = LEGAL_CAPS.maxTotalBytes;
export const LEGAL_LIST_LIMIT = 100;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF_MIME = "application/pdf";
/** English wording kept for callers that compare against it; live throws use the run locale. */
export const UNSUPPORTED_FILE_MESSAGE = legalOutputCopy("en").unsupportedFile;

function unsupportedFileError(): ApiError {
  return new ApiError("unsupported_content_type", legalOutputCopy(localeForRun()).unsupportedFile, 400);
}

export type LegalFileFormat = "docx" | "pdf";

const MATTER_FILE = "matter.json";
const EXTRACT_FILE = "extract.json";
const EXTRACT_EDITS_FILE = "extract-edits.json";
const ASKS_FILE = "asks.json";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const DOC_ID_PATTERN = /^S(\d+)$/;
const CARD_PATH_PATTERN = /^files\/S\d+\.(docx|pdf)$/;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const PDF_PAGE_MARKER = /<!--\s*page\s+\d+\s*-->/i;
const PDF_CANONICAL_NAME = "document.pdf";
const DOCX_ERROR_PREFIX = "docx:";

export function assertSafeId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new ApiError("invalid_request", `${label} is malformed`, 400);
  }
  return value;
}

/** The tenant's own slice of the legal root. `tenants` is refused as a desk id so it cannot alias it. */
export function tenantLegalRoot(rootDir: string, tenantId: string, workspaceId: string): string {
  return path.join(tenantScopedRoot(rootDir, tenantId), assertPathSegment(workspaceId, "Workspace id"));
}

export function matterDir(rootDir: string, tenantId: string, workspaceId: string, matterId: string): string {
  return path.join(tenantLegalRoot(rootDir, tenantId, workspaceId), assertSafeId(matterId, "Matter id"));
}

export function matterFile(dir: string): string {
  return path.join(dir, MATTER_FILE);
}

export function docFile(dir: string, docId: string, format: LegalFileFormat = "docx"): string {
  return path.join(dir, "files", `${assertSafeId(docId, "Document id")}.${format}`);
}

export function parsedFile(dir: string, docId: string): string {
  return path.join(dir, "parsed", `${assertSafeId(docId, "Document id")}.json`);
}

/** Paragraph anchor -> page, beside the parsed file. Only a PDF whose reader marked its pages has one. */
export function pagesFile(dir: string, docId: string): string {
  return path.join(dir, "parsed", `${assertSafeId(docId, "Document id")}.pages.json`);
}

export function extractFilePath(dir: string): string {
  return path.join(dir, EXTRACT_FILE);
}

export function extractEditsFile(dir: string): string {
  return path.join(dir, EXTRACT_EDITS_FILE);
}

export function asksFile(dir: string): string {
  return path.join(dir, ASKS_FILE);
}

/** The format a stored card is in. Old cards say `.docx`; a card with an unreadable path is read as Word. */
export function cardFormat(card: Pick<MatterDocCard, "path" | "mime">): LegalFileFormat {
  const match = CARD_PATH_PATTERN.exec(card.path);
  if (match) {
    return match[1] as LegalFileFormat;
  }
  return card.mime === PDF_MIME ? "pdf" : "docx";
}

/** The stored bytes of a card, wherever its format put them. */
export function cardFile(dir: string, card: Pick<MatterDocCard, "id" | "path" | "mime">): string {
  return docFile(dir, card.id, cardFormat(card));
}

export function runFile(dir: string, runId: string): string {
  return path.join(dir, "runs", `${assertSafeId(runId, "Run id")}.json`);
}

/** Directories under this tenant's `<workspaceId>/` that carry a matter.json. */
export function listMatterIds(rootDir: string, tenantId: string, workspaceId: string): string[] {
  const dir = tenantLegalRoot(rootDir, tenantId, workspaceId);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, MATTER_FILE)))
    .map((entry) => entry.name);
}

/** Write to a sibling temp name, then rename so readers never see a partial file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), "utf8");
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Parsed JSON, or null when the file does not exist. Corrupt files raise so callers can decide. */
export function readJson(file: string): unknown {
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError("internal_error", `Stored record ${path.basename(file)} is unreadable: ${detail}`, 500);
  }
}

export function readBytesIfPresent(file: string): Uint8Array | null {
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(name.trim()).replace(/[^\w.-]+/g, "_");
  if (base === "") {
    return "document.docx";
  }
  if (base.length <= LEGAL_FILE_NAME_MAX) {
    return base;
  }
  // Too long to keep whole (a record holds at most `LEGAL_FILE_NAME_MAX`): cut the stem and keep the extension.
  const extension = path.extname(base).slice(0, 12);
  return `${base.slice(0, LEGAL_FILE_NAME_MAX - extension.length)}${extension}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= ZIP_MAGIC.length && Buffer.from(bytes.subarray(0, ZIP_MAGIC.length)).equals(ZIP_MAGIC);
}

/**
 * Next `S<n>` id: one past the highest number the matter has ever handed out. `issued` is that highest number as
 * the matter remembers it; without it a removed last file would give its id to the next one, and the owner's
 * edits, comments and saved answers about the old file would attach to the new one.
 */
export function nextDocId(docs: readonly MatterDocCard[], issued = 0): string {
  const highest = docs.reduce((max, doc) => {
    const match = DOC_ID_PATTERN.exec(doc.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, issued);
  return `S${highest + 1}`;
}

/** The number in an `S<n>` id. */
export function docNumber(docId: string): number {
  const match = DOC_ID_PATTERN.exec(docId);
  return match ? Number(match[1]) : 0;
}

export function assertFileCaps(docs: readonly MatterDocCard[], bytes: Uint8Array): void {
  if (docs.length >= LEGAL_CAPS.maxFiles) {
    throw new ApiError("invalid_request", `A matter holds at most ${LEGAL_CAPS.maxFiles} files`, 413);
  }
  if (bytes.byteLength === 0) {
    throw new ApiError("invalid_request", "The uploaded file is empty", 400);
  }
  if (bytes.byteLength > LEGAL_FILE_MAX_BYTES) {
    throw new ApiError("invalid_request", "A file exceeds the 25 MB cap", 413);
  }
  const total = docs.reduce((sum, doc) => sum + doc.bytes, 0) + bytes.byteLength;
  if (total > LEGAL_MATTER_MAX_BYTES) {
    throw new ApiError("invalid_request", "The matter exceeds the 100 MB cap", 413);
  }
}

/**
 * Sniff the zip magic, then parse under the same caps Knowledge uses: byte size, the size the zip
 * directory *declares* it will inflate to, and a wall clock on the parse itself. Without the
 * declared-size pre-scan a few hundred bytes of crafted archive can claim gigabytes of XML and
 * take the host down before a single part has finished inflating.
 *
 * The reader raises "docx:"-prefixed errors for anything that is not a Word document; those, and
 * the cap failures that mean "unreadable", come back to the owner as the one unsupported-file
 * message. A size or timeout refusal keeps its own code so the owner can tell the two apart.
 */
export async function parseDocxOrThrow(bytes: Uint8Array): Promise<DocxDocument> {
  if (!isZip(bytes)) {
    throw unsupportedFileError();
  }
  try {
    return await readDocxUnderCaps(Buffer.from(bytes), { maxBytes: LEGAL_FILE_MAX_BYTES });
  } catch (error) {
    if (error instanceof ApiError && error.code === "docx_invalid") {
      throw unsupportedFileError();
    }
    if (error instanceof Error && error.message.startsWith(DOCX_ERROR_PREFIX)) {
      throw unsupportedFileError();
    }
    throw error;
  }
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_MAGIC.length && Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC);
}

function pdfRefusal(error: FileExtractError): ApiError {
  const copy = legalOutputCopy(localeForRun());
  switch (error.code) {
    case "needs_ocr":
      return new ApiError("needs_ocr", copy.needsOcr, 400);
    case "encrypted":
      return new ApiError("unsupported_content_type", copy.pdfEncrypted, 400);
    case "too_large":
      return new ApiError("invalid_request", "A file exceeds the 25 MB cap", 413);
    default:
      return new ApiError("unsupported_content_type", copy.pdfUnreadable, 400);
  }
}

/**
 * Read a PDF to text on this machine (the same local converter Knowledge and Finance use; nothing is sent
 * anywhere) and make a document of it, so clause splitting, quotes and the review run as they do on Word.
 * A scan has no text to read and is refused as `needs_ocr`. A PDF too long to read in full is refused, not cut:
 * the owner's rule is that every file is read in full.
 */
async function parsePdfOrThrow(bytes: Uint8Array, options: ExtractFileOptions): Promise<ParsedLegalFile> {
  const copy = legalOutputCopy(localeForRun());
  let extracted: Awaited<ReturnType<typeof extractFile>>;
  try {
    extracted = await extractFile({ bytes, filename: PDF_CANONICAL_NAME, mime: PDF_MIME }, options);
  } catch (error) {
    throw error instanceof FileExtractError ? pdfRefusal(error) : error;
  }
  if (extracted.meta.truncated) {
    throw new ApiError("invalid_request", copy.pdfTooLong, 413);
  }
  const doc = documentFromPlainText(extracted.text);
  if (doc.stats.words === 0) {
    throw new ApiError("needs_ocr", copy.needsOcr, 400);
  }
  return { format: "pdf", doc, pages: PDF_PAGE_MARKER.test(extracted.text) ? plainTextPages(extracted.text) : null };
}

export type ParsedLegalFile = {
  format: LegalFileFormat;
  doc: DocxDocument;
  /** Paragraph anchor -> page; null when the reader did not mark pages (Word files, and the converter's PDFs). */
  pages: Record<string, number> | null;
};

/** Word or PDF, by the bytes (never the name): anything else is the one unsupported-file refusal. */
export async function parseLegalFileOrThrow(
  bytes: Uint8Array,
  options: ExtractFileOptions = {},
): Promise<ParsedLegalFile> {
  if (isPdf(bytes)) {
    return parsePdfOrThrow(bytes, options);
  }
  return { format: "docx", doc: await parseDocxOrThrow(bytes), pages: null };
}

function previewText(doc: DocxDocument): string {
  const paragraphs = doc.paragraphs.map((paragraph) => paragraph.text);
  const rows = doc.tables.flatMap((table) => table.rows.map((row) => row.join(" | ")));
  return [...paragraphs, ...rows]
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .slice(0, LEGAL_CAPS.previewChars);
}

export function buildDocCard(input: {
  id: string;
  filename: string;
  bytes: Uint8Array;
  sha256: string;
  doc: DocxDocument;
  /** Defaults to Word, which is what every card written before PDFs was. */
  format?: LegalFileFormat;
}): MatterDocCard {
  const format = input.format ?? "docx";
  const name = sanitizeFilename(input.filename);
  return {
    id: input.id,
    name,
    path: `files/${input.id}.${format}`,
    mime: format === "pdf" ? PDF_MIME : DOCX_MIME,
    bytes: input.bytes.byteLength,
    sha256: input.sha256,
    role: "context",
    status: "read",
    paragraphs: input.doc.stats.paragraphs,
    words: input.doc.stats.words,
    insertions: input.doc.stats.insertions,
    deletions: input.doc.stats.deletions,
    definedTerms: input.doc.definedTerms.length,
    preview: previewText(input.doc),
  };
}
