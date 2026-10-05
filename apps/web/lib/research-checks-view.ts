/**
 * What the Research studio says about the checks the host ran on a dossier.
 *
 * The host (`packages/host/src/research-checks.ts`) puts a report on the job result and on the saved
 * dossier's `meta.checks`: `{ passed, rounds, verdicts, repairFailure? }`. A verdict that failed carries
 * the id of its check and English text written for the model. The page never shows that text. It reads
 * only the check ids, and the catalog says each one in the owner's language.
 *
 * The ids mirror `RESEARCH_CHECK_IDS` in the host; the renderer does not import the host.
 */

export type ResearchCheckProblem = "uncited" | "unknownSources" | "emptySections";

export type ResearchChecksNoteModel = { readonly problems: readonly ResearchCheckProblem[] };

const PROBLEM_BY_CHECK_ID: Readonly<Record<string, ResearchCheckProblem>> = {
  "research-findings-cited": "uncited",
  "research-citations-resolve": "unknownSources",
  "research-sections-filled": "emptySections",
};

/** The order the note lists them in: a missing source first, then a source nobody read, then a gap. */
const PROBLEM_ORDER: readonly ResearchCheckProblem[] = ["uncited", "unknownSources", "emptySections"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The note for a dossier's checks report, or null when nothing failed or the report cannot be read
 * (an older dossier has none). A report that says `passed` is never turned into a note, whatever its
 * verdicts hold.
 */
export function researchChecksNote(raw: unknown): ResearchChecksNoteModel | null {
  if (!isObject(raw) || raw.passed === true || !Array.isArray(raw.verdicts)) {
    return null;
  }
  const found = new Set<ResearchCheckProblem>();
  for (const verdict of raw.verdicts) {
    if (!isObject(verdict) || verdict.ok !== false || typeof verdict.check !== "string") {
      continue;
    }
    const problem = PROBLEM_BY_CHECK_ID[verdict.check];
    if (problem) {
      found.add(problem);
    }
  }
  const problems = PROBLEM_ORDER.filter((problem) => found.has(problem));
  return problems.length > 0 ? { problems } : null;
}
