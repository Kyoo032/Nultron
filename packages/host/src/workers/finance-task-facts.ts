import { formatCellNumber, markdownTable } from "@agentforge/core/artifacts";
import {
  CALC_TABLE_ID,
  INPUTS_TABLE_ID,
  type FinanceReport,
  type ReportCell,
  type ReportTable,
} from "@agentforge/core/finance";

export const HEADLINE_MAX = 4;
export const FACTS_MAX = 3000;
const DECIMALS = 2;

export type FinanceHeadline = { readonly label: string; readonly value: string; readonly unit?: string };

export function formatFigure(value: ReportCell | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatCellNumber(Number(value.toFixed(DECIMALS))) : "";
  }
  return String(value);
}

export function headlineOf(report: FinanceReport): FinanceHeadline[] {
  return report.summary
    .filter((kpi) => kpi.value !== null && formatFigure(kpi.value) !== "")
    .slice(0, HEADLINE_MAX)
    .map((kpi) => ({
      label: kpi.label,
      value: formatFigure(kpi.value),
      ...(kpi.unit ? { unit: kpi.unit } : {}),
    }));
}

type Block = { readonly heading: string; readonly lines: readonly string[] };

function tableBlock(title: string, columns: readonly string[], rows: readonly (readonly ReportCell[])[]): Block {
  const formatted = rows.map((row) => row.map((cell) => formatFigure(cell)));
  return { heading: `### ${title}`, lines: markdownTable(columns, formatted).split("\n") };
}

function kpiBlock(report: FinanceReport): Block | null {
  const rows = report.summary
    .filter((kpi) => kpi.value !== null)
    .map((kpi): ReportCell[] => [kpi.label, kpi.value, kpi.unit ?? ""]);
  return rows.length === 0 ? null : tableBlock("Key figures", ["Figure", "Value", "Unit"], rows);
}

function orderedTables(report: FinanceReport): ReportTable[] {
  const kept = report.tables.filter(
    (table) => table.id !== CALC_TABLE_ID && table.columns.length > 0 && table.rows.length > 0,
  );
  return [
    ...kept.filter((table) => table.id !== INPUTS_TABLE_ID),
    ...kept.filter((table) => table.id === INPUTS_TABLE_ID),
  ];
}

function joinedLength(lines: readonly string[]): number {
  return lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length, lines.length - 1);
}

function appendBlock(out: string[], block: Block, max: number): boolean {
  const [header, divider, ...rows] = block.lines;
  const firstRow = rows[0];
  const head = [block.heading, header ?? "", divider ?? ""];
  if (firstRow === undefined || joinedLength([...out, ...head, firstRow]) > max) {
    return false;
  }
  out.push(...head);
  for (const row of rows) {
    if (joinedLength([...out, row]) > max) {
      return false;
    }
    out.push(row);
  }
  return true;
}

export function factsOf(report: FinanceReport, max: number = FACTS_MAX): string {
  const out: string[] = [];
  const kpis = kpiBlock(report);
  const blocks: Block[] = [
    ...(kpis ? [kpis] : []),
    ...orderedTables(report).map((table) => tableBlock(table.title, table.columns, table.rows)),
  ];
  for (const block of blocks) {
    if (!appendBlock(out, block, max)) {
      break;
    }
  }
  return out.join("\n");
}
