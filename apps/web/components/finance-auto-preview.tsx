"use client";

/**
 * The free preview of the prompt-first Finance screen: a task's report with its prose left empty.
 *
 * The host computed every figure here in code (`POST /api/v1/finance/auto`); no model has written a
 * word of it. It is the same `FinanceReport` the write-up and the exports read, drawn with the same
 * chart components, so the preview and the finished result can never disagree about a number.
 */
import {
  CALC_TABLE_ID,
  INPUTS_TABLE_ID,
  type FinanceReport,
  type ReportCell,
  type ReportTable,
} from "@agentforge/core/finance";
import { FinanceReportCharts } from "@/components/finance-charts";
import { getLocale, t } from "@/lib/i18n";

/** Rows shown per table. A preview is a look, not the workbook. */
export const FINANCE_AUTO_TABLE_ROWS = 12;

const FLAG_CLASS: Readonly<Record<string, string>> = {
  risk: "text-[var(--danger)]",
  watch: "text-[var(--warn,var(--text-2))]",
  good: "text-[var(--text-2)]",
};

export function formatPreviewCell(value: ReportCell): string {
  if (value === null) {
    return "—";
  }
  if (typeof value === "number") {
    return value.toLocaleString(getLocale(), { maximumFractionDigits: 2 });
  }
  return String(value);
}

function Kpis({ report }: { report: FinanceReport }) {
  if (report.summary.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="finance-auto-kpis">
      {report.summary.map((kpi) => (
        <div
          key={kpi.label}
          className="min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
          data-flag={kpi.flag ?? "good"}
        >
          <div className="break-words text-[10px] uppercase tracking-wide text-[var(--text-3)]">{kpi.label}</div>
          <div className={`break-words tabular-nums ${FLAG_CLASS[kpi.flag ?? "good"] ?? ""}`}>
            {formatPreviewCell(kpi.value)}
            {kpi.unit && typeof kpi.value === "number" ? ` ${kpi.unit}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function Flags({ report }: { report: FinanceReport }) {
  if (report.flags.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1 text-xs" data-testid="finance-auto-flags">
      {report.flags.map((flag) => (
        <li key={`${flag.level}-${flag.text}`} className={FLAG_CLASS[flag.level] ?? ""}>
          {flag.text}
        </li>
      ))}
    </ul>
  );
}

function PreviewTable({ table, open }: { table: ReportTable; open: boolean }) {
  const shown = table.rows.slice(0, FINANCE_AUTO_TABLE_ROWS);
  const hidden = table.rows.length - shown.length;
  return (
    <details
      className="rounded-lg border border-[var(--line)] px-3 py-2"
      open={open}
      data-testid={`finance-auto-table-${table.id}`}
    >
      <summary className="cursor-pointer select-none text-xs font-medium text-[var(--text-2)]">{table.title}</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-[var(--line)] px-2 py-1 text-left font-medium text-[var(--text-2)]"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a preview row has no id of its own
              <tr key={`r${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: a preview cell has no id of its own
                    key={`c${cellIndex}`}
                    className="border-b border-[var(--line)] px-2 py-1 text-[var(--text)] tabular-nums"
                  >
                    {formatPreviewCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? (
        <p className="mt-1 text-xs text-[var(--text-3)]">{t("finance.auto.tableMoreRows", { n: hidden })}</p>
      ) : null}
    </details>
  );
}

/** The report's own computed tables. The two sheets that exist for the workbook (inputs, formulas) are not a preview. */
export function previewTables(report: FinanceReport): readonly ReportTable[] {
  return report.tables.filter((table) => table.id !== INPUTS_TABLE_ID && table.id !== CALC_TABLE_ID);
}

export function FinanceAutoPreview({ report }: { report: FinanceReport }) {
  const tables = previewTables(report);
  return (
    <section className="space-y-4" data-testid="finance-auto-preview" data-task={report.task}>
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)]">{t("finance.auto.previewTitle")}</h2>
        <p className="mt-0.5 text-xs text-[var(--text-3)]">{t("finance.auto.previewHint")}</p>
      </div>
      <Kpis report={report} />
      <Flags report={report} />
      <FinanceReportCharts report={report} />
      {tables.length > 0 ? (
        <div className="space-y-2" data-testid="finance-auto-tables">
          <p className="panel-label">{t("finance.auto.tablesTitle")}</p>
          {tables.map((table, index) => (
            <PreviewTable key={table.id} table={table} open={index === 0} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
