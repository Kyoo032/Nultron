/**
 * Coverage: did the model answer for everything it was asked about?
 *
 * A required item counts as covered when the model returned an entry for it, even one that says the
 * documents do not state it: "not stated" is an answer, silence is the gap. The same check serves a
 * list of required fields (facts) and a list of required files (what was read). Pure; no model call.
 */

export type CoverageItem = { readonly id: string };

export type CoverageGaps = {
  /** Required ids with no entry, in the order required, each once. */
  readonly missing: readonly string[];
  /** Ids that have more than one entry, in the order they first repeat. */
  readonly duplicated: readonly string[];
  /** Entries whose id was not asked for, in the order given, each once. */
  readonly unexpected: readonly string[];
};

function keyOf(id: string): string {
  return id.trim().toLowerCase();
}

/** The gaps between what was required and what came back. Ids are compared ignoring case and edge spaces. */
export function coverageGaps(required: readonly string[], items: readonly CoverageItem[]): CoverageGaps {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const duplicated: string[] = [];
  for (const item of items) {
    const key = keyOf(item.id);
    if (seen.has(key) && !repeated.has(key)) {
      repeated.add(key);
      duplicated.push(item.id.trim());
    }
    seen.add(key);
  }
  const wanted = new Set(required.map(keyOf));
  const missing = [...new Set(required.map((id) => id.trim()))].filter((id) => !seen.has(keyOf(id)));
  const unexpected = [...new Set(items.filter((item) => !wanted.has(keyOf(item.id))).map((item) => item.id.trim()))];
  return { missing, duplicated, unexpected };
}

/** True when anything is missing, repeated or unexpected. */
export function hasCoverageGaps(gaps: CoverageGaps): boolean {
  return gaps.missing.length > 0 || gaps.duplicated.length > 0 || gaps.unexpected.length > 0;
}
