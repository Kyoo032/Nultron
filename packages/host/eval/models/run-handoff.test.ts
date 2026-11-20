import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkRuntime, GATEWAY_PROVIDER_ID, type AgentRuntime, type RuntimeEvent } from "@agentforge/core";
import { resolveTier as coreResolveTier, type ModelTierId } from "@agentforge/core/tiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./args";
import { EvalRefusal } from "./credentials";
import {
  HANDOFF_PROMPTS,
  INDONESIAN_WORDS_MAX,
  buildPlan,
  canonicalWords,
  checkFirstTurn,
  checkSecondTurn,
  checkThirdTurn,
  indonesianWords,
  lastNumber,
  numbersIn,
  parseHandoffArgs,
  planText,
  runHandoffCommand,
  runTurn,
  scrubProviderEnv,
  staticTierIds,
  type HandoffArgs,
  type CandidateRecord,
  type HandoffDeps,
  type HandoffRuntime,
  type HandoffSummary,
  type TierResolver,
  type TurnRecord,
} from "./run-handoff";

let resultsDir = "";
beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "eval-models-handoff-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(resultsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const argsOf = (...flags: string[]) => parseHandoffArgs(["--delay-ms", "0", ...flags], resultsDir);

/**
 * The tier resolver the host wraps (`chooseTierRun`), rebuilt from the core walk so these tests need no
 * host database: the same lists, the catalogue's spelling, the Thinking choice each tier asks for.
 */
const resolveTier: TierResolver = (tier, ids) => {
  const byLower = new Map(ids.map((id) => [id.toLowerCase(), id]));
  const result = coreResolveTier(tier, {
    providers: [GATEWAY_PROVIDER_ID],
    listedAs: (_provider, candidate) => byLower.get(candidate.toLowerCase()),
    isDown: () => false,
  });
  if (!result.ok) {
    return null;
  }
  const reasoning =
    result.thinking === "off"
      ? { effort: "none" as const, explicit: true }
      : result.thinking === "deep"
        ? { effort: "high" as const, explicit: true }
        : { effort: "medium" as const, explicit: false };
  return { model: result.model, reasoning };
};

describe("parseHandoffArgs", () => {
  it("runs the hand-off by default", () => {
    const args = parseHandoffArgs([], "/results");
    expect(args).toMatchObject({
      handoff: true,
      allCandidates: false,
      refresh: false,
      dryRun: false,
      prices: true,
      timeoutMs: 120_000,
      delayMs: 500,
      resultsDir: "/results",
      help: false,
    });
  });

  it("--all-candidates alone replaces the hand-off, and --handoff adds it back", () => {
    expect(parseHandoffArgs(["--all-candidates"], "/r")).toMatchObject({ handoff: false, allCandidates: true });
    expect(parseHandoffArgs(["--all-candidates", "--handoff"], "/r")).toMatchObject({
      handoff: true,
      allCandidates: true,
    });
  });

  it("reads the numbers and the paths", () => {
    expect(
      parseHandoffArgs(
        ["--timeout-ms", "5000", "--delay-ms", "0", "--out", "/o", "--workspace", "w1", "--no-prices", "--refresh"],
        "/r",
      ),
    ).toMatchObject({ timeoutMs: 5000, delayMs: 0, resultsDir: "/o", workspace: "w1", prices: false, refresh: true });
  });

  it("refuses what it cannot read", () => {
    expect(() => parseHandoffArgs(["--nope"], "/r")).toThrow(UsageError);
    expect(() => parseHandoffArgs(["--timeout-ms", "0"], "/r")).toThrow(/whole number of at least 1/);
    expect(() => parseHandoffArgs(["--delay-ms", "-1"], "/r")).toThrow(UsageError);
    expect(() => parseHandoffArgs(["--dry-run", "--refresh"], "/r")).toThrow(/dry run calls nothing/);
  });
});

describe("Indonesian number words", () => {
  it.each([
    [1000, "seribu"],
    [1001, "seribu satu"],
    [2000, "dua ribu"],
    [4821, "empat ribu delapan ratus dua puluh satu"],
    [4822, "empat ribu delapan ratus dua puluh dua"],
    [4010, "empat ribu sepuluh"],
    [4011, "empat ribu sebelas"],
    [4012, "empat ribu dua belas"],
    [4100, "empat ribu seratus"],
    [4150, "empat ribu seratus lima puluh"],
    [9999, "sembilan ribu sembilan ratus sembilan puluh sembilan"],
    [10000, "sepuluh ribu"],
    [999999, "sembilan ratus sembilan puluh sembilan ribu sembilan ratus sembilan puluh sembilan"],
    [1000000, "satu juta"],
    [4821000, "empat juta delapan ratus dua puluh satu ribu"],
    [100000000, "seratus juta"],
    [2500000000, "dua miliar lima ratus juta"],
    [0, "nol"],
  ])("%i is %s", (n, words) => {
    expect(indonesianWords(n)).toBe(words);
  });

  it("refuses a number it cannot write", () => {
    expect(() => indonesianWords(-1)).toThrow(RangeError);
    expect(() => indonesianWords(1.5)).toThrow(RangeError);
    expect(() => indonesianWords(INDONESIAN_WORDS_MAX + 1)).toThrow(RangeError);
  });

  it("compares 'seribu' and 'satu ribu' as the same words, and ignores case and punctuation", () => {
    expect(canonicalWords("Seribu seratus sepuluh.")).toBe(canonicalWords("satu ribu satu ratus satu puluh"));
    expect(canonicalWords("  Empat-ribu, delapan RATUS ")).toBe("empat ribu delapan ratus");
  });
});

describe("reading numbers", () => {
  it("takes the last number and joins thousands separators", () => {
    expect(numbersIn("Sure, 4821.")).toEqual([4821]);
    expect(numbersIn("4,821")).toEqual([4821]);
    expect(numbersIn("4.821")).toEqual([4821]);
    expect(numbersIn("4821 + 1 = 4822")).toEqual([4821, 1, 4822]);
    expect(lastNumber("4821 + 1 = 4822")).toBe(4822);
    expect(lastNumber("no digits here")).toBeUndefined();
    expect(lastNumber("**4821**")).toBe(4821);
  });
});

describe("the three turn checks", () => {
  it("turn 1 passes on a four-digit number and carries it", () => {
    const result = checkFirstTurn("4821");
    expect(result.number).toBe(4821);
    expect(result.checks.every((check) => check.pass)).toBe(true);
  });

  it("turn 1 fails on an empty answer, a number that is not four digits, and no number at all", () => {
    expect(checkFirstTurn("").checks.find((c) => c.name === "answered")?.pass).toBe(false);
    const short = checkFirstTurn("482");
    expect(short.checks.find((c) => c.name === "four_digits")).toMatchObject({
      pass: false,
      detail: "482 is not four digits",
    });
    const long = checkFirstTurn("48210");
    expect(long.checks.find((c) => c.name === "four_digits")?.pass).toBe(false);
    expect(checkFirstTurn("seven").checks.find((c) => c.name === "four_digits")).toMatchObject({
      pass: false,
      detail: "no number in the answer",
    });
  });

  it("turn 2 passes on the previous number plus one, even across 9999 to 10000", () => {
    expect(checkSecondTurn("4822", 4821).checks.every((c) => c.pass)).toBe(true);
    expect(checkSecondTurn("10,000", 9999).checks.every((c) => c.pass)).toBe(true);
    expect(checkSecondTurn("4821 + 1 = 4822", 4821).checks.every((c) => c.pass)).toBe(true);
  });

  it("turn 2 fails when the sum is wrong, missing, or turn 1 gave nothing to add to", () => {
    const wrong = checkSecondTurn("4823", 4821);
    expect(wrong.checks.find((c) => c.name === "plus_one")).toMatchObject({
      pass: false,
      detail: "expected 4822 (4821 + 1), got 4823",
    });
    expect(checkSecondTurn("done", 4821).checks.find((c) => c.name === "plus_one")?.detail).toContain("got no number");
    expect(checkSecondTurn("4822", undefined).checks.find((c) => c.name === "plus_one")?.detail).toContain(
      "turn 1 gave no number",
    );
  });

  it("turn 3 passes on two lines that are the two numbers in words, in either order", () => {
    const forward = "empat ribu delapan ratus dua puluh satu\nempat ribu delapan ratus dua puluh dua";
    expect(checkThirdTurn(forward, 4821, 4822).checks.every((c) => c.pass)).toBe(true);
    const swapped = "Empat ribu delapan ratus dua puluh dua\r\nEmpat ribu delapan ratus dua puluh satu.";
    expect(checkThirdTurn(swapped, 4821, 4822).checks.every((c) => c.pass)).toBe(true);
    const labelled =
      "1. 4821: empat ribu delapan ratus dua puluh satu\n2. 4822: empat ribu delapan ratus dua puluh dua\n";
    expect(checkThirdTurn(labelled, 4821, 4822).checks.every((c) => c.pass)).toBe(true);
    expect(checkThirdTurn("seribu\nseribu satu", 1000, 1001).checks.every((c) => c.pass)).toBe(true);
  });

  it("turn 3 checks a large answer instead of throwing, inside and past the writable range", () => {
    // A reply that ignores "four digits" used to crash the eval via indonesianWords' RangeError.
    const large = checkThirdTurn(
      "satu juta dua ratus tiga puluh empat ribu lima ratus enam puluh tujuh\nsatu juta dua ratus tiga puluh empat ribu lima ratus enam puluh delapan",
      1234567,
      1234568,
    );
    expect(large.checks.every((c) => c.pass)).toBe(true);
    const huge = checkThirdTurn("two lines\nof words", INDONESIAN_WORDS_MAX + 1, INDONESIAN_WORDS_MAX + 2);
    const words = huge.checks.find((c) => c.name === "words");
    expect(words?.pass).toBe(false);
    expect(words?.detail).toContain(`${INDONESIAN_WORDS_MAX + 1} (too large to write as words)`);
    expect(words?.detail).toContain(`${INDONESIAN_WORDS_MAX + 2} (too large to write as words)`);
  });

  it("turn 3 does not mistake 4820 for the shorter match inside 4821", () => {
    // Both lines say 4821: the line for 4820 is missing even though "...dua puluh" sits inside 4821's words.
    const twice = "empat ribu delapan ratus dua puluh satu\nempat ribu delapan ratus dua puluh satu";
    const result = checkThirdTurn(twice, 4820, 4821);
    expect(result.checks.find((c) => c.name === "words")).toMatchObject({ pass: false });
    expect(result.checks.find((c) => c.name === "words")?.detail).toContain("4820");
  });

  it("turn 3 fails on the wrong line count, English words, one number only, or no earlier numbers", () => {
    const three = "empat ribu delapan ratus dua puluh satu\nempat ribu delapan ratus dua puluh dua\nterima kasih";
    expect(checkThirdTurn(three, 4821, 4822).checks.find((c) => c.name === "two_lines")).toMatchObject({
      pass: false,
      detail: "expected 2 lines, got 3",
    });
    expect(checkThirdTurn("4821\n4822", 4821, 4822).checks.find((c) => c.name === "words")?.pass).toBe(false);
    expect(
      checkThirdTurn("four thousand\nfive thousand", 4821, 4822).checks.find((c) => c.name === "words")?.pass,
    ).toBe(false);
    const one = checkThirdTurn("empat ribu delapan ratus dua puluh satu", 4821, 4822);
    expect(one.checks.find((c) => c.name === "two_lines")?.pass).toBe(false);
    expect(one.checks.find((c) => c.name === "words")?.detail).toContain("4822");
    expect(checkThirdTurn("a\nb", undefined, 4822).checks.find((c) => c.name === "words")?.detail).toContain(
      "no number",
    );
    expect(checkThirdTurn("", 4821, 4822).checks.find((c) => c.name === "answered")?.pass).toBe(false);
  });
});

describe("buildPlan", () => {
  const LISTED = ["deepseek-v4-1-flash", "GPT-6-Luna", "claude-opus-5-5", "gpt-6-astra"];

  it("plans a hand-off of two conversations and six calls", () => {
    const plan = buildPlan({
      catalogIds: LISTED,
      source: "saved",
      resolve: resolveTier,
      handoff: true,
      allCandidates: false,
    });
    expect(plan.orders.map((order) => order.tiers)).toEqual([
      ["fast", "reasoning", "daily"],
      ["daily", "reasoning", "fast"],
    ]);
    expect(plan.handoffCalls).toBe(6);
    expect(plan.candidateCalls).toBe(0);
    expect(plan.catalogCount).toBe(4);
  });

  it("resolves each tier from the lists against the catalogue, in the catalogue's spelling", () => {
    const plan = buildPlan({
      catalogIds: LISTED,
      source: "saved",
      resolve: resolveTier,
      handoff: true,
      allCandidates: false,
    });
    const byTier = Object.fromEntries(plan.tiers.map((tier) => [tier.tier, tier]));
    expect(byTier.fast).toMatchObject({ model: "deepseek-v4-1-flash", wire: "chat_completions", thinking: "off" });
    expect(byTier.fast?.reasoning).toEqual({ effort: "none", explicit: true });
    expect(byTier.reasoning).toMatchObject({ model: "claude-opus-5-5", wire: "anthropic_messages", thinking: "deep" });
    expect(byTier.reasoning?.reasoning).toEqual({ effort: "high", explicit: true });
    expect(byTier.daily).toMatchObject({ model: "GPT-6-Luna", thinking: "default" });
    expect(byTier.daily?.reasoning.explicit).toBe(false);
  });

  it("counts one call per listed candidate and marks the unlisted ones", () => {
    const plan = buildPlan({
      catalogIds: LISTED,
      source: "saved",
      resolve: resolveTier,
      handoff: false,
      allCandidates: true,
    });
    expect(plan.orders).toEqual([]);
    expect(plan.handoffCalls).toBe(0);
    const listed = plan.tiers.flatMap((tier) => tier.candidates.filter((candidate) => candidate.listed));
    expect(plan.candidateCalls).toBe(listed.length);
    expect(plan.candidateCalls).toBeGreaterThan(0);
    const reasoning = plan.tiers.find((tier) => tier.tier === "reasoning");
    expect(reasoning?.candidates.filter((candidate) => !candidate.listed).length).toBeGreaterThan(0);
    expect(reasoning?.candidates.find((candidate) => candidate.requested === "claude-opus-5-5")).toMatchObject({
      listed: true,
      model: "claude-opus-5-5",
    });
  });

  it("plans against the static tier lists when there is no catalogue, taking every candidate as listed", () => {
    const plan = buildPlan({
      catalogIds: null,
      source: "static",
      resolve: resolveTier,
      handoff: true,
      allCandidates: true,
    });
    expect(plan.source).toBe("static");
    expect(plan.catalogCount).toBeNull();
    for (const tier of plan.tiers) {
      expect(tier.model).toBe(tier.candidates[0]?.model);
      expect(tier.candidates.every((candidate) => candidate.listed)).toBe(true);
    }
    expect(staticTierIds().length).toBeGreaterThan(5);
  });

  it("keeps the Thinking choice of a tier that resolves to nothing", () => {
    const plan = buildPlan({
      catalogIds: ["something-else"],
      source: "saved",
      resolve: resolveTier,
      handoff: true,
      allCandidates: false,
    });
    const reasoning = plan.tiers.find((tier) => tier.tier === "reasoning");
    expect(reasoning).toMatchObject({ model: null, wire: null });
    expect(reasoning?.reasoning).toEqual({ effort: "high", explicit: true });
  });
});

describe("planText (the dry-run output)", () => {
  const planFor = (catalogIds: string[] | null, flags: string[] = []) => {
    const args = argsOf("--dry-run", ...flags);
    const plan = buildPlan({
      catalogIds,
      source: catalogIds ? "saved" : "static",
      resolve: resolveTier,
      handoff: args.handoff,
      allCandidates: args.allCandidates,
    });
    return planText({ dataDir: "/desk", plan, args, probedAt: "2026-11-10T09:00:00.000Z" });
  };

  it("says it plans against the static lists when no catalogue is saved", () => {
    const text = planFor(null);
    expect(text).toContain("a dry run sends nothing");
    expect(text).toContain("none saved on this desk, so this plans against the static tier lists");
    expect(text).toContain("fast       -> ");
    expect(text).toContain("forward  fast -> reasoning -> daily");
    expect(text).toContain("reverse  daily -> reasoning -> fast");
    expect(text).toContain("calls: 6 hand-off (fewer if a turn cannot be answered) + 0 candidate = 6");
  });

  it("names the saved catalogue, and lists candidates with the unlisted ones marked", () => {
    const text = planFor(["claude-opus-5-5", "gpt-6-astra"], ["--all-candidates", "--handoff"]);
    expect(text).toContain("saved on the desk, 2 models, probed 2026-11-10T09:00:00.000Z");
    expect(text).toContain("deepseek-v4-pro (not listed: skipped)");
    expect(text).toContain("daily      -> NOTHING");
    expect(text).toMatch(/calls: 6 hand-off .* \+ 2 candidate = 8/);
  });
});

describe("scrubProviderEnv", () => {
  it("removes the provider variables and reports their names, never their values", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-leak",
      ANTHROPIC_BASE_URL: "https://elsewhere.test",
      AGENTFORGE_DATA_DIR: "/desk",
      PATH: "/bin",
    };
    const removed = scrubProviderEnv(env);
    expect(removed.sort()).toEqual(["ANTHROPIC_BASE_URL", "OPENAI_API_KEY"]);
    expect(JSON.stringify(removed)).not.toContain("sk-leak");
    expect(env).toEqual({ AGENTFORGE_DATA_DIR: "/desk", PATH: "/bin" });
  });
});

// ---------------------------------------------------------------------------------------------------
// The command, against a fake runtime
// ---------------------------------------------------------------------------------------------------

type Call = {
  model: string;
  effort: string;
  explicit: boolean | undefined;
  thinking: boolean | undefined;
  history: string[];
};

type Reply = { text?: string; fail?: string; usage?: { inputTokens: number; outputTokens: number } };

/**
 * A runtime that plays the model. `script` sees which model was asked and the history as text, and gives
 * the answer, or a failure (the way the real runtime does it: a `run.failed` event, then a throw).
 */
function fakeRuntime(script: (call: Call) => Reply): { sender: HandoffRuntime; calls: Call[] } {
  const calls: Call[] = [];
  const runtime: AgentRuntime = {
    async execute(input) {
      const call: Call = {
        model: input.version.model,
        effort: String(input.reasoningEffort),
        explicit: input.reasoningEffortExplicit,
        thinking: input.thinking,
        history: input.history.map(
          (turn) => `${turn.role}: ${turn.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
        ),
      };
      calls.push(call);
      const reply = script(call);
      const emit = async (event: RuntimeEvent) => {
        await input.onEvent(event);
      };
      await emit({ type: "run.started", runId: input.runId });
      await emit({ type: "run.probing", model: call.model, attempt: 1, attempts: 3, message: "" });
      if (reply.fail !== undefined) {
        await emit({ type: "run.failed", message: reply.fail });
        throw new Error(reply.fail);
      }
      await emit({ type: "assistant.thinking", text: "hmm" });
      await emit({ type: "assistant.delta", text: reply.text ?? "" });
      await emit({
        type: "run.completed",
        runId: input.runId,
        usage: { model: call.model, ...(reply.usage ?? { inputTokens: 20, outputTokens: 5 }) },
      });
    },
  };
  return {
    sender: { host: "gateway.example.test", runtime, redact: (text) => text.replaceAll("SECRET-KEY", "[key]") },
    calls,
  };
}

/** Turn 1 picks 4821, turn 2 adds one, turn 3 writes both numbers: what a model that follows the script does. */
function wellBehaved(call: Call): Reply {
  const user = call.history.filter((line) => line.startsWith("user:")).length;
  if (user === 1) {
    return { text: "4821" };
  }
  if (user === 2) {
    return { text: "4822" };
  }
  return { text: `${indonesianWords(4821)}\n${indonesianWords(4822)}` };
}

const CATALOGUE = ["deepseek-v4-1-flash", "gpt-6-luna", "claude-opus-5-5", "claude-haiku-5-5"];

function harness(over: Partial<HandoffDeps> = {}, script: (call: Call) => Reply = wellBehaved) {
  const out: string[] = [];
  const fake = fakeRuntime(script);
  let made = 0;
  let clock = 0;
  const deps: HandoffDeps = {
    env: { AGENTFORGE_DATA_DIR: "/desk", AGENTFORGE_RUNTIME: "ai" },
    now: () => new Date("2026-11-10T10:00:00.000Z"),
    nowMs: () => (clock += 5),
    readSavedModels: () => ({ models: CATALOGUE.map((id) => ({ id })), probedAt: "2026-11-10T09:00:00.000Z" }),
    fetchLiveModels: async () => CATALOGUE.map((id) => ({ id })),
    resolveTier,
    loadPrices: async () => ({
      estimate: (usage) => (usage.inputTokens + usage.outputTokens) / 1_000_000,
      note: "fake price list",
    }),
    makeRuntime: () => {
      made += 1;
      return fake.sender;
    },
    sleep: async () => {},
    out: (text) => {
      out.push(text);
    },
    ...over,
  };
  return { deps, out, calls: fake.calls, made: () => made, text: () => out.join("") };
}

type ResultFile = {
  gatewayHost: string;
  summary: HandoffSummary;
  conversations: TurnRecord[];
  candidates: CandidateRecord[];
};

function resultFile(): ResultFile {
  const files = readdirSync(resultsDir).filter((name) => /^handoff-.+\.json$/.test(name));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(resultsDir, files[0] as string), "utf8")) as ResultFile;
}

describe("runHandoffCommand: a dry run", () => {
  it("never opens a runtime or the price list, and writes nothing", async () => {
    const h = harness({
      makeRuntime: () => {
        throw new Error("a dry run must not make a runtime");
      },
      loadPrices: async () => {
        throw new Error("a dry run must not load prices");
      },
      fetchLiveModels: async () => {
        throw new Error("a dry run must not ask the gateway");
      },
    });
    expect(await runHandoffCommand(argsOf("--dry-run", "--all-candidates", "--handoff"), h.deps)).toBe(0);
    expect(h.text()).toContain("a dry run sends nothing");
    expect(readdirSync(resultsDir)).toEqual([]);
  });

  it("needs a desk but not a key, and plans against the static lists when nothing is saved", async () => {
    const h = harness({
      readSavedModels: () => ({ models: [] }),
      env: { AGENTFORGE_DATA_DIR: "/desk", AGENTFORGE_RUNTIME: "stub" },
    });
    expect(await runHandoffCommand(argsOf("--dry-run"), h.deps)).toBe(0);
    expect(h.text()).toContain("plans against the static tier lists");
    await expect(runHandoffCommand(argsOf("--dry-run"), harness({ env: {} }).deps)).rejects.toBeInstanceOf(EvalRefusal);
  });

  it("prints the help and stops", async () => {
    const h = harness();
    expect(await runHandoffCommand(argsOf("--help"), h.deps)).toBe(0);
    expect(h.text()).toContain("handoff: do the three Chat tiers answer");
  });
});

describe("runHandoffCommand: refusals", () => {
  it("refuses the stub runtime and a missing desk before anything is opened", async () => {
    const stub = harness({ env: { AGENTFORGE_DATA_DIR: "/desk", AGENTFORGE_RUNTIME: "stub" } });
    await expect(runHandoffCommand(argsOf(), stub.deps)).rejects.toThrow(/AGENTFORGE_RUNTIME=stub/);
    const none = harness({ env: {} });
    await expect(runHandoffCommand(argsOf(), none.deps)).rejects.toBeInstanceOf(EvalRefusal);
    expect(stub.made() + none.made()).toBe(0);
  });

  it("stops with a message, and no runtime, when the desk has no saved catalogue and --refresh was not given", async () => {
    const h = harness({ readSavedModels: () => ({ models: [], error: "no key" }) });
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    expect(h.text()).toContain("lists no models (the last probe said: no key). Run with --refresh");
    expect(h.made()).toBe(0);
  });

  it("--refresh asks the gateway instead of reading the saved cache", async () => {
    const h = harness({
      readSavedModels: () => {
        throw new Error("the saved cache must not be read");
      },
    });
    expect(await runHandoffCommand(argsOf("--refresh"), h.deps)).toBe(0);
    expect(h.text()).toContain("asked the gateway just now, 4 models");
  });
});

describe("runHandoffCommand: the hand-off", () => {
  it("runs both conversations through the tiers, carries the history as text, and passes", async () => {
    const h = harness();
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(0);

    // forward: fast, reasoning, daily; reverse: daily, reasoning, fast
    expect(h.calls.map((call) => call.model)).toEqual([
      "deepseek-v4-1-flash",
      "claude-opus-5-5",
      "gpt-6-luna",
      "gpt-6-luna",
      "claude-opus-5-5",
      "deepseek-v4-1-flash",
    ]);
    // Each tier's Thinking choice went through: off, deep, the model's own default.
    expect(h.calls.map((call) => [call.effort, call.explicit, call.thinking])).toEqual([
      ["none", true, false],
      ["high", true, true],
      ["medium", false, true],
      ["medium", false, true],
      ["high", true, true],
      ["none", true, false],
    ]);
    // The history grows by an answer and a question each turn, and starts from the fixed prompts.
    expect(h.calls[0]?.history).toEqual([`user: ${HANDOFF_PROMPTS[0]}`]);
    expect(h.calls[1]?.history).toEqual([
      `user: ${HANDOFF_PROMPTS[0]}`,
      "assistant: 4821",
      `user: ${HANDOFF_PROMPTS[1]}`,
    ]);
    expect(h.calls[2]?.history).toEqual([
      `user: ${HANDOFF_PROMPTS[0]}`,
      "assistant: 4821",
      `user: ${HANDOFF_PROMPTS[1]}`,
      "assistant: 4822",
      `user: ${HANDOFF_PROMPTS[2]}`,
    ]);

    const text = h.text();
    expect(text).toContain("sending to gateway.example.test; the key is not printed or written anywhere");
    expect(text).toContain("prices: fake price list");
    expect(text).toContain("first token ms");
    expect(text).toContain("chat_completions");
    expect(text).toContain("anthropic_messages");
    expect(text).toContain('forward #1 fast: "4821"');
    expect(text).toContain("6 passed, 0 failed of 6 calls.");
    expect(text).toContain("Estimated cost about $0.00015");
    expect(text).toContain(
      'forward #3 daily: "empat ribu delapan ratus dua puluh satu / empat ribu delapan ratus dua puluh dua"',
    );

    const file = resultFile();
    expect(file.summary).toMatchObject({ calls: 6, passed: 6, failed: 0, skipped: 0 });
    expect(file.gatewayHost).toBe("gateway.example.test");
    expect(file.conversations).toHaveLength(6);
    expect(file.conversations[0]).toMatchObject({
      conversation: "forward",
      turn: 1,
      tier: "fast",
      model: "deepseek-v4-1-flash",
      wire: "chat_completions",
      status: "pass",
      reply: "4821",
      inputTokens: 20,
      outputTokens: 5,
      attempts: 1,
    });
    expect(file.conversations[0]?.firstTokenMs).toBeGreaterThan(0);
    expect(file.conversations[0]?.totalMs ?? 0).toBeGreaterThan(file.conversations[0]?.firstTokenMs ?? 0);
    expect(file.conversations[0].checks.map((c: { name: string }) => c.name)).toEqual([
      "http_ok",
      "answered",
      "four_digits",
    ]);
    expect(file.conversations[5].checks.map((c: { name: string }) => c.name)).toEqual([
      "http_ok",
      "answered",
      "two_lines",
      "words",
    ]);
  });

  it("fails the run, with the reason, when the Thinking turn gets the sum wrong, and still runs turn 3", async () => {
    const h = harness({}, (call) => {
      const user = call.history.filter((line) => line.startsWith("user:")).length;
      if (user === 2 && call.model === "claude-opus-5-5") {
        return { text: "4830" };
      }
      return wellBehaved(call);
    });
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    expect(h.calls).toHaveLength(6);
    expect(h.text()).toContain("FAIL plus_one: expected 4822 (4821 + 1), got 4830");
    const file = resultFile();
    expect(file.summary.failed).toBe(4);
    expect(file.conversations[1]).toMatchObject({ status: "fail", reply: "4830" });
  });

  it("fails turn 3 when the Daily tier answers in three lines", async () => {
    const h = harness({}, (call) => {
      const user = call.history.filter((line) => line.startsWith("user:")).length;
      return user === 3 ? { text: "satu\ndua\ntiga" } : wellBehaved(call);
    });
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    expect(h.text()).toContain("two_lines: expected 2 lines, got 3");
  });

  it("stops a conversation at a turn the gateway could not answer, and skips the rest", async () => {
    const h = harness({}, (call) =>
      call.model === "claude-opus-5-5" ? { fail: "HTTP 503 from SECRET-KEY upstream" } : wellBehaved(call),
    );
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    // Per conversation: turn 1 runs, turn 2 fails, turn 3 is never sent.
    expect(h.calls.map((call) => call.model)).toEqual([
      "deepseek-v4-1-flash",
      "claude-opus-5-5",
      "gpt-6-luna",
      "claude-opus-5-5",
    ]);
    const file = resultFile();
    expect(file.conversations.map((turn: { status: string }) => turn.status)).toEqual([
      "pass",
      "fail",
      "skipped",
      "pass",
      "fail",
      "skipped",
    ]);
    expect(file.conversations[1].reason).toContain("http_ok: HTTP 503 from [key] upstream");
    expect(file.conversations[2].reason).toContain("skipped:");
    expect(JSON.stringify(file)).not.toContain("SECRET-KEY");
    expect(h.text()).not.toContain("SECRET-KEY");
    expect(file.summary).toMatchObject({ failed: 2, skipped: 2 });
  });

  it("fails a turn whose run ends without completing", async () => {
    const runtime: AgentRuntime = { execute: async () => {} };
    const h = harness({ makeRuntime: () => ({ host: "gateway.example.test", runtime, redact: (t) => t }) });
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    expect(h.text()).toContain("the run ended without completing");
  });

  it("fails the turn that has no model when a tier resolves to nothing in the catalogue", async () => {
    const h = harness({ readSavedModels: () => ({ models: [{ id: "deepseek-v4-1-flash" }, { id: "gpt-6-luna" }] }) });
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(1);
    // fast and daily answer; reasoning has nothing live, so turn 2 fails and turn 3 is skipped, both ways round.
    expect(h.calls.map((call) => call.model)).toEqual(["deepseek-v4-1-flash", "gpt-6-luna"]);
    const file = resultFile();
    expect(file.conversations[1]).toMatchObject({ tier: "reasoning", model: null, status: "fail" });
    expect(file.conversations[1].reason).toContain("resolves to no model in this catalogue");
    expect(file.conversations[2].status).toBe("skipped");
  });

  it("removes the shell's provider variables before the runtime is made, and prints their names only", async () => {
    const env: NodeJS.ProcessEnv = {
      AGENTFORGE_DATA_DIR: "/desk",
      AGENTFORGE_RUNTIME: "ai",
      ANTHROPIC_API_KEY: "sk-ant-leak",
    };
    let seenAtMake: string[] = [];
    const h = harness({ env });
    const make = h.deps.makeRuntime;
    h.deps.makeRuntime = () => {
      seenAtMake = Object.keys(env).filter((name) => name === "ANTHROPIC_API_KEY");
      return make();
    };
    expect(await runHandoffCommand(argsOf(), h.deps)).toBe(0);
    expect(seenAtMake).toEqual([]);
    expect(h.text()).toContain("ignoring provider variables in the shell: ANTHROPIC_API_KEY");
    expect(h.text()).not.toContain("sk-ant-leak");
  });

  it("skips the price list with --no-prices and prints no estimate", async () => {
    const h = harness({
      loadPrices: async () => {
        throw new Error("--no-prices must not load the list");
      },
    });
    expect(await runHandoffCommand(argsOf("--no-prices"), h.deps)).toBe(0);
    expect(h.text()).toContain("prices: not shown (--no-prices)");
    expect(h.text()).toContain("No cost estimate.");
    expect(resultFile().summary.estimatedUsd).toBeNull();
  });
});

describe("runHandoffCommand: --all-candidates", () => {
  it("calls each listed candidate once at its tier's Thinking level and does not call the unlisted ones", async () => {
    const h = harness({}, () => ({ text: "ok" }));
    expect(await runHandoffCommand(argsOf("--all-candidates"), h.deps)).toBe(0);
    const file = resultFile();
    expect(file.conversations).toEqual([]);
    const sent = h.calls.map((call) => call.model).sort();
    // Listed in the catalogue: deepseek-v4-1-flash (fast and daily), gpt-6-luna (daily and fast),
    // claude-opus-5-5 (reasoning), claude-haiku-5-5 (daily and fast).
    expect(sent).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "deepseek-v4-1-flash",
      "deepseek-v4-1-flash",
      "gpt-6-luna",
      "gpt-6-luna",
    ]);
    const reasoning = file.candidates.filter((c: { tier: string }) => c.tier === "reasoning");
    expect(reasoning.find((c: { requested: string }) => c.requested === "claude-opus-5-5")).toMatchObject({
      status: "pass",
      listed: true,
    });
    expect(reasoning.find((c: { requested: string }) => c.requested === "deepseek-v4-pro")).toMatchObject({
      status: "unlisted",
      listed: false,
      totalMs: null,
    });
    expect(file.summary.unlisted).toBeGreaterThan(0);
    expect(file.summary.failed).toBe(0);
    expect(h.text()).toContain("UNLISTED (not called)");
    expect(h.text()).toMatch(/\d+ candidates not in the catalogue were not called\./);
    // Each candidate ran at its own tier's Thinking level.
    const opus = h.calls.find((call) => call.model === "claude-opus-5-5");
    expect(opus).toMatchObject({ effort: "high", explicit: true });
    expect(h.calls.filter((call) => call.effort === "none").length).toBeGreaterThan(0);
  });

  it("fails the run when a listed candidate does not answer, and when it answers nothing", async () => {
    const down = harness({}, (call) => (call.model === "gpt-6-luna" ? { fail: "model not found" } : { text: "ok" }));
    expect(await runHandoffCommand(argsOf("--all-candidates"), down.deps)).toBe(1);
    expect(down.text()).toContain("FAIL http_ok: model not found");

    const empty = harness({}, (call) => (call.model === "claude-opus-5-5" ? { text: "" } : { text: "ok" }));
    expect(await runHandoffCommand(argsOf("--all-candidates"), empty.deps)).toBe(1);
  });

  it("runs both modes with --handoff --all-candidates, hand-off first", async () => {
    const h = harness({}, (call) =>
      call.history.length === 1 && call.history[0]?.includes("Say ok") ? { text: "ok" } : wellBehaved(call),
    );
    expect(await runHandoffCommand(argsOf("--all-candidates", "--handoff"), h.deps)).toBe(0);
    const file = resultFile();
    expect(file.conversations).toHaveLength(6);
    expect(file.candidates.length).toBeGreaterThan(0);
    expect(h.calls[0]?.history[0]).toContain(HANDOFF_PROMPTS[0]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The real runtime, with only the network faked
// ---------------------------------------------------------------------------------------------------

describe("runTurn through the real AiSdkRuntime", () => {
  const encoder = new TextEncoder();

  function stream(frames: Array<Record<string, unknown>>): Response {
    const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  const sender = (): HandoffRuntime => ({
    host: "gateway.test",
    runtime: new AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://gateway.test/v1" }),
    redact: (text) => text.replaceAll("sk-test", "[key]"),
  });

  it("reads the answer, the first token and the usage from a streamed gateway reply", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return stream([
        chunk({ role: "assistant", content: "48" }),
        chunk({ content: "21" }),
        chunk({}, "stop", { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 }),
      ]);
    });
    let tick = 0;
    const outcome = await runTurn({
      sender: sender(),
      runId: "run-real",
      model: "deepseek-v4-1-flash",
      reasoning: { effort: "none", explicit: true },
      history: [{ role: "user", parts: [{ type: "text", text: HANDOFF_PROMPTS[0] }] }],
      timeoutMs: 30_000,
      // A clock that ticks in fractions, as `performance.now()` does: the record holds whole milliseconds.
      nowMs: () => (tick += 10.4),
      now: () => new Date("2026-11-10T10:00:00.000Z"),
    });
    expect(outcome).toMatchObject({ completed: true, reply: "4821", inputTokens: 31, outputTokens: 4, attempts: 1 });
    expect(Number.isInteger(outcome.totalMs)).toBe(true);
    expect(Number.isInteger(outcome.firstTokenMs)).toBe(true);
    expect(outcome.firstTokenMs).toBeGreaterThan(0);
    expect(outcome.totalMs).toBeGreaterThan(outcome.firstTokenMs ?? 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gateway.test/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("deepseek-v4-1-flash");
    expect(JSON.stringify(seen[0]?.body.messages)).toContain(HANDOFF_PROMPTS[0]);
  });

  it("turns a gateway refusal into a failed turn, with the key taken out of the message", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key sk-test", type: "invalid_request_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await runTurn({
      sender: sender(),
      runId: "run-real-401",
      model: "deepseek-v4-1-flash",
      reasoning: { effort: "none", explicit: true },
      history: [{ role: "user", parts: [{ type: "text", text: HANDOFF_PROMPTS[0] }] }],
      timeoutMs: 30_000,
      nowMs: () => Date.now(),
      now: () => new Date(),
    });
    expect(outcome.completed).toBe(false);
    expect(outcome.reply).toBe("");
    expect(outcome.error).toBeTruthy();
    expect(outcome.error).not.toContain("sk-test");
  });
});

describe("HandoffArgs shape", () => {
  it("is what the command takes", () => {
    const args: HandoffArgs = argsOf();
    expect(Object.keys(args).sort()).toEqual(
      [
        "allCandidates",
        "delayMs",
        "dryRun",
        "handoff",
        "help",
        "prices",
        "refresh",
        "resultsDir",
        "timeoutMs",
        "workspace",
      ].sort(),
    );
  });
});

// Keep the tier names this file asserts on tied to the product's own list.
describe("the tiers this tool plans", () => {
  it("are the three the product has", () => {
    const plan = buildPlan({
      catalogIds: null,
      source: "static",
      resolve: resolveTier,
      handoff: true,
      allCandidates: false,
    });
    expect(plan.tiers.map((tier) => tier.tier).sort()).toEqual(
      (["daily", "fast", "reasoning"] satisfies ModelTierId[]).sort(),
    );
  });
});
