import { financeBriefSchema, type FinanceBrief } from "@agentforge/core/artifacts";
import { readFinanceReport } from "./finance-auto-client";
import type { FinanceResult, GuardReport } from "./finance-client";

export type FinanceArtifactRecord = {
  readonly id: string;
  readonly title?: string;
  readonly body: string;
  readonly meta?: Readonly<Record<string, unknown>> | null;
};

export type FinanceOpenView =
  | { readonly kind: "report"; readonly result: FinanceResult }
  | { readonly kind: "brief"; readonly result: FinanceResult }
  | { readonly kind: "markdown"; readonly markdown: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readFinanceGuard(value: unknown): GuardReport {
  const row = record(value);
  const flagged = Array.isArray(row?.flagged)
    ? row.flagged.flatMap((entry) => {
        const one = record(entry);
        return one && typeof one.section === "number" && Number.isInteger(one.section) && typeof one.text === "string"
          ? [{ section: one.section, text: one.text }]
          : [];
      })
    : [];
  const total = typeof row?.total === "number" && Number.isInteger(row.total) ? row.total : 0;
  return { flagged, total };
}

function placeholderBrief(title: string, markdown: string): FinanceBrief {
  const heading = title.trim();
  return financeBriefSchema.parse({
    title: heading,
    sections: [{ heading, body: markdown.trim() || heading }],
  });
}

export function financeOpenView(artifact: FinanceArtifactRecord): FinanceOpenView {
  const meta = record(artifact.meta);
  const task = typeof meta?.task === "string" ? meta.task : "";
  const guard = readFinanceGuard(meta?.guard);
  const report = readFinanceReport(meta?.report, task);
  if (report) {
    return {
      kind: "report",
      result: {
        brief: placeholderBrief(report.title, artifact.body),
        artifactId: artifact.id,
        markdown: artifact.body,
        guard,
        items: [],
        report,
      },
    };
  }
  const brief = financeBriefSchema.safeParse(meta?.brief);
  if (brief.success) {
    return {
      kind: "brief",
      result: { brief: brief.data, artifactId: artifact.id, markdown: artifact.body, guard, items: [] },
    };
  }
  return { kind: "markdown", markdown: artifact.body };
}
