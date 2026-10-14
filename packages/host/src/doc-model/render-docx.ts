/** DocSpec to a Word (.docx) file: headings, runs, lists, tables with a header fill, page breaks. */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
} from "docx";
import { parseRuns } from "./runs";
import { themeFor, type DocTheme } from "./themes";
import type { Block, CellValue, DocSpec } from "./types";

const NUMBERED_REFERENCE = "numbered";

function plainCell(value: CellValue): string {
  if (value === null) {
    return "";
  }
  return String(value);
}

/** Inline runs with the theme font and colour; `**` and `*` markup becomes bold and italic. */
function runsFor(text: string, theme: DocTheme, extra: IRunOptions = {}): TextRun[] {
  return parseRuns(text).map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold || extra.bold,
        italics: run.italic || extra.italics,
        font: theme.fontFamily,
        size: Math.round(theme.bodySize * 2),
        color: theme.textColor,
      }),
  );
}

function headingParagraph(text: string, theme: DocTheme): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [
      new TextRun({
        text,
        bold: true,
        font: theme.fontFamily,
        size: Math.round(theme.headingSize * 2),
        color: theme.accentColor,
      }),
    ],
  });
}

function titleParagraphs(title: string, theme: DocTheme, titlePage: boolean): Paragraph[] {
  const heading = new Paragraph({
    heading: HeadingLevel.TITLE,
    spacing: { before: 2400, after: 240 },
    children: [
      new TextRun({
        text: title,
        bold: true,
        font: theme.fontFamily,
        size: Math.round(theme.titleSize * 2),
        color: theme.accentColor,
      }),
    ],
  });
  if (!titlePage) {
    return [heading];
  }
  return [heading, new Paragraph({ children: [new PageBreak()] })];
}

/** Numbered lists restart at 1: each list gets its own instance of the one numbering reference. */
function listParagraphs(block: Block, theme: DocTheme, instance: number): Paragraph[] {
  if (block.type === "bullets") {
    return block.items.map(
      (item) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 80 }, children: runsFor(item, theme) }),
    );
  }
  if (block.type === "numbered") {
    return block.items.map(
      (item) =>
        new Paragraph({
          numbering: { reference: NUMBERED_REFERENCE, level: 0, instance },
          spacing: { after: 80 },
          children: runsFor(item, theme),
        }),
    );
  }
  return [];
}

function cellBorders() {
  const line = { style: BorderStyle.SINGLE, size: 4, color: "BBBBBB" };
  return { top: line, bottom: line, left: line, right: line };
}

function tableCell(text: string, theme: DocTheme, header: boolean): TableCell {
  return new TableCell({
    borders: cellBorders(),
    shading: header ? { type: ShadingType.CLEAR, color: "auto", fill: theme.headerFill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        children: runsFor(text, theme, { bold: header }),
      }),
    ],
  });
}

function tableFor(block: Extract<Block, { type: "table" }>, theme: DocTheme): Table {
  const header = new TableRow({
    tableHeader: true,
    children: block.columns.map((column) => tableCell(column, theme, true)),
  });
  const body = block.rows.map(
    (row) => new TableRow({ children: row.map((value) => tableCell(plainCell(value), theme, false)) }),
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] });
}

/** Blocks of one section, in order. `counter` numbers each numbered list. */
function blockChildren(blocks: readonly Block[], theme: DocTheme, counter: { next: number }): (Paragraph | Table)[] {
  return blocks.flatMap((block): (Paragraph | Table)[] => {
    switch (block.type) {
      case "paragraph":
        return [new Paragraph({ spacing: { after: 160 }, children: runsFor(block.text, theme) })];
      case "quote":
        return [
          new Paragraph({
            indent: { left: 567 },
            spacing: { before: 120, after: 160 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: theme.accentColor, space: 12 } },
            children: runsFor(block.text, theme, { italics: true }),
          }),
        ];
      case "bullets":
        return listParagraphs(block, theme, 0);
      case "numbered": {
        counter.next += 1;
        return listParagraphs(block, theme, counter.next);
      }
      case "table":
        return [tableFor(block, theme), new Paragraph({ spacing: { after: 120 }, children: [] })];
      case "pageBreak":
        return [new Paragraph({ alignment: AlignmentType.LEFT, children: [new PageBreak()] })];
    }
    return [];
  });
}

export async function renderDocx(spec: DocSpec): Promise<Uint8Array> {
  const theme = themeFor(spec.theme);
  const counter = { next: 0 };
  const children: (Paragraph | Table)[] = titleParagraphs(spec.title, theme, spec.titlePage);
  for (const section of spec.sections) {
    if (section.heading) {
      children.push(headingParagraph(section.heading, theme));
    }
    children.push(...blockChildren(section.blocks, theme, counter));
  }
  const document = new Document({
    title: spec.title,
    styles: { default: { document: { run: { font: theme.fontFamily, size: Math.round(theme.bodySize * 2) } } } },
    numbering: {
      config: [
        {
          reference: NUMBERED_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
