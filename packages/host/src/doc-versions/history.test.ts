import { describe, expect, it } from "vitest";
import { lastChanges, planPrune, type HistoryRow } from "./history";
import { DOC_VERSION_CAP, type DocVersionAuthor } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15);
const ana: DocVersionAuthor = { kind: "person", userId: "ana" };
const bot: DocVersionAuthor = { kind: "agent", agentId: "documents", askedByUserId: "ana" };

function rows(
  count: number,
  ageDays: (version: number) => number,
  changed: (version: number) => string[],
): HistoryRow[] {
  return Array.from({ length: count }, (_, index) => {
    const version = index + 1;
    return {
      version,
      createdAt: NOW - ageDays(version) * DAY,
      changedSectionIds: changed(version),
      author: version % 2 === 0 ? bot : ana,
      folded: {},
    };
  });
}

function afterPlan(history: HistoryRow[], plan: ReturnType<typeof planPrune>): HistoryRow[] {
  if (plan === null) {
    return history;
  }
  return history
    .filter((row) => !plan.drop.includes(row.version))
    .map((row) => (row.version === plan.foldInto ? { ...row, folded: plan.folded } : row));
}

describe("the version cap: the newest 50 plus every version from the last 30 days", () => {
  it("keeps the newest 50 when every version is old, and folds the rest into the oldest kept one", () => {
    const history = rows(
      60,
      () => 40,
      () => ["s1"],
    );
    const plan = planPrune(history, NOW, new Set());
    expect(plan?.drop).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan?.foldInto).toBe(11);
  });

  it("keeps every version younger than 30 days even past 50", () => {
    const history = rows(
      70,
      (version) => (version <= 5 ? 45 : 29),
      () => ["s1"],
    );
    expect(planPrune(history, NOW, new Set())?.drop).toEqual([1, 2, 3, 4, 5]);
  });

  it("prunes nothing at or under the cap", () => {
    expect(
      planPrune(
        rows(
          DOC_VERSION_CAP.keepNewest,
          () => 400,
          () => ["s1"],
        ),
        NOW,
        new Set(),
      ),
    ).toBeNull();
    expect(
      planPrune(
        rows(
          DOC_VERSION_CAP.keepNewest + 1,
          () => 400,
          () => ["s1"],
        ),
        NOW,
        new Set(),
      )?.drop,
    ).toEqual([1]);
  });

  it("never prunes a protected base version, and folds into it when it is the oldest kept", () => {
    const history = rows(
      60,
      () => 40,
      () => ["s1"],
    );
    const plan = planPrune(history, NOW, new Set([3]));
    expect(plan?.drop).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan?.foldInto).toBe(3);
  });

  it("reads the numbers from the cap it is given", () => {
    const history = rows(
      5,
      () => 2,
      () => ["s1"],
    );
    expect(planPrune(history, NOW, new Set(), { keepNewest: 2, keepDays: 1 })?.drop).toEqual([1, 2, 3]);
  });
});

describe("folding keeps who last changed each section", () => {
  it("gives the same last change per section before and after a prune", () => {
    const history = rows(
      60,
      () => 40,
      (version) => (version === 2 ? ["intro", "close"] : version === 7 ? ["close"] : ["body"]),
    );
    const before = lastChanges(history);
    const after = lastChanges(afterPlan(history, planPrune(history, NOW, new Set())));
    expect(before).toEqual({
      intro: { version: 2, author: bot },
      close: { version: 7, author: ana },
      body: { version: 60, author: bot },
    });
    expect(after).toEqual(before);
  });

  it("survives a second prune that drops the row the first one folded into", () => {
    const history = rows(
      60,
      () => 40,
      (version) => (version === 4 ? ["intro"] : ["body"]),
    );
    const once = afterPlan(history, planPrune(history, NOW, new Set()));
    const grown = [
      ...once,
      ...rows(
        70,
        () => 40,
        () => ["body"],
      ).slice(60),
    ];
    const twice = afterPlan(grown, planPrune(grown, NOW, new Set()));
    expect(twice.map((row) => row.version)[0]).toBe(21);
    expect(lastChanges(twice).intro).toEqual({ version: 4, author: bot });
  });
});
