import {
  DOC_VERSION_CAP,
  type DocVersionAuthor,
  type DocVersionCap,
  type SectionAuthor,
  type SectionAuthors,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type HistoryRow = {
  readonly version: number;
  readonly createdAt: number;
  readonly changedSectionIds: readonly string[];
  readonly author: DocVersionAuthor;
  readonly folded: SectionAuthors;
};

export type PrunePlan = {
  readonly drop: readonly number[];
  readonly foldInto: number;
  readonly folded: SectionAuthors;
};

function later(current: SectionAuthor | undefined, candidate: SectionAuthor): SectionAuthor {
  return current === undefined || candidate.version > current.version ? candidate : current;
}

export function lastChanges(rows: readonly HistoryRow[]): SectionAuthors {
  const result: Record<string, SectionAuthor> = {};
  for (const row of rows) {
    for (const [id, entry] of Object.entries(row.folded)) {
      result[id] = later(result[id], entry);
    }
    for (const id of row.changedSectionIds) {
      result[id] = later(result[id], { version: row.version, author: row.author });
    }
  }
  return result;
}

export function planPrune(
  rows: readonly HistoryRow[],
  now: number,
  protectedVersions: ReadonlySet<number>,
  cap: DocVersionCap = DOC_VERSION_CAP,
): PrunePlan | null {
  const newestFirst = [...rows].sort((a, b) => b.version - a.version);
  const cutoff = now - cap.keepDays * DAY_MS;
  const kept = newestFirst.filter(
    (row, index) =>
      index < Math.max(cap.keepNewest, 1) || row.createdAt >= cutoff || protectedVersions.has(row.version),
  );
  const keptVersions = new Set(kept.map((row) => row.version));
  const dropped = newestFirst.filter((row) => !keptVersions.has(row.version));
  if (dropped.length === 0) {
    return null;
  }
  const oldestKept = kept.reduce((oldest, row) => (row.version < oldest.version ? row : oldest));
  return {
    drop: dropped.map((row) => row.version).sort((a, b) => a - b),
    foldInto: oldestKept.version,
    folded: lastChanges([...dropped, { ...oldestKept, changedSectionIds: [] }]),
  };
}
