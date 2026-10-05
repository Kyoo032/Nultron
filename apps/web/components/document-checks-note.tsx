"use client";

import { t } from "@/lib/i18n";
import type { DocumentChecksNoteModel } from "@/lib/documents-desk-sources";

/**
 * What the host's checks still found after the repair round. The draft is saved either way; this says
 * so, and names the sections to look at. Nothing renders when every check passed.
 */
export function DocumentChecksNote({ note }: { readonly note: DocumentChecksNoteModel | null }) {
  if (!note) {
    return null;
  }
  const title =
    note.kind === "grounding"
      ? note.headings.length === 1
        ? t("documents.checks.groundingOne")
        : t("documents.checks.grounding", { count: note.headings.length })
      : t("documents.checks.structure");
  const hint =
    note.kind === "grounding"
      ? t("documents.checks.groundingHint", { action: t("documents.check") })
      : t("documents.checks.structureHint");
  return (
    <div
      className="mt-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm"
      role="status"
      data-testid="documents-checks-note"
      data-kind={note.kind}
    >
      <p className="font-medium text-[var(--text)]">{title}</p>
      {note.kind === "grounding" ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="documents-checks-sections">
          {note.headings.map((heading) => (
            <li
              key={heading}
              className="min-w-0 max-w-full truncate rounded-pill border border-[var(--line)] bg-[var(--accent-soft)] px-2.5 py-0.5 text-xs text-[var(--text)]"
              title={heading}
            >
              {heading}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1.5 text-xs text-[var(--text-2)]">{hint}</p>
    </div>
  );
}
