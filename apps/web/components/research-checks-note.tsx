"use client";

import { t } from "@/lib/i18n";
import type { ResearchCheckProblem, ResearchChecksNoteModel } from "@/lib/research-checks-view";

const PROBLEM_KEY: Readonly<Record<ResearchCheckProblem, string>> = {
  uncited: "research.checks.uncited",
  unknownSources: "research.checks.unknownSources",
  emptySections: "research.checks.emptySections",
};

/**
 * What the host's checks still found in a dossier after the repair round. The dossier is saved either
 * way; this says so in plain words. Nothing renders when every check passed. Spacing above it comes
 * from the result block it sits in.
 */
export function ResearchChecksNote({ note }: { readonly note: ResearchChecksNoteModel | null }) {
  if (!note || note.problems.length === 0) {
    return null;
  }
  return (
    <div
      className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm"
      role="status"
      data-testid="research-checks-note"
      data-problems={note.problems.join(" ")}
    >
      <p className="font-medium text-[var(--text)]">{t("research.checks.title")}</p>
      <ul
        className="mt-1.5 list-disc space-y-0.5 pl-5 text-[var(--text-2)]"
        aria-label={t("research.checks.listAria")}
        data-testid="research-checks-problems"
      >
        {note.problems.map((problem) => (
          <li key={problem} data-testid={`research-checks-${problem}`}>
            {t(PROBLEM_KEY[problem])}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-[var(--text-2)]">{t("research.checks.hint")}</p>
    </div>
  );
}
