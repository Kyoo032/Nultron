/**
 * Reading a `delegate` call for the Chat card. Pure data in, plain data out, like `dossier-result.ts`.
 *
 * The host's answer (`DelegateResult` in `packages/host/src/delegation`) is `{ ok: true, agent, thread: { id },
 * summary, truncated, toolsUsed }`, or a refusal `{ ok: false, reason, message, agent?, thread? }`. Only a
 * run that really started has a `thread`: a refusal before that (no hired agent, a second hand-off from a
 * delegated run) has nothing to open, so it gets no card and the Thinking row says why. The asked agent's
 * whole answer is the conversation it was kept in, which the card links to, so a thread reopened tomorrow
 * draws the same card from the saved call alone.
 */
import { PRODUCT_MODE_IDS, type ProductMode } from "@agentforge/core/product-modes";
import { asRecord, readList, readString } from "./results";

export const DELEGATE_TOOL_KEY = "delegate";

/** The task headline is one line; the whole task is in the asked agent's conversation. */
const HEADLINE_MAX = 120;

/** Why a started run gave no answer. Any other reason is read as `failed`. */
export const DELEGATE_FAILURES = ["cancelled", "timeout", "no_answer", "failed"] as const;
export type DelegateFailure = (typeof DELEGATE_FAILURES)[number];

export type DelegateCardModel = {
  readonly agent: ProductMode;
  /** The conversation that holds the task and the answer. */
  readonly threadId: string;
  /** The first line of the task, cut to a headline's length. */
  readonly headline: string;
  /** The agent's own words. Empty when the run gave no answer. */
  readonly summary: string;
  /** True when the answer is longer than `summary`. The rest is in the conversation. */
  readonly truncated: boolean;
  /** The tools the asked agent used, in the order it first finished each. */
  readonly toolsUsed: readonly string[];
  /** Null when the agent answered. */
  readonly failure: DelegateFailure | null;
};

const MODES: ReadonlySet<string> = new Set<string>(PRODUCT_MODE_IDS);

function headlineOf(task: string | undefined): string {
  const first = (task ?? "").split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  return first.length > HEADLINE_MAX ? `${first.slice(0, HEADLINE_MAX - 1).trimEnd()}…` : first;
}

/** The agent a call asked: the answer's own `agent`, else the call's argument. Null for anything not a mode. */
export function delegatedAgentOf(input: unknown, output: unknown): ProductMode | null {
  const named = readString(asRecord(output), "agent") ?? readString(asRecord(input), "agent");
  return named && MODES.has(named) ? (named as ProductMode) : null;
}

/**
 * The card for one finished call, or null when no run was started. Never throws. A refusal that carries a
 * thread (stopped, out of time, no answer) still gets a card, so the owner can open what was done.
 */
export function readDelegateResult(input: unknown, output: unknown): DelegateCardModel | null {
  const result = asRecord(output);
  if (!result) {
    return null;
  }
  const agent = delegatedAgentOf(input, output);
  const threadId = readString(asRecord(result.thread), "id");
  if (!agent || !threadId) {
    return null;
  }
  const headline = headlineOf(readString(asRecord(input), "task"));
  if (result.ok === true) {
    return {
      agent,
      threadId,
      headline,
      summary: readString(result, "summary") ?? "",
      truncated: result.truncated === true,
      toolsUsed: (readList(result, "toolsUsed") ?? []).filter(
        (key): key is string => typeof key === "string" && key.length > 0,
      ),
      failure: null,
    };
  }
  if (result.ok !== false) {
    return null;
  }
  const reason = readString(result, "reason");
  const failure = (DELEGATE_FAILURES as readonly string[]).includes(String(reason))
    ? (reason as DelegateFailure)
    : "failed";
  return { agent, threadId, headline, summary: "", truncated: false, toolsUsed: [], failure };
}
