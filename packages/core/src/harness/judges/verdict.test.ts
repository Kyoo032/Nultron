import { describe, expect, it } from "vitest";
import type { CheckVerdict, OutputCheck } from "../spec";
import { matchQuote } from "./quote";
import {
  type ItemJudgement,
  type JudgeWords,
  failingIds,
  judgeCheck,
  outcomeOf,
  outcomesById,
  summarizeVerdicts,
} from "./verdict";

const WORDS: JudgeWords = {
  error: "These facts quote the documents wrongly:",
  why: "A fact is only worth showing when its quote can be found in the document it names.",
  fix: "For {items}, copy the quote exactly from the document, or return the fact as missing.",
};

const ok = (id: string): ItemJudgement => ({ id, ok: true });
const bad = (id: string, problem: string): ItemJudgement => ({ id, ok: false, problem });

describe("judgeCheck", () => {
  it("passes when no item failed, including when there are no items", async () => {
    const check = judgeCheck<string[]>("legal-quotes", (output) => output.map(ok), WORDS);
    expect(check.id).toBe("legal-quotes");
    expect(await check.run(["a", "b"])).toEqual({ ok: true });
    expect(await check.run([])).toEqual({ ok: true });
  });

  it("fails with the check id and an ERROR / WHY / FIX that names the failing items", async () => {
    const check = judgeCheck<string[]>(
      "legal-quotes",
      (output) => output.map((id) => (id === "term" ? bad(id, 'quote "twelve months" is not in S1') : ok(id))),
      WORDS,
    );
    const verdict = await check.run(["parties", "term"]);
    expect(verdict).toEqual({
      ok: false,
      check: "legal-quotes",
      error: 'These facts quote the documents wrongly: term: quote "twelve months" is not in S1.',
      why: WORDS.why,
      fix: "For term, copy the quote exactly from the document, or return the fact as missing.",
    });
  });

  it("lists several failing items together", async () => {
    const check = judgeCheck<string[]>("c", (output) => output.map((id) => bad(id, "wrong")), WORDS);
    const verdict = await check.run(["a", "b"]);
    expect(verdict).toMatchObject({ ok: false, error: `${WORDS.error} a: wrong; b: wrong.` });
    expect(verdict.ok === false && verdict.fix).toBe(
      "For a, b, copy the quote exactly from the document, or return the fact as missing.",
    );
  });

  it("falls back to a plain word when a failing item names no problem", async () => {
    const check = judgeCheck<string[]>("c", (output) => output.map((id) => ({ id, ok: false })), WORDS);
    const verdict = await check.run(["a"]);
    expect(verdict.ok === false && verdict.error).toBe(`${WORDS.error} a: failed.`);
  });

  it("keeps the repair note short when many items fail", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `f${index + 1}`);
    const check = judgeCheck<string[]>("c", (output) => output.map((id) => bad(id, "wrong")), WORDS);
    const verdict = await check.run(ids);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error).toContain("f1: wrong");
      expect(verdict.error).toContain("and 18 more");
      expect(verdict.error).not.toContain("f30");
      expect(verdict.fix).toContain("f1");
      expect(verdict.fix).toContain("and 18 more");
    }
  });

  it("takes a judge that is async", async () => {
    const check = judgeCheck<string[]>("c", async (output) => output.map((id) => bad(id, "late")), WORDS);
    expect((await check.run(["a"])).ok).toBe(false);
  });

  it("lets the caller see every judgement each time the check runs", async () => {
    const seen: (readonly ItemJudgement[])[] = [];
    const check = judgeCheck<string[]>(
      "c",
      (output) => output.map((id) => (id === "x" ? bad(id, "no") : ok(id))),
      WORDS,
      { onJudged: (judgements) => seen.push(judgements) },
    );
    await check.run(["a", "x"]);
    await check.run(["a"]);
    expect(seen.map((judgements) => failingIds(judgements))).toEqual([["x"], []]);
  });

  it("lets a judge's own throw reach the runner, which counts it as a failed check", async () => {
    const check = judgeCheck<string[]>(
      "c",
      () => {
        throw new Error("boom");
      },
      WORDS,
    );
    await expect(Promise.resolve().then(() => check.run([]))).rejects.toThrow("boom");
  });

  it("is an OutputCheck as the harness spec defines it", () => {
    const check: OutputCheck<string[]> = judgeCheck<string[]>("c", (output) => output.map(ok), WORDS);
    expect(typeof check.run).toBe("function");
  });
});

describe("failingIds", () => {
  it("lists failing ids once each, in order", () => {
    expect(failingIds([ok("a"), bad("b", "x"), bad("c", "y"), bad("b", "z")])).toEqual(["b", "c"]);
  });
});

describe("outcomeOf", () => {
  it("is verified when every judgement passed", () => {
    expect(outcomeOf([ok("a"), ok("a")])).toBe("verified");
  });

  it("is unverified when any judgement failed", () => {
    expect(outcomeOf([ok("a"), bad("a", "x")])).toBe("unverified");
  });

  it("is not-in-sources when the item is absent and nothing failed", () => {
    expect(outcomeOf([{ id: "a", ok: true, absent: true }])).toBe("not-in-sources");
    expect(outcomeOf([{ id: "a", ok: true, absent: true }, ok("a")])).toBe("not-in-sources");
  });

  it("lets a failure beat absence", () => {
    expect(outcomeOf([{ id: "a", ok: true, absent: true }, bad("a", "x")])).toBe("unverified");
  });

  it("is unverified when nothing was checked at all", () => {
    expect(outcomeOf([])).toBe("unverified");
  });
});

describe("outcomesById", () => {
  it("groups judgements from several checks by item", () => {
    const outcomes = outcomesById([
      ok("parties"),
      ok("term"),
      { id: "payment", ok: true, absent: true },
      bad("term", "not found"),
      ok("parties"),
    ]);
    expect([...outcomes.entries()]).toEqual([
      ["parties", "verified"],
      ["term", "unverified"],
      ["payment", "not-in-sources"],
    ]);
  });
});

describe("summarizeVerdicts", () => {
  const verdicts: CheckVerdict[] = [
    { ok: true },
    {
      ok: false,
      check: "legal-quotes",
      error: 'term: quote "twelve months" is not in S1.',
      why: "secret why",
      fix: "secret fix",
    },
  ];

  it("keeps ids and pass/fail only", () => {
    const summary = summarizeVerdicts([{ id: "legal-shape" }, { id: "legal-quotes" }], {
      verdicts,
      rounds: 1,
      passed: false,
    });
    expect(summary).toEqual({
      passed: false,
      rounds: 1,
      verdicts: [
        { check: "legal-shape", ok: true },
        { check: "legal-quotes", ok: false },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(/twelve|secret/);
  });

  it("counts a check with no verdict as failed", () => {
    expect(
      summarizeVerdicts([{ id: "a" }, { id: "b" }], { verdicts: [{ ok: true }], rounds: 0, passed: false }).verdicts,
    ).toEqual([
      { check: "a", ok: true },
      { check: "b", ok: false },
    ]);
  });
});

describe("round trip through a runner (mirrors host runChecked)", () => {
  type Fact = { field: string; quote: string };

  const SOURCES = [{ id: "S1", text: "The Term of this Agreement is twelve (12) months from the Effective Date." }];

  async function runChecked<T>(options: {
    produce: (note: string | null, round: number) => Promise<T>;
    checks: readonly OutputCheck<T>[];
    repairRounds: number;
    onRound?: (round: number, failures: Extract<CheckVerdict, { ok: false }>[]) => void;
  }) {
    let note: string | null = null;
    let round = 0;
    for (;;) {
      const output = await options.produce(note, round);
      const verdicts: CheckVerdict[] = [];
      for (const check of options.checks) {
        verdicts.push(await check.run(output));
      }
      const failures = verdicts.filter((verdict): verdict is Extract<CheckVerdict, { ok: false }> => !verdict.ok);
      if (failures.length === 0 || round >= options.repairRounds) {
        return { output, verdicts, rounds: round, passed: failures.length === 0 };
      }
      round += 1;
      options.onRound?.(round, failures);
      note = failures
        .map((failure) => `ERROR: ${failure.error}\nWHY: ${failure.why}\nFIX: ${failure.fix}`)
        .join("\n\n");
    }
  }

  const judgeQuotes = (facts: readonly Fact[]): ItemJudgement[] =>
    facts.map((fact) =>
      matchQuote(fact.quote, SOURCES)
        ? ok(fact.field)
        : bad(fact.field, `its quote "${fact.quote}" is not in the documents`),
    );

  it("repairs a fact whose quote is not in the document, then gives every fact a status", async () => {
    const seenFailing: string[][] = [];
    const check = judgeCheck<readonly Fact[]>("legal-quotes", judgeQuotes, WORDS, {
      onJudged: (judgements) => seenFailing.push(failingIds(judgements)),
    });
    const drafts: Fact[][] = [
      [
        { field: "term", quote: "a term of twelve months" },
        { field: "effective-date", quote: "from the Effective Date" },
      ],
      [
        { field: "term", quote: "twelve (12) months from the Effective Date" },
        { field: "effective-date", quote: "from the Effective Date" },
      ],
    ];
    const notes: (string | null)[] = [];
    const result = await runChecked({
      produce: async (note, round) => {
        notes.push(note);
        return drafts[round] as Fact[];
      },
      checks: [check],
      repairRounds: 1,
    });

    expect(result.passed).toBe(true);
    expect(result.rounds).toBe(1);
    expect(seenFailing).toEqual([["term"], []]);
    expect(notes[0]).toBeNull();
    expect(notes[1]).toContain("ERROR: These facts quote the documents wrongly: term:");
    expect(notes[1]).toContain("WHY:");
    expect(notes[1]).toContain("FIX: For term, copy the quote exactly");

    const outcomes = outcomesById(judgeQuotes(result.output));
    expect([...outcomes.entries()]).toEqual([
      ["term", "verified"],
      ["effective-date", "verified"],
    ]);
  });

  it("marks what still fails after the last round as unverified instead of dropping it", async () => {
    const check = judgeCheck<readonly Fact[]>("legal-quotes", judgeQuotes, WORDS);
    const stubborn: Fact[] = [
      { field: "term", quote: "twenty-four months" },
      { field: "effective-date", quote: "from the Effective Date" },
    ];
    const result = await runChecked({ produce: async () => stubborn, checks: [check], repairRounds: 1 });
    expect(result.passed).toBe(false);
    expect(result.rounds).toBe(1);
    expect(summarizeVerdicts([check], result)).toEqual({
      passed: false,
      rounds: 1,
      verdicts: [{ check: "legal-quotes", ok: false }],
    });
    const outcomes = outcomesById(judgeQuotes(result.output));
    expect(outcomes.get("term")).toBe("unverified");
    expect(outcomes.get("effective-date")).toBe("verified");
  });
});
