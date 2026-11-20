import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  GATEWAY_PROVIDER_ID,
  resolveChatWire,
  type AgentRuntime,
  type AgentVersionRecord,
  type ReasoningEffortChoice,
  type ResolvedChatWire,
  type RunUsageRecord,
  type TenantContext,
} from "@agentforge/core";
import { MODEL_TIERS, TIER_DEFINITIONS, type ModelTierId, type TierThinking } from "@agentforge/core/tiers";
import { UsageError } from "./args";
import { requireDataDir, requireEvalDesk } from "./credentials";

/**
 * `handoff`: does each Chat tier answer, and can models of different vendors carry one conversation?
 *
 * Unlike `probe` (raw requests, self-heal off), every call here goes through the real runtime Chat uses
 * (`createRuntime` -> `AiSdkRuntime`), with the model and the Thinking choice the real tier resolver gives
 * (`chooseTierRun`, `packages/host/src/tier-resolve.ts`). Nothing in this file names a model id: the
 * tiers' own lists (`TIER_DEFINITIONS`) and the desk's catalogue decide who answers.
 *
 * Every dependency (catalogue, tier resolver, runtime, prices, clock) is passed in, so the unit tests run
 * the whole command with fakes and no network.
 */

// ---------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_DELAY_MS = 500;

export const HANDOFF_USAGE = `handoff: do the three Chat tiers answer, and can models of different vendors carry one conversation?

  AGENTFORGE_DATA_DIR=<desk> pnpm --filter @agentforge/host eval:models:handoff [flags]

  (default)          the hand-off run: one three-turn conversation, each turn on a different tier, forward
                     (fast, reasoning, daily) and then reversed (daily, reasoning, fast)
  --handoff          run the hand-off (implied unless --all-candidates is the only mode flag)
  --all-candidates   one tiny "Say ok." call per listed candidate of every tier, at that tier's Thinking
                     level, to show every model a tier may pick answers. With no --handoff it runs alone.
  --refresh          ask the gateway for its model list now (needs a saved key); the desk's own cache is
                     never written. Without it the desk's saved catalogue is read.
  --dry-run          print the plan and the call count, then stop. No network, no key. With no saved
                     catalogue it plans against the static tier lists and says so.
  --no-prices        skip the gateway's public price list (no cost estimate)
  --timeout-ms <n>   per-call timeout (default ${DEFAULT_TIMEOUT_MS})
  --delay-ms <n>     pause between calls (default ${DEFAULT_DELAY_MS})
  --out <dir>        results folder (default: eval/models/results)
  --workspace <id>   which desk's key to use (default: the selected desk)
  --help

Refuses to run with AGENTFORGE_RUNTIME=stub, with no AGENTFORGE_DATA_DIR, or with no saved gateway key.
Exit code: 0 all checks passed (or a dry run), 1 a check failed, 2 a refusal or a bad command line.
`;

export type HandoffArgs = {
  refresh: boolean;
  handoff: boolean;
  allCandidates: boolean;
  dryRun: boolean;
  prices: boolean;
  timeoutMs: number;
  delayMs: number;
  resultsDir: string;
  workspace: string | undefined;
  help: boolean;
};

function whole(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < min) {
    throw new UsageError(`${name} must be a whole number of at least ${min}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseHandoffArgs(argv: string[], defaultResultsDir: string): HandoffArgs {
  let values: {
    refresh?: boolean;
    handoff?: boolean;
    "all-candidates"?: boolean;
    "dry-run"?: boolean;
    "no-prices"?: boolean;
    "timeout-ms"?: string;
    "delay-ms"?: string;
    out?: string;
    workspace?: string;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        refresh: { type: "boolean" },
        handoff: { type: "boolean" },
        "all-candidates": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "no-prices": { type: "boolean" },
        "timeout-ms": { type: "string" },
        "delay-ms": { type: "string" },
        out: { type: "string" },
        workspace: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Could not read the command line");
  }
  const allCandidates = values["all-candidates"] === true;
  const args: HandoffArgs = {
    refresh: values.refresh === true,
    // The hand-off is the default mode; --all-candidates on its own replaces it, --handoff adds it back.
    handoff: values.handoff === true || !allCandidates,
    allCandidates,
    dryRun: values["dry-run"] === true,
    prices: values["no-prices"] !== true,
    timeoutMs: whole("--timeout-ms", values["timeout-ms"], DEFAULT_TIMEOUT_MS, 1),
    delayMs: whole("--delay-ms", values["delay-ms"], DEFAULT_DELAY_MS, 0),
    resultsDir: values.out ?? defaultResultsDir,
    workspace: values.workspace,
    help: values.help === true,
  };
  if (args.dryRun && args.refresh) {
    throw new UsageError(
      "--refresh asks the gateway for its model list, and a dry run calls nothing. Drop one of them.",
    );
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------
// The script: what each turn says, and what has to be true of its answer
// ---------------------------------------------------------------------------------------------------

export const HANDOFF_PROMPTS = [
  "Pick a random four-digit number. Reply with the number only.",
  "Add 1 to the number in your previous reply. Think it through, then reply with the result only.",
  "Write both numbers above in words, in Bahasa Indonesia, one per line.",
] as const;

export const SAY_OK_PROMPT = "Say ok.";

export const HANDOFF_SYSTEM_PROMPT =
  "You are a helpful assistant in a short test conversation. Follow each instruction exactly and keep to the format it asks for.";

export type HandoffOrder = { name: string; tiers: readonly [ModelTierId, ModelTierId, ModelTierId] };

/** The forward run, then the same three prompts with the tiers reversed. Turn 2 is always the deep one. */
export const HANDOFF_ORDERS: readonly HandoffOrder[] = [
  { name: "forward", tiers: ["fast", "reasoning", "daily"] },
  { name: "reverse", tiers: ["daily", "reasoning", "fast"] },
];

export type Check = { name: string; pass: boolean; detail: string };

/** Digit groups in a reply, with thousands separators (`4.821`, `4,821`) read as one number. */
export function numbersIn(text: string): number[] {
  const flat = text.replace(/(?<=\d)[.,](?=\d{3}(?!\d))/g, "");
  return (flat.match(/\d+/g) ?? []).map(Number);
}

/** The number a reply ends on. "Sure, 4821." and "4821" both give 4821. */
export function lastNumber(text: string): number | undefined {
  return numbersIn(text).at(-1);
}

const UNITS = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"] as const;

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds === 1) {
    parts.push("seratus");
  } else if (hundreds > 1) {
    parts.push(`${UNITS[hundreds]} ratus`);
  }
  if (rest > 0) {
    if (rest < 10) {
      parts.push(UNITS[rest] as string);
    } else if (rest === 10) {
      parts.push("sepuluh");
    } else if (rest === 11) {
      parts.push("sebelas");
    } else if (rest < 20) {
      parts.push(`${UNITS[rest - 10]} belas`);
    } else {
      const tens = Math.floor(rest / 10);
      const unit = rest % 10;
      parts.push(`${UNITS[tens]} puluh${unit > 0 ? ` ${UNITS[unit]}` : ""}`);
    }
  }
  return parts.join(" ");
}

/** The largest number indonesianWords writes; above it the words check reports a failure, never a throw. */
export const INDONESIAN_WORDS_MAX = 999_999_999_999_999;

const GROUP_WORDS = ["", "ribu", "juta", "miliar", "triliun"] as const;

/** A whole number up to 999 999 999 999 999 as Indonesian words ("empat ribu delapan ratus dua puluh satu"). */
export function indonesianWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > INDONESIAN_WORDS_MAX) {
    throw new RangeError(`indonesianWords takes a whole number from 0 to ${INDONESIAN_WORDS_MAX}, got ${n}`);
  }
  if (n === 0) {
    return "nol";
  }
  const parts: string[] = [];
  for (let group = 0, rest = n; rest > 0; group += 1, rest = Math.floor(rest / 1000)) {
    const chunk = rest % 1000;
    if (chunk === 0) {
      continue;
    }
    if (group === 1 && chunk === 1) {
      parts.unshift("seribu");
    } else {
      parts.unshift(group === 0 ? belowThousand(chunk) : `${belowThousand(chunk)} ${GROUP_WORDS[group]}`);
    }
  }
  return parts.join(" ");
}

/**
 * Words as a comparison form: lower case, letters and single spaces only, and the "se-" forms
 * (seribu, seratus, sepuluh, sebelas) spelled as "satu ...", so "seribu" and "satu ribu" are the same.
 */
export function canonicalWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\bseribu\b/g, "satu ribu")
    .replace(/\bseratus\b/g, "satu ratus")
    .replace(/\bsepuluh\b/g, "satu puluh")
    .replace(/\bsebelas\b/g, "satu belas");
}

function replyLines(reply: string): string[] {
  return reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const answered = (reply: string): Check => ({
  name: "answered",
  pass: reply.trim().length > 0,
  detail: reply.trim().length > 0 ? "non-empty answer" : "the answer was empty",
});

/** Turn 1: a four-digit number. Returns the number the history now carries (undefined when there is none). */
export function checkFirstTurn(reply: string): { checks: Check[]; number: number | undefined } {
  const n = lastNumber(reply);
  const ok = n !== undefined && n >= 1000 && n <= 9999;
  return {
    number: n,
    checks: [
      answered(reply),
      {
        name: "four_digits",
        pass: ok,
        detail: n === undefined ? "no number in the answer" : ok ? `picked ${n}` : `${n} is not four digits`,
      },
    ],
  };
}

/** Turn 2: the previous number plus one. */
export function checkSecondTurn(
  reply: string,
  first: number | undefined,
): { checks: Check[]; number: number | undefined } {
  const n = lastNumber(reply);
  let plusOne: Check;
  if (first === undefined) {
    plusOne = { name: "plus_one", pass: false, detail: "turn 1 gave no number to add 1 to" };
  } else {
    const ok = n === first + 1;
    plusOne = {
      name: "plus_one",
      pass: ok,
      detail: ok
        ? `${first} + 1 = ${n}`
        : `expected ${first + 1} (${first} + 1), got ${n === undefined ? "no number" : n}`,
    };
  }
  return { number: n, checks: [answered(reply), plusOne] };
}

/**
 * Turn 3: two lines, and the two lines are the two earlier numbers in Indonesian words. A line may carry
 * a label or digits besides; it counts for the longest number whose words it contains, so 4820 inside
 * 4821's words is not mistaken for 4820. Either order is fine.
 */
export function checkThirdTurn(
  reply: string,
  first: number | undefined,
  second: number | undefined,
): { checks: Check[] } {
  const lines = replyLines(reply);
  const twoLines: Check = {
    name: "two_lines",
    pass: lines.length === 2,
    detail: lines.length === 2 ? "two lines" : `expected 2 lines, got ${lines.length}`,
  };
  let words: Check;
  if (first === undefined || second === undefined) {
    words = { name: "words", pass: false, detail: "an earlier turn gave no number to compare with" };
  } else {
    const wanted = [...new Set([first, second])];
    // A number past the writable range (a reply that ignored "four digits" badly enough) cannot be
    // written in words at all: it counts as missing, and the check reports a failure, never a throw.
    const forms = wanted.map((n) => {
      if (n > INDONESIAN_WORDS_MAX) {
        return { n, words: undefined, display: undefined };
      }
      const display = indonesianWords(n);
      return { n, words: canonicalWords(display), display };
    });
    const found = new Set<number>();
    for (const line of lines) {
      const text = canonicalWords(line);
      const hits = forms
        .filter((form) => form.words !== undefined && text.includes(form.words))
        .sort((a, b) => (b.words ?? "").length - (a.words ?? "").length);
      if (hits[0]) {
        found.add(hits[0].n);
      }
    }
    const missing = forms.filter((form) => !found.has(form.n));
    words = {
      name: "words",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? `both numbers in words (${wanted.join(", ")})`
          : `missing ${missing
              .map((form) =>
                form.display === undefined
                  ? `${form.n} (too large to write as words)`
                  : `${form.n} ("${form.display}")`,
              )
              .join(" and ")}`,
    };
  }
  return { checks: [answered(reply), twoLines, words] };
}

// ---------------------------------------------------------------------------------------------------
// Catalogue and plan
// ---------------------------------------------------------------------------------------------------

/** What a tier resolved to against a catalogue: the model, and the Thinking choice the tier asks for. */
export type TierPick = { model: string; reasoning: ReasoningEffortChoice };

/**
 * The real tier resolver, wrapped by the entry point (`chooseTierRun`): a tier and the catalogue's ids in,
 * the model and Thinking choice out, or null when no candidate of the tier is listed.
 */
export type TierResolver = (tier: ModelTierId, catalogIds: readonly string[]) => TierPick | null;

export type PlannedCandidate = {
  /** The id as the tier's list spells it. */
  requested: string;
  /** The catalogue's spelling when listed (it goes on the wire), otherwise `requested`. */
  model: string;
  listed: boolean;
};

export type PlannedTier = {
  tier: ModelTierId;
  thinking: TierThinking;
  reasoning: ReasoningEffortChoice;
  /** What the tier resolves to in this catalogue, or null when none of its candidates is listed. */
  model: string | null;
  wire: ResolvedChatWire | null;
  candidates: PlannedCandidate[];
};

export type HandoffPlan = {
  /** `static`: no catalogue was available, so the tiers' own lists stand in for it. */
  source: "saved" | "refreshed" | "static";
  catalogCount: number | null;
  tiers: PlannedTier[];
  orders: HandoffOrder[];
  handoffCalls: number;
  candidateCalls: number;
};

/** Every id any tier lists for the gateway, once, in tier order. */
export function staticTierIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tier of MODEL_TIERS) {
    for (const id of TIER_DEFINITIONS[tier].candidates[GATEWAY_PROVIDER_ID] ?? []) {
      if (!seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        ids.push(id);
      }
    }
  }
  return ids;
}

export function buildPlan(input: {
  /** The catalogue's ids, or null for none: the tiers' own lists then stand in, and every candidate is listed. */
  catalogIds: readonly string[] | null;
  source: HandoffPlan["source"];
  resolve: TierResolver;
  handoff: boolean;
  allCandidates: boolean;
}): HandoffPlan {
  const stand = staticTierIds();
  const catalogue = input.catalogIds ?? stand;
  const byLower = new Map(catalogue.map((id) => [id.toLowerCase(), id]));
  const tiers = MODEL_TIERS.map((tier): PlannedTier => {
    const definition = TIER_DEFINITIONS[tier];
    // What the tier asks of Thinking does not depend on the catalogue, so it is read against the tier's own
    // lists: it stays known for a tier that resolves to nothing live.
    const asked = input.resolve(tier, stand);
    if (!asked) {
      throw new Error(`The tier ${tier} resolves to nothing even against its own candidate lists.`);
    }
    const live = input.catalogIds === null ? asked : input.resolve(tier, catalogue);
    const candidates = (definition.candidates[GATEWAY_PROVIDER_ID] ?? []).map((requested): PlannedCandidate => {
      const hit = byLower.get(requested.toLowerCase());
      return { requested, model: hit ?? requested, listed: hit !== undefined };
    });
    return {
      tier,
      thinking: definition.thinking,
      reasoning: asked.reasoning,
      model: live ? live.model : null,
      wire: live ? resolveChatWire(undefined, live.model) : null,
      candidates,
    };
  });
  const orders = input.handoff ? [...HANDOFF_ORDERS] : [];
  return {
    source: input.source,
    catalogCount: input.catalogIds === null ? null : input.catalogIds.length,
    tiers,
    orders,
    handoffCalls: orders.length * HANDOFF_PROMPTS.length,
    candidateCalls: input.allCandidates
      ? tiers.reduce((sum, tier) => sum + tier.candidates.filter((c) => c.listed).length, 0)
      : 0,
  };
}

function thinkingText(reasoning: ReasoningEffortChoice): string {
  if (!reasoning.explicit) {
    return "Thinking: the model's own default";
  }
  return reasoning.effort === "none" ? "Thinking: off" : `Thinking: ${reasoning.effort}`;
}

export function planText(input: {
  dataDir: string;
  plan: HandoffPlan;
  args: HandoffArgs;
  probedAt?: string | undefined;
}): string {
  const { plan, args } = input;
  const lines = [`Handoff plan${args.dryRun ? " (a dry run sends nothing)" : ""}`, `  desk: ${input.dataDir}`];
  if (plan.source === "static") {
    lines.push(
      "  catalogue: none saved on this desk, so this plans against the static tier lists (the first candidate of each tier, all taken as listed).",
      "             A live run needs the desk's saved catalogue or --refresh.",
    );
  } else if (plan.source === "refreshed") {
    lines.push(`  catalogue: asked the gateway just now, ${plan.catalogCount} models`);
  } else {
    lines.push(
      `  catalogue: saved on the desk, ${plan.catalogCount} models${input.probedAt ? `, probed ${input.probedAt}` : ""}`,
    );
  }
  lines.push("  tiers:");
  for (const tier of plan.tiers) {
    lines.push(
      tier.model
        ? `    ${tier.tier.padEnd(10)} -> ${tier.model}  [${tier.wire}; ${thinkingText(tier.reasoning)}]`
        : `    ${tier.tier.padEnd(10)} -> NOTHING: no candidate of this tier is in the catalogue  [${thinkingText(tier.reasoning)}]`,
    );
  }
  if (plan.orders.length > 0) {
    lines.push(
      `  hand-off: ${plan.orders.length} conversations x ${HANDOFF_PROMPTS.length} turns, history carried forward as text`,
      ...plan.orders.map((order) => `    ${order.name.padEnd(8)} ${order.tiers.join(" -> ")}`),
    );
  }
  if (args.allCandidates) {
    lines.push('  candidates ("Say ok." once per listed candidate, at its tier\'s Thinking level):');
    for (const tier of plan.tiers) {
      lines.push(
        `    ${tier.tier.padEnd(10)} ${tier.candidates.map((c) => `${c.model}${c.listed ? "" : " (not listed: skipped)"}`).join(", ") || "none"}`,
      );
    }
  }
  lines.push(
    `  calls: ${plan.handoffCalls} hand-off (fewer if a turn cannot be answered) + ${plan.candidateCalls} candidate = ${plan.handoffCalls + plan.candidateCalls}`,
    `  timeout ${args.timeoutMs} ms per call · pause ${args.delayMs} ms · every call goes through the real runtime Chat uses`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// One call through the runtime
// ---------------------------------------------------------------------------------------------------

export type HandoffRuntime = {
  host: string;
  runtime: AgentRuntime;
  /** Takes the key (and anything else secret) out of text the gateway echoed back. */
  redact: (text: string) => string;
};

export type PriceEstimator = {
  /** USD for one call's usage at the public price list, or null when no honest number exists. */
  estimate: ((usage: RunUsageRecord) => number | null) | undefined;
  note: string;
};

export type TurnOutcome = {
  completed: boolean;
  reply: string;
  firstTokenMs: number | null;
  totalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Contact attempts the runtime made (it retries a model that did not answer). */
  attempts: number;
  error?: string;
};

const EVAL_TENANT: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "eval-handoff",
  workspaceId: "eval-handoff",
  userId: "eval-handoff",
  role: "owner",
};

function versionFor(model: string, createdAt: Date): AgentVersionRecord {
  return {
    id: "eval-handoff",
    agentId: "eval-handoff",
    organizationId: EVAL_TENANT.organizationId,
    version: 1,
    systemPrompt: HANDOFF_SYSTEM_PROMPT,
    model,
    inputModalities: ["text"],
    config: {},
    createdAt,
  };
}

type History = Array<{ role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> }>;

export async function runTurn(input: {
  sender: HandoffRuntime;
  runId: string;
  model: string;
  reasoning: ReasoningEffortChoice;
  history: History;
  timeoutMs: number;
  nowMs: () => number;
  now: () => Date;
}): Promise<TurnOutcome> {
  const started = input.nowMs();
  const elapsed = () => Math.round(input.nowMs() - started);
  const signal = AbortSignal.timeout(input.timeoutMs);
  let reply = "";
  let firstTokenMs: number | null = null;
  let completed = false;
  let failure: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let attempts = 0;
  try {
    await input.sender.runtime.execute({
      tenant: EVAL_TENANT,
      runId: input.runId,
      modality: "text",
      version: versionFor(input.model, input.now()),
      bindings: [],
      history: input.history,
      thinking: input.reasoning.effort !== "none",
      reasoningEffort: input.reasoning.effort,
      reasoningEffortExplicit: input.reasoning.explicit,
      locale: "en",
      signal,
      onEvent: (event) => {
        switch (event.type) {
          case "run.probing":
            attempts = Math.max(attempts, event.attempt);
            break;
          case "assistant.delta":
          case "assistant.thinking":
            // As the probe counts it: the first token of an answer or of its thinking.
            if (firstTokenMs === null) {
              firstTokenMs = elapsed();
            }
            if (event.type === "assistant.delta") {
              reply += event.text;
            }
            break;
          case "run.failed":
            failure = event.message;
            break;
          case "run.completed":
            completed = true;
            if (event.usage) {
              usage = { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens };
            }
            break;
          default:
            break;
        }
      },
    });
  } catch (error) {
    if (failure === undefined) {
      failure = signal.aborted
        ? `timed out after ${input.timeoutMs} ms`
        : error instanceof Error && error.message
          ? error.message
          : "the run failed";
    }
  }
  const totalMs = elapsed();
  if (!completed && failure === undefined) {
    failure = "the run ended without completing";
  }
  return {
    completed: completed && failure === undefined,
    reply: reply.trim(),
    firstTokenMs,
    totalMs,
    inputTokens: usage ? usage.inputTokens : null,
    outputTokens: usage ? usage.outputTokens : null,
    attempts,
    ...(failure === undefined ? {} : { error: input.sender.redact(failure).slice(0, 300) }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------

const REPLY_LIMIT = 300;

export type TurnRecord = {
  conversation: string;
  turn: number;
  tier: ModelTierId;
  model: string | null;
  wire: ResolvedChatWire | null;
  /** The Thinking level the tier asked for. */
  thinking: ReasoningEffortChoice;
  status: "pass" | "fail" | "skipped";
  reply: string;
  firstTokenMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: number;
  usd: number | null;
  checks: Check[];
  reason: string;
};

export type CandidateRecord = {
  tier: ModelTierId;
  requested: string;
  model: string;
  listed: boolean;
  wire: ResolvedChatWire;
  thinking: ReasoningEffortChoice;
  status: "pass" | "fail" | "unlisted";
  reply: string;
  firstTokenMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: number;
  usd: number | null;
  checks: Check[];
  reason: string;
};

function failedReason(checks: readonly Check[]): string {
  return checks
    .filter((check) => !check.pass)
    .map((check) => `${check.name}: ${check.detail}`)
    .join("; ");
}

function usdOf(price: PriceEstimator, model: string, outcome: TurnOutcome): number | null {
  if (!price.estimate || outcome.inputTokens === null || outcome.outputTokens === null) {
    return null;
  }
  return price.estimate({ model, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens });
}

// ---------------------------------------------------------------------------------------------------
// The two modes
// ---------------------------------------------------------------------------------------------------

type Runner = {
  sender: HandoffRuntime;
  price: PriceEstimator;
  args: HandoffArgs;
  nowMs: () => number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Called once per finished call, for the progress line. */
  progress: (line: string) => void;
};

/** Pause before every call but the first, so a sweep never bursts at the gateway. */
function pacer(runner: Pick<Runner, "args" | "sleep">): () => Promise<void> {
  let first = true;
  return async () => {
    if (!first && runner.args.delayMs > 0) {
      await runner.sleep(runner.args.delayMs);
    }
    first = false;
  };
}

function turnProgress(record: TurnRecord): string {
  return `  ${record.conversation} #${record.turn} ${record.tier.padEnd(9)} ${String(record.model ?? "-").padEnd(24)} ${record.status.toUpperCase()}  ttft ${record.firstTokenMs ?? "-"} ms  total ${record.totalMs ?? "-"} ms${record.reason ? `  ${record.reason.slice(0, 90)}` : ""}\n`;
}

export async function runOrder(
  runner: Runner,
  order: HandoffOrder,
  tiers: readonly PlannedTier[],
  pace: () => Promise<void>,
): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  const history: History = [];
  let first: number | undefined;
  let second: number | undefined;
  let broken: string | undefined;

  for (let index = 0; index < HANDOFF_PROMPTS.length; index += 1) {
    const tierId = order.tiers[index] as ModelTierId;
    const planned = tiers.find((tier) => tier.tier === tierId) as PlannedTier;
    const base = { conversation: order.name, turn: index + 1, tier: tierId, thinking: planned.reasoning } as const;
    const blank = {
      reply: "",
      firstTokenMs: null,
      totalMs: null,
      inputTokens: null,
      outputTokens: null,
      attempts: 0,
      usd: null,
    };

    if (broken !== undefined || planned.model === null) {
      // A turn after a broken one is skipped; the turn that has no model is itself the failure.
      const skipped = broken !== undefined;
      const reason = skipped ? `skipped: ${broken}` : `the ${tierId} tier resolves to no model in this catalogue`;
      if (!skipped) {
        broken = `turn ${index + 1} (${tierId}) had no model to run on`;
      }
      const record: TurnRecord = {
        ...base,
        ...blank,
        model: planned.model,
        wire: planned.wire,
        status: skipped ? "skipped" : "fail",
        checks: [],
        reason,
      };
      records.push(record);
      runner.progress(turnProgress(record));
      continue;
    }

    await pace();
    history.push({ role: "user", parts: [{ type: "text", text: HANDOFF_PROMPTS[index] as string }] });
    const outcome = await runTurn({
      sender: runner.sender,
      runId: `handoff-${order.name}-${index + 1}`,
      model: planned.model,
      reasoning: planned.reasoning,
      history,
      timeoutMs: runner.args.timeoutMs,
      nowMs: runner.nowMs,
      now: runner.now,
    });

    let checks: Check[];
    if (!outcome.completed) {
      checks = [{ name: "http_ok", pass: false, detail: outcome.error ?? "the call did not complete" }];
      broken = `turn ${index + 1} (${tierId}) did not answer, so there is no history to carry on with`;
    } else {
      const httpOk: Check = { name: "http_ok", pass: true, detail: "the gateway answered" };
      if (index === 0) {
        const result = checkFirstTurn(outcome.reply);
        first = result.number;
        checks = [httpOk, ...result.checks];
      } else if (index === 1) {
        const result = checkSecondTurn(outcome.reply, first);
        second = result.number;
        checks = [httpOk, ...result.checks];
      } else {
        checks = [httpOk, ...checkThirdTurn(outcome.reply, first, second).checks];
      }
      history.push({ role: "assistant", parts: [{ type: "text", text: outcome.reply }] });
    }

    const pass = checks.every((check) => check.pass);
    const record: TurnRecord = {
      ...base,
      model: planned.model,
      wire: planned.wire,
      status: pass ? "pass" : "fail",
      reply: runner.sender.redact(outcome.reply).slice(0, REPLY_LIMIT),
      firstTokenMs: outcome.firstTokenMs,
      totalMs: outcome.totalMs,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      attempts: outcome.attempts,
      usd: usdOf(runner.price, planned.model, outcome),
      checks,
      reason: failedReason(checks),
    };
    records.push(record);
    runner.progress(turnProgress(record));
  }
  return records;
}

export async function runCandidates(
  runner: Runner,
  tiers: readonly PlannedTier[],
  pace: () => Promise<void>,
): Promise<CandidateRecord[]> {
  const records: CandidateRecord[] = [];
  for (const tier of tiers) {
    for (const candidate of tier.candidates) {
      const base = {
        tier: tier.tier,
        requested: candidate.requested,
        model: candidate.model,
        listed: candidate.listed,
        wire: resolveChatWire(undefined, candidate.model),
        thinking: tier.reasoning,
      };
      const blank = {
        reply: "",
        firstTokenMs: null,
        totalMs: null,
        inputTokens: null,
        outputTokens: null,
        attempts: 0,
        usd: null,
      };
      let record: CandidateRecord;
      if (!candidate.listed) {
        record = {
          ...base,
          ...blank,
          status: "unlisted",
          checks: [],
          reason: "not in the catalogue, so no tier would ever pick it; not called",
        };
      } else {
        await pace();
        const outcome = await runTurn({
          sender: runner.sender,
          runId: `handoff-candidate-${tier.tier}`,
          model: candidate.model,
          reasoning: tier.reasoning,
          history: [{ role: "user", parts: [{ type: "text", text: SAY_OK_PROMPT }] }],
          timeoutMs: runner.args.timeoutMs,
          nowMs: runner.nowMs,
          now: runner.now,
        });
        const checks: Check[] = outcome.completed
          ? [{ name: "http_ok", pass: true, detail: "the gateway answered" }, answered(outcome.reply)]
          : [{ name: "http_ok", pass: false, detail: outcome.error ?? "the call did not complete" }];
        record = {
          ...base,
          status: checks.every((check) => check.pass) ? "pass" : "fail",
          reply: runner.sender.redact(outcome.reply).slice(0, REPLY_LIMIT),
          firstTokenMs: outcome.firstTokenMs,
          totalMs: outcome.totalMs,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          attempts: outcome.attempts,
          usd: usdOf(runner.price, candidate.model, outcome),
          checks,
          reason: failedReason(checks),
        };
      }
      records.push(record);
      runner.progress(
        `  candidate ${tier.tier.padEnd(9)} ${candidate.model.padEnd(24)} ${record.status.toUpperCase()}  ttft ${record.firstTokenMs ?? "-"} ms  total ${record.totalMs ?? "-"} ms${record.reason ? `  ${record.reason.slice(0, 90)}` : ""}\n`,
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] as number))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

const ms = (value: number | null) => (value === null ? "-" : String(Math.round(value)));
const tokens = (input: number | null, output: number | null) =>
  input === null && output === null ? "-" : `${input ?? "?"}/${output ?? "?"}`;
const dollars = (value: number | null) =>
  value === null ? "-" : `$${value < 0.01 ? value.toFixed(5) : value.toFixed(4)}`;

export function turnTable(records: readonly TurnRecord[]): string {
  return table(
    ["conv", "#", "tier", "model", "wire", "first token ms", "total ms", "in/out tokens", "est. cost", "result"],
    records.map((record) => [
      record.conversation,
      String(record.turn),
      record.tier,
      record.model ?? "-",
      record.wire ?? "-",
      ms(record.firstTokenMs),
      ms(record.totalMs),
      tokens(record.inputTokens, record.outputTokens),
      dollars(record.usd),
      record.status === "pass" ? "PASS" : `${record.status === "skipped" ? "SKIP" : "FAIL"} ${record.reason}`.trim(),
    ]),
  );
}

export function candidateTable(records: readonly CandidateRecord[]): string {
  return table(
    ["tier", "model", "wire", "thinking", "first token ms", "total ms", "in/out tokens", "est. cost", "result"],
    records.map((record) => [
      record.tier,
      record.model,
      record.wire,
      record.thinking.explicit ? record.thinking.effort : "default",
      ms(record.firstTokenMs),
      ms(record.totalMs),
      tokens(record.inputTokens, record.outputTokens),
      dollars(record.usd),
      record.status === "pass"
        ? "PASS"
        : record.status === "unlisted"
          ? "UNLISTED (not called)"
          : `FAIL ${record.reason}`,
    ]),
  );
}

function oneLine(text: string, limit = 110): string {
  const flat = text
    .trim()
    .replace(/\s*\r?\n\s*/g, " / ")
    .replace(/\s+/g, " ");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}...` : flat;
}

function answersText(records: readonly TurnRecord[]): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.status === "skipped") {
      continue;
    }
    lines.push(
      `  ${record.conversation} #${record.turn} ${record.tier}: ${record.reply ? JSON.stringify(oneLine(record.reply)) : "(no answer)"}`,
    );
  }
  return lines.join("\n");
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, "-");

/**
 * The provider variables the runtime would read from the shell. A run here must use the desk's saved
 * gateway key and nothing else, so they are removed from this process before the first call. Returns the
 * names it removed (never a value).
 */
export const PROVIDER_ENV_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "ARK_API_KEY",
  "ARK_BASE_URL",
  "VOLCENGINE_API_KEY",
  "VOLCENGINE_BASE_URL",
] as const;

export function scrubProviderEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of PROVIDER_ENV_NAMES) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------

export type HandoffDeps = {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** A monotonic millisecond clock for timings. */
  nowMs: () => number;
  /** The models the desk's saved cache lists, read the way the host reads it. */
  readSavedModels: () => { models: Array<{ id: string }>; probedAt?: string | undefined; error?: string | undefined };
  /** A live `GET /models` with the desk's saved key; refuses (EvalRefusal) when the desk has none. */
  fetchLiveModels: (workspace: string | undefined) => Promise<Array<{ id: string }>>;
  resolveTier: TierResolver;
  loadPrices: () => Promise<PriceEstimator>;
  /**
   * What sends the calls. Called only once every refusal check has passed, and never for `--dry-run`, so a
   * run that is refused, or only planned, has not so much as opened the desk's key.
   */
  makeRuntime: () => HandoffRuntime;
  sleep: (ms: number) => Promise<void>;
  out: (text: string) => void;
};

export type HandoffSummary = {
  calls: number;
  passed: number;
  failed: number;
  skipped: number;
  unlisted: number;
  estimatedUsd: number | null;
  unpricedCalls: number;
};

function summarise(turns: readonly TurnRecord[], candidates: readonly CandidateRecord[]): HandoffSummary {
  const all = [...turns, ...candidates];
  const called = all.filter((record) => record.totalMs !== null);
  const priced = called.filter((record) => record.usd !== null);
  return {
    calls: called.length,
    passed: all.filter((record) => record.status === "pass").length,
    failed: all.filter((record) => record.status === "fail").length,
    skipped: turns.filter((record) => record.status === "skipped").length,
    unlisted: candidates.filter((record) => record.status === "unlisted").length,
    estimatedUsd: priced.length === 0 ? null : priced.reduce((sum, record) => sum + (record.usd ?? 0), 0),
    unpricedCalls: called.length - priced.length,
  };
}

/**
 * `handoff`. Returns the exit code: 0 when every check passed (and for a dry run), 1 when a check failed
 * or there was nothing to run against. A refusal (no desk, stub runtime, no key) is thrown for the entry
 * point to print.
 */
export async function runHandoffCommand(args: HandoffArgs, deps: HandoffDeps): Promise<number> {
  if (args.help) {
    deps.out(HANDOFF_USAGE);
    return 0;
  }
  // A dry run calls nothing, so it needs only a desk; a real run needs the full set of refusals.
  const { dataDir } = args.dryRun ? requireDataDir(deps.env) : requireEvalDesk(deps.env);

  let ids: string[] | null;
  let source: HandoffPlan["source"];
  let probedAt: string | undefined;
  if (args.refresh) {
    const live = await deps.fetchLiveModels(args.workspace);
    ids = live.map((model) => model.id);
    source = "refreshed";
  } else {
    const saved = deps.readSavedModels();
    ids = saved.models.map((model) => model.id);
    source = "saved";
    probedAt = saved.probedAt;
    if (ids.length === 0) {
      if (!args.dryRun) {
        deps.out(
          `The saved catalogue in ${dataDir} lists no models${saved.error ? ` (the last probe said: ${saved.error})` : ""}. Run with --refresh to ask the gateway.\n`,
        );
        return 1;
      }
      ids = null;
      source = "static";
    }
  }
  if (ids !== null && ids.length === 0) {
    deps.out("The gateway lists no models. Check the key on that desk.\n");
    return 1;
  }

  const plan = buildPlan({
    catalogIds: ids,
    source,
    resolve: deps.resolveTier,
    handoff: args.handoff,
    allCandidates: args.allCandidates,
  });
  deps.out(planText({ dataDir, plan, args, probedAt }));
  if (args.dryRun) {
    return 0;
  }

  const ignored = scrubProviderEnv(deps.env);
  const sender = deps.makeRuntime();
  deps.out(
    `  sending to ${sender.host}; the key is not printed or written anywhere${
      ignored.length > 0 ? `\n  ignoring provider variables in the shell: ${ignored.join(", ")}` : ""
    }\n`,
  );
  const price = args.prices ? await deps.loadPrices() : { estimate: undefined, note: "not shown (--no-prices)" };
  deps.out(`  prices: ${price.note}\n\n`);

  const startedAt = deps.now();
  const runner: Runner = {
    sender,
    price,
    args,
    nowMs: deps.nowMs,
    now: deps.now,
    sleep: deps.sleep,
    progress: (line) => deps.out(line),
  };
  const pace = pacer(runner);
  const turns: TurnRecord[] = [];
  const candidates: CandidateRecord[] = [];
  for (const order of plan.orders) {
    turns.push(...(await runOrder(runner, order, plan.tiers, pace)));
  }
  if (args.allCandidates) {
    candidates.push(...(await runCandidates(runner, plan.tiers, pace)));
  }

  if (turns.length > 0) {
    deps.out(
      `\nHand-off (history carried forward as text, one tier per turn)\n${turnTable(turns)}\n\nanswers:\n${answersText(turns)}\n`,
    );
  }
  if (candidates.length > 0) {
    deps.out(`\nEvery candidate of every tier ("${SAY_OK_PROMPT}")\n${candidateTable(candidates)}\n`);
  }
  const summary = summarise(turns, candidates);
  deps.out(
    `\n${summary.passed} passed, ${summary.failed} failed${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""} of ${summary.calls} calls${
      summary.unlisted > 0 ? `; ${summary.unlisted} candidates not in the catalogue were not called` : ""
    }. ${
      summary.estimatedUsd === null
        ? "No cost estimate."
        : `Estimated cost about ${dollars(summary.estimatedUsd)} at the public prices${summary.unpricedCalls > 0 ? ` (${summary.unpricedCalls} calls not priced)` : ""}.`
    }\n`,
  );

  mkdirSync(args.resultsDir, { recursive: true });
  const path = join(args.resultsDir, `handoff-${stamp(startedAt)}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        startedAt: startedAt.toISOString(),
        finishedAt: deps.now().toISOString(),
        desk: dataDir,
        gatewayHost: sender.host,
        options: {
          handoff: args.handoff,
          allCandidates: args.allCandidates,
          refresh: args.refresh,
          timeoutMs: args.timeoutMs,
          delayMs: args.delayMs,
        },
        prices: price.note,
        plan,
        conversations: turns,
        candidates,
        summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  deps.out(`results written: ${path}\n`);
  return summary.failed > 0 || summary.skipped > 0 ? 1 : 0;
}
