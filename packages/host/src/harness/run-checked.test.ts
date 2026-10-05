import { describe, expect, it, vi } from "vitest";
import type { CheckVerdict, OutputCheck } from "@agentforge/core/harness";
import { formatRepairNote, runChecked, type FailedVerdict } from "./run-checked";

const HEADER =
  "The output did not pass these checks. Fix every item and return the whole corrected output, not a diff.";

function failed(check: string, error = `${check} error`): FailedVerdict {
  return { ok: false, check, error, why: `${check} why`, fix: `${check} fix` };
}

/** A check that passes when the output contains `needle`, and fails as `failed(id)` otherwise. */
function contains(id: string, needle: string): OutputCheck<string> {
  return { id, run: (output) => (output.includes(needle) ? { ok: true } : failed(id)) };
}

/** `produce` that returns the queued outputs in order and records every (note, round) it was given. */
function producer(outputs: readonly string[]) {
  const calls: Array<{ note: string | null; round: number }> = [];
  const produce = async (note: string | null, round: number): Promise<string> => {
    calls.push({ note, round });
    return outputs[calls.length - 1] ?? "";
  };
  return { produce, calls };
}

describe("formatRepairNote", () => {
  it("writes ERROR, WHY and FIX for each failure under one header", () => {
    expect(formatRepairNote([failed("units"), failed("totals", "Totals differ")])).toBe(
      [
        HEADER,
        "ERROR: units error\nWHY: units why\nFIX: units fix",
        "ERROR: Totals differ\nWHY: totals why\nFIX: totals fix",
      ].join("\n\n"),
    );
  });

  it("is empty when nothing failed", () => {
    expect(formatRepairNote([])).toBe("");
  });
});

describe("runChecked", () => {
  it("passes first time with zero repair rounds and one produce call", async () => {
    const { produce, calls } = producer(["alpha beta"]);
    const result = await runChecked({
      produce,
      checks: [contains("a", "alpha"), contains("b", "beta")],
      repairRounds: 2,
    });
    expect(result).toEqual({ output: "alpha beta", verdicts: [{ ok: true }, { ok: true }], rounds: 0, passed: true });
    expect(calls).toEqual([{ note: null, round: 0 }]);
  });

  it("repairs once with the exact note, then passes", async () => {
    const { produce, calls } = producer(["alpha", "alpha beta"]);
    const onRound = vi.fn();
    const result = await runChecked({
      produce,
      checks: [contains("a", "alpha"), contains("b", "beta")],
      repairRounds: 2,
      onRound,
    });
    expect(calls).toEqual([
      { note: null, round: 0 },
      { note: `${HEADER}\n\nERROR: b error\nWHY: b why\nFIX: b fix`, round: 1 },
    ]);
    expect(onRound).toHaveBeenCalledTimes(1);
    expect(onRound).toHaveBeenCalledWith(1, [failed("b")]);
    expect(result).toEqual({ output: "alpha beta", verdicts: [{ ok: true }, { ok: true }], rounds: 1, passed: true });
  });

  it("runs every check so the note lists every failure, in check order", async () => {
    const { produce, calls } = producer(["nothing", "alpha beta"]);
    await runChecked({ produce, checks: [contains("a", "alpha"), contains("b", "beta")], repairRounds: 1 });
    expect(calls[1]?.note).toBe(
      [HEADER, "ERROR: a error\nWHY: a why\nFIX: a fix", "ERROR: b error\nWHY: b why\nFIX: b fix"].join("\n\n"),
    );
  });

  it("never repairs when repairRounds is 0", async () => {
    const { produce, calls } = producer(["nothing", "alpha"]);
    const onRound = vi.fn();
    const result = await runChecked({ produce, checks: [contains("a", "alpha")], repairRounds: 0, onRound });
    expect(calls).toEqual([{ note: null, round: 0 }]);
    expect(onRound).not.toHaveBeenCalled();
    expect(result).toEqual({ output: "nothing", verdicts: [failed("a")], rounds: 0, passed: false });
  });

  it("returns passed false and the last output when the rounds are spent", async () => {
    const { produce, calls } = producer(["one", "two", "three", "four"]);
    const result = await runChecked({ produce, checks: [contains("a", "alpha")], repairRounds: 2 });
    expect(calls.map((call) => call.round)).toEqual([0, 1, 2]);
    expect(result).toEqual({ output: "three", verdicts: [failed("a")], rounds: 2, passed: false });
  });

  it("treats a check that throws as a failure with a fixed message", async () => {
    const throwing: OutputCheck<string> = {
      id: "boom",
      run: () => {
        throw new Error("secret client figure 1,250,000");
      },
    };
    const { produce } = producer(["alpha"]);
    const result = await runChecked({ produce, checks: [throwing, contains("a", "alpha")], repairRounds: 0 });
    const expected: CheckVerdict = {
      ok: false,
      check: "boom",
      error: 'Check "boom" could not run.',
      why: "The check failed on its own, so this output could not be confirmed.",
      fix: "Return the whole output again, complete and in the required format.",
    };
    expect(result.verdicts).toEqual([expected, { ok: true }]);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result.verdicts)).not.toContain("secret");
  });

  it("treats a rejecting async check as a failure and repairs it", async () => {
    let runs = 0;
    const flaky: OutputCheck<string> = {
      id: "flaky",
      run: async () => {
        runs += 1;
        if (runs === 1) {
          throw new Error("transient");
        }
        return { ok: true };
      },
    };
    const { produce, calls } = producer(["first", "second"]);
    const result = await runChecked({ produce, checks: [flaky], repairRounds: 1 });
    expect(calls[1]?.note).toBe(
      `${HEADER}\n\nERROR: Check "flaky" could not run.\nWHY: The check failed on its own, so this output could not be confirmed.\nFIX: Return the whole output again, complete and in the required format.`,
    );
    expect(result).toEqual({ output: "second", verdicts: [{ ok: true }], rounds: 1, passed: true });
  });

  it("throws the signal's reason when aborted between rounds, without another produce call", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by the owner");
    const { produce, calls } = producer(["nothing", "alpha"]);
    await expect(
      runChecked({
        produce,
        checks: [contains("a", "alpha")],
        repairRounds: 2,
        signal: controller.signal,
        onRound: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(calls).toEqual([{ note: null, round: 0 }]);
  });

  it("does not call produce when the signal is already aborted", async () => {
    const reason = new Error("already cancelled");
    const { produce, calls } = producer(["alpha"]);
    await expect(runChecked({ produce, checks: [], repairRounds: 1, signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(calls).toEqual([]);
  });

  it("throws the abort instead of a failure verdict when a check throws after the signal aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-check");
    const check: OutputCheck<string> = {
      id: "slow",
      run: () => {
        controller.abort(reason);
        throw new Error("aborted");
      },
    };
    const { produce } = producer(["alpha"]);
    await expect(runChecked({ produce, checks: [check], repairRounds: 1, signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("passes with no checks", async () => {
    const { produce } = producer(["anything"]);
    expect(await runChecked({ produce, checks: [], repairRounds: 3 })).toEqual({
      output: "anything",
      verdicts: [],
      rounds: 0,
      passed: true,
    });
  });
});
