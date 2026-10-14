/**
 * DocSpec to a PDF: A4, the standard Helvetica family, word-wrapped paragraphs, headings, bullet and
 * numbered lists, grid tables whose header repeats after a page break, and a page number in the footer.
 *
 * The standard fonts are the only ones this renderer uses, so the theme's `fontFamily` does not apply
 * here; the theme's colours and sizes do. Characters the fonts cannot draw are replaced by `pdf-text.ts`.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { wrapSegments, type Line, type Segment } from "./pdf-text";
import { parseRuns } from "./runs";
import { themeFor, type DocTheme } from "./themes";
import type { Block, CellValue, DocSpec } from "./types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const TOP = PAGE_HEIGHT - MARGIN;
/** Keeps body text clear of the footer line. */
const BOTTOM = MARGIN + 16;
const FOOTER_Y = 28;
const FOOTER_SIZE = 8;
const LINE_FACTOR = 1.35;
const CELL_PAD = 4;
const RULE_THICKNESS = 0.5;
const BULLET = "•";
const LIST_TEXT_INDENT = 18;
const QUOTE_INDENT = 18;
const PARAGRAPH_GAP = 6;

type Fonts = {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly italic: PDFFont;
  readonly boldItalic: PDFFont;
};

function hexColor(hex: string): RGB {
  const channel = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return rgb(channel(0), channel(2), channel(4));
}

function pickFont(fonts: Fonts, bold: boolean, italic: boolean): PDFFont {
  if (bold && italic) {
    return fonts.boldItalic;
  }
  if (bold) {
    return fonts.bold;
  }
  return italic ? fonts.italic : fonts.regular;
}

/** Markup runs as wrap segments. `forceBold` and `forceItalic` apply a style to the whole text. */
function segmentsFor(text: string, fonts: Fonts, forceBold = false, forceItalic = false): Segment[] {
  return parseRuns(text).map((run) => ({
    text: run.text,
    font: pickFont(fonts, run.bold || forceBold, run.italic || forceItalic),
  }));
}

function plainCell(value: CellValue): string {
  return value === null ? "" : String(value);
}

/** Holds the page being written and the vertical position on it. Every draw goes through here. */
class PdfLayout {
  private readonly pages: PDFPage[] = [];
  private page: PDFPage;
  private y = TOP;
  /** Drawn at the top of every page a table spills onto, so the header reads on each page. */
  private repeatHeader: (() => void) | null = null;

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
    private readonly theme: DocTheme,
  ) {
    this.page = this.addPage();
  }

  private addPage(): PDFPage {
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    this.page = page;
    this.y = TOP;
    return page;
  }

  breakPage(): void {
    this.addPage();
    const repeat = this.repeatHeader;
    if (repeat) {
      // Cleared while the header is drawn, so a header taller than a page cannot recurse.
      this.repeatHeader = null;
      repeat();
      this.repeatHeader = repeat;
    }
  }

  private room(height: number): void {
    if (this.y - height < BOTTOM) {
      this.breakPage();
    }
  }

  private drawPieces(line: Line, x: number, baseline: number, size: number, color: RGB): void {
    let cursor = x;
    for (const piece of line) {
      if (piece.text !== "") {
        this.page.drawText(piece.text, { x: cursor, y: baseline, font: piece.font, size, color });
        cursor += piece.font.widthOfTextAtSize(piece.text, size);
      }
    }
  }

  /** Lines of text at `x`, one page-aware line box each. A marker, if given, sits on the first line. */
  private drawLines(
    lines: readonly Line[],
    x: number,
    size: number,
    color: RGB,
    marker?: { readonly text: string; readonly x: number; readonly font: PDFFont },
  ): void {
    const lineHeight = size * LINE_FACTOR;
    lines.forEach((line, index) => {
      this.room(lineHeight);
      const baseline = this.y - size;
      if (index === 0 && marker) {
        this.page.drawText(marker.text, { x: marker.x, y: baseline, font: marker.font, size, color });
      }
      this.drawPieces(line, x, baseline, size, color);
      this.y -= lineHeight;
    });
  }

  title(text: string): void {
    const size = this.theme.titleSize;
    const accent = hexColor(this.theme.accentColor);
    const lines = wrapSegments([{ text, font: this.fonts.bold }], CONTENT_WIDTH, size);
    this.drawLines(lines, MARGIN, size, accent);
    this.y -= 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
      thickness: 1,
      color: hexColor(this.theme.ruleColor),
    });
    this.y -= 18;
  }

  heading(text: string): void {
    const size = this.theme.headingSize;
    this.y -= 10;
    const lines = wrapSegments(segmentsFor(text, this.fonts, true), CONTENT_WIDTH, size);
    this.drawLines(lines, MARGIN, size, hexColor(this.theme.accentColor));
    this.y -= 4;
  }

  paragraph(text: string, indent = 0, italic = false): void {
    const size = this.theme.bodySize;
    const lines = wrapSegments(segmentsFor(text, this.fonts, false, italic), CONTENT_WIDTH - indent, size);
    this.drawLines(lines, MARGIN + indent, size, hexColor(this.theme.textColor));
    this.y -= PARAGRAPH_GAP;
  }

  /** Bullets and numbers: a marker in the margin, the item wrapped in the indent. */
  listItem(marker: string, text: string): void {
    const size = this.theme.bodySize;
    const lines = wrapSegments(segmentsFor(text, this.fonts), CONTENT_WIDTH - LIST_TEXT_INDENT, size);
    this.drawLines(lines, MARGIN + LIST_TEXT_INDENT, size, hexColor(this.theme.textColor), {
      text: marker,
      x: MARGIN,
      font: this.fonts.regular,
    });
  }

  private tableRowLines(cells: readonly (readonly Line[])[], columnWidth: number, header: boolean): void {
    const size = this.theme.bodySize;
    const lineHeight = size * LINE_FACTOR;
    const total = Math.max(1, ...cells.map((lines) => lines.length));
    const fullPage = Math.floor((TOP - BOTTOM - 2 * CELL_PAD) / lineHeight);
    if (total <= fullPage && this.y - (total * lineHeight + 2 * CELL_PAD) < BOTTOM) {
      // A row that fits on a fresh page moves there whole rather than splitting.
      this.breakPage();
    }
    let offset = 0;
    while (offset < total) {
      const fit = Math.floor((this.y - BOTTOM - 2 * CELL_PAD) / lineHeight);
      if (fit < 1) {
        this.breakPage();
        continue;
      }
      const count = Math.min(fit, total - offset);
      const height = count * lineHeight + 2 * CELL_PAD;
      this.drawRowSegment(cells, columnWidth, offset, count, height, header);
      offset += count;
    }
  }

  private drawRowSegment(
    cells: readonly (readonly Line[])[],
    columnWidth: number,
    offset: number,
    count: number,
    height: number,
    header: boolean,
  ): void {
    const size = this.theme.bodySize;
    const lineHeight = size * LINE_FACTOR;
    const top = this.y;
    const bottom = top - height;
    const rule = hexColor(this.theme.ruleColor);
    const fill = header ? hexColor(this.theme.headerFill) : undefined;
    cells.forEach((lines, column) => {
      const x = MARGIN + column * columnWidth;
      this.page.drawRectangle({
        x,
        y: bottom,
        width: columnWidth,
        height,
        borderColor: rule,
        borderWidth: RULE_THICKNESS,
        color: fill,
      });
      lines.slice(offset, offset + count).forEach((line, index) => {
        const baseline = top - CELL_PAD - index * lineHeight - size;
        this.drawPieces(line, x + CELL_PAD, baseline, size, hexColor(this.theme.textColor));
      });
    });
    this.y = bottom;
  }

  /** A grid table: equal columns, a header row that repeats on each new page, rows that wrap. */
  table(columns: readonly string[], rows: readonly (readonly CellValue[])[]): void {
    const size = this.theme.bodySize;
    const columnWidth = CONTENT_WIDTH / columns.length;
    const cellWidth = columnWidth - 2 * CELL_PAD;
    const headerCells = columns.map((column) => wrapSegments(segmentsFor(column, this.fonts, true), cellWidth, size));
    const drawHeader = () => this.tableRowLines(headerCells, columnWidth, true);
    this.repeatHeader = drawHeader;
    drawHeader();
    for (const row of rows) {
      const cells = row.map((value) => wrapSegments(segmentsFor(plainCell(value), this.fonts), cellWidth, size));
      this.tableRowLines(cells, columnWidth, false);
    }
    this.repeatHeader = null;
    this.y -= PARAGRAPH_GAP;
  }

  footers(): void {
    const total = this.pages.length;
    const color = hexColor(this.theme.ruleColor);
    this.pages.forEach((page, index) => {
      const label = `${index + 1} / ${total}`;
      const width = this.fonts.regular.widthOfTextAtSize(label, FOOTER_SIZE);
      page.drawText(label, {
        x: (PAGE_WIDTH - width) / 2,
        y: FOOTER_Y,
        font: this.fonts.regular,
        size: FOOTER_SIZE,
        color,
      });
    });
  }
}

function drawBlock(layout: PdfLayout, block: Block, counter: { next: number }): void {
  switch (block.type) {
    case "paragraph":
      layout.paragraph(block.text);
      return;
    case "quote":
      layout.paragraph(block.text, QUOTE_INDENT, true);
      return;
    case "bullets":
      for (const item of block.items) {
        layout.listItem(BULLET, item);
      }
      layout.paragraph("", 0);
      return;
    case "numbered":
      counter.next = 0;
      block.items.forEach((item) => {
        counter.next += 1;
        layout.listItem(`${counter.next}.`, item);
      });
      return;
    case "table":
      layout.table(block.columns, block.rows);
      return;
    case "pageBreak":
      layout.breakPage();
      return;
  }
}

export async function renderPdf(spec: DocSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const theme = themeFor(spec.theme);
  const layout = new PdfLayout(doc, fonts, theme);
  layout.title(spec.title);
  if (spec.titlePage) {
    layout.breakPage();
  }
  const counter = { next: 0 };
  for (const section of spec.sections) {
    if (section.heading) {
      layout.heading(section.heading);
    }
    for (const block of section.blocks) {
      drawBlock(layout, block, counter);
    }
  }
  layout.footers();
  doc.setTitle(spec.title);
  return new Uint8Array(await doc.save());
}
