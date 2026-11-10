/**
 * `ask_nultron`, the talker's one tool (plan W3, W5). The thinker is the Chat run the thread already
 * has, so facts come from the same agent, model, prompt, Knowledge Base and history as a typed turn.
 * Lane C owns this file. The signatures are the contract the relay codes against.
 *
 * What it reuses from Chat (`../runs.ts`): `prepareChatRun` (agent, model, prompt, Knowledge Base,
 * language, tools, budget) and `chatHistoryFromRows` (the thread's earlier messages). What it does not
 * reuse is the typed turn's storage: no message, run row, tool row, title or Knowledge card is written.
 * The relay saves the spoken turns.
 */
import {
  ApiError,
  attachedTextsOf,
  createOutboundGuard,
  createRuntime,
  hasNonTextUserPart,
  runOutboundGuarded,
  userTextOf,
  type ContentPart,
  type EnvLike,
  type RunBudget,
  type RuntimeEvent,
  type TenantContext,
} from "@agentforge/core";
import type { VoiceCard } from "@agentforge/core/voice";
import { prepareChatImageHistory } from "../chat-image-history";
import { withChatMediaReferences } from "../chat-media-resolver";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { log } from "../log";
import { chatHistoryFromRows, prepareChatRun } from "../runs";
import { activeRuns, admitRun, runCapsFromEnv } from "../run-limits";
import { withRunContext } from "../run-context";
import { toolMediaModels } from "../selectable-models";
import { listMessages } from "../threads";
import { withToolRun } from "../tool-run-context";
import { recordChatRunUsage, recordTokenUsage } from "../usage-record";
import { askCopy, speakable, tapSummary, voiceNote } from "./ask-speech";
import { REQUEST_TAP_TOOL_KEY, ensureVoiceToolsRegistered, voiceBindings } from "./ask-tools";
import type { VoiceLocale } from "./turns";

export const ASK_NULTRON_TOOL_NAME = "ask_nultron";

/**
 * The tool's name, description and parameters. The HTTP talker wraps these in the chat-completions
 * shape (`function` nested) in `talker-prompt.ts` (`ASK_NULTRON_GATEWAY_TOOL`).
 */
export const ASK_NULTRON_TOOL = {
  type: "function",
  name: ASK_NULTRON_TOOL_NAME,
  description:
    "Ask Nultron's desk for facts, the person's files and Knowledge Base, or to start work. Use it for every factual or task question. Pass the person's request in their own words.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The person's request, in their own words." } },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

export type AskResult =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "needs_tap"; readonly text: string; readonly card: VoiceCard }
  | {
      readonly kind: "refused";
      readonly reason: "gateway_blocked" | "busy" | "timeout" | "failed";
      readonly text: string;
    };

export type AskInput = {
  readonly tenant: TenantContext;
  readonly threadId: string;
  readonly question: string;
  readonly locale: VoiceLocale;
  readonly signal: AbortSignal;
};

/** No result within this long is a `timeout`. A voice turn that takes longer is no longer a conversation. */
export const ASK_TIMEOUT_MS = 20_000;

/** The longest question the thinker is given; a spoken turn is far shorter. */
const QUESTION_MAX = 4_000;

/**
 * What a voice ask may spend: a lookup and an answer, with room for a second lookup. Chat's own budget
 * is sized for workers that run for minutes, and voice offers none.
 */
export const VOICE_BUDGET: RunBudget = Object.freeze({ maxSteps: 5, maxToolCalls: 6 });

/** For tests only: a shorter clock than `ASK_TIMEOUT_MS`. The relay never passes it. */
export type AskOptions = { readonly timeoutMs?: number };

/** Threads with an ask in flight, keyed by company and thread. One at a time per thread. */
const inFlight = new Set<string>();

/**
 * Whether a voice ask takes one of the company's run slots (`../run-limits.ts`, six by default on the
 * hosted server, none on a desk), and why it does.
 *
 * It takes a slot. The cap bounds model runs in flight for one company (SR-138); a voice ask is a model
 * run, so leaving it outside the cap would let voice sessions run past the box's protection. It never
 * waits for one: a full cap is `busy` at once. And it cannot starve typed Chat: voice is admitted only
 * while the company has two or more free slots, so the last one is always left for a typed turn, and
 * one ask per thread bounds how many slots voice can hold.
 */
export function admitVoiceSlot(tenant: TenantContext, env: EnvLike = process.env): (() => void) | null {
  const cap = runCapsFromEnv(env).perTenant;
  if (cap !== null && cap > 1 && activeRuns(tenant) >= cap - 1) {
    return null;
  }
  try {
    return admitRun(tenant, env);
  } catch {
    return null;
  }
}

function refused(
  locale: VoiceLocale,
  reason: "gateway_blocked" | "busy" | "timeout" | "failed",
): Extract<AskResult, { kind: "refused" }> {
  const copy = askCopy(locale);
  const text =
    reason === "gateway_blocked"
      ? copy.gatewayBlocked
      : reason === "busy"
        ? copy.busy
        : reason === "timeout"
          ? copy.timeout
          : copy.failed;
  return { kind: "refused", reason, text };
}

function textOf(parts: readonly ContentPart[]): string {
  return parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

/**
 * Runs one thinker turn and returns what the talker should read back. Never throws.
 *
 * Usage: the thinker's own model calls are recorded by this function, under the Chat mode. The relay
 * records only the talker and the transcriber, so nothing is counted twice. It never inserts a message
 * into the thread: the relay saves the spoken turns.
 *
 * A caller that aborts (the person cut in) gets `refused` / `failed` back; the relay has already moved
 * on and drops it. The model call and any tool in flight stop at once.
 */
export async function askNultron(input: AskInput, options: AskOptions = {}): Promise<AskResult> {
  const { tenant, threadId, locale } = input;
  const copy = askCopy(locale);
  try {
    const question = typeof input.question === "string" ? input.question.trim().slice(0, QUESTION_MAX) : "";
    if (!question || input.signal.aborted) {
      return refused(locale, "failed");
    }

    // The gate a typed turn passes on its way in (`handlers/runs.ts`): the key and the plan.
    try {
      requireGatewayAllowedFor(tenant);
    } catch (error) {
      return refused(locale, error instanceof ApiError && error.status === 403 ? "gateway_blocked" : "failed");
    }

    const busyKey = JSON.stringify([tenant.organizationId, threadId]);
    if (inFlight.has(busyKey)) {
      return refused(locale, "busy");
    }
    const release = admitVoiceSlot(tenant);
    if (!release) {
      return refused(locale, "busy");
    }
    inFlight.add(busyKey);

    // One cancel for the run. It fires for the caller's signal, the clock, or a tap request.
    const run = new AbortController();
    const stop: { why: "caller" | "timeout" | "tap" | null } = { why: null };
    const stopWith = (why: "caller" | "timeout" | "tap") => {
      if (stop.why === null) {
        stop.why = why;
        run.abort(new Error(`voice_ask_${why}`));
      }
    };
    const onCaller = () => stopWith("caller");
    input.signal.addEventListener("abort", onCaller, { once: true });
    const timer = setTimeout(() => stopWith("timeout"), options.timeoutMs ?? ASK_TIMEOUT_MS);
    const stopped = new Promise<"stopped">((resolve) =>
      run.signal.addEventListener("abort", () => resolve("stopped"), { once: true }),
    );

    const runId = `voice-ask-${crypto.randomUUID()}`;
    // What the run learned, in one object: the closures below write it and the code after the await
    // reads it, and a bare `let` would be narrowed to its first value on the way.
    const state: {
      model: string;
      /** True once the runtime is about to call the model: from there a call may be billed even if we stop. */
      contacted: boolean;
      usageRecorded: boolean;
      tapped: string | null;
      answer: string;
      failed: boolean;
      stepLimit: boolean;
    } = {
      model: "",
      contacted: false,
      usageRecorded: false,
      tapped: null,
      answer: "",
      failed: false,
      stepLimit: false,
    };

    const recordUsage = (usage: Record<string, unknown> | null) => {
      if (state.usageRecorded) {
        return;
      }
      state.usageRecorded = true;
      try {
        // The row a typed Chat turn writes (`runs.ts`), under the same mode.
        recordChatRunUsage(tenant, runId, true, usage);
      } catch {
        // The ledger never fails a spoken answer; `recordUsage` logs its own failure.
      }
    };

    const job = (async (): Promise<void> => {
      ensureVoiceToolsRegistered();
      const prepared = await prepareChatRun({
        tenant,
        threadId,
        modality: "text",
        // Thinking off: a spoken turn has about a second, and the Knowledge Base supplies the facts.
        body: { content: question, thinking: false },
        locale,
      });
      state.model = prepared.version.model;
      // The thread's earlier messages, then this question as the new turn. It is not stored. When the
      // relay already saved the question as the last row, it is not sent twice.
      const rows = await listMessages(tenant, threadId);
      const lastRow = rows[rows.length - 1];
      const earlier =
        lastRow && lastRow.role === "user" && textOf(lastRow.content as ContentPart[]) === question
          ? rows.slice(0, -1)
          : rows;
      const history = await prepareChatImageHistory(
        tenant,
        [...chatHistoryFromRows(earlier), { role: "user" as const, parts: prepared.userParts }],
        { model: state.model, locale },
      );
      const runtime = withChatMediaReferences(createRuntime(prepared.settings, toolMediaModels(tenant)));
      // Safe web search (SR-112): the same guard a typed turn builds, from the same inputs, so a search
      // or a page fetch is checked against the Knowledge Base text and the thread this run was given.
      const outbound = createOutboundGuard({
        userText: userTextOf(history),
        privateText: [...prepared.knowledge.privateText, ...attachedTextsOf(history)],
        figuresOnlyText: [prepared.pastHint],
        tainted: hasNonTextUserPart(history),
        locale,
      });
      const onEvent = (event: RuntimeEvent) => {
        if (event.type === "run.probing") {
          state.contacted = true;
        } else if (event.type === "assistant.delta") {
          state.answer += event.text;
        } else if (event.type === "tool.started" && event.toolKey === REQUEST_TAP_TOOL_KEY) {
          const args = event.input as { summary?: unknown } | null;
          state.tapped = tapSummary(args?.summary, question);
          stopWith("tap");
        } else if (event.type === "run.step_limit") {
          state.stepLimit = true;
        } else if (event.type === "run.completed") {
          recordUsage((event.usage as Record<string, unknown> | undefined) ?? null);
        }
      };
      await withToolRun({ runId, mode: prepared.agentPolicy ? prepared.agentPolicy.agent.id : "chat" }, () =>
        withRunContext({ threadId: prepared.thread.id, agentId: prepared.thread.agentId, locale }, () =>
          runOutboundGuarded(outbound, () =>
            runtime.execute({
              tenant,
              runId,
              modality: "text",
              version: { ...prepared.version, systemPrompt: prepared.version.systemPrompt + voiceNote(locale) },
              bindings: voiceBindings(prepared.bindings),
              budget: VOICE_BUDGET,
              history,
              mediaPermission: prepared.mediaPermission,
              thinking: prepared.thinkingEnabled,
              reasoningEffort: prepared.reasoningEffort,
              reasoningEffortExplicit: prepared.reasoningEffortExplicit,
              wire: prepared.wire,
              locale,
              signal: run.signal,
              onEvent,
            }),
          ),
        ),
      );
    })().catch((error: unknown) => {
      state.failed = true;
      // Only a code or a class: the question and the model's words are the person's, not the log's.
      log.warn("voice_ask_failed", {
        detail: error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown",
      });
    });

    try {
      await Promise.race([job, stopped]);
      // A tap wins over everything: the person asked for work, and the run was stopped on purpose.
      if (state.tapped !== null) {
        return {
          kind: "needs_tap",
          text: copy.needsTap,
          card: { prompt: question, summary: state.tapped },
        };
      }
      if (stop.why === "timeout") {
        return refused(locale, "timeout");
      }
      if (stop.why === "caller" || state.failed) {
        return refused(locale, "failed");
      }
      const text = speakable(state.answer);
      if (!text || state.stepLimit) {
        return refused(locale, "failed");
      }
      return { kind: "answer", text };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onCaller);
      // A stopped run never reaches `run.completed`, so the call it made is written as one of unknown size.
      if (state.contacted && !state.usageRecorded && state.model) {
        state.usageRecorded = true;
        try {
          recordTokenUsage(
            tenant,
            { model: state.model, inputTokens: 0, outputTokens: 0, unknown: true },
            { mode: "chat", runId },
          );
        } catch {
          // Same as above.
        }
      }
      inFlight.delete(busyKey);
      release();
    }
  } catch (error) {
    log.warn("voice_ask_failed", { detail: error instanceof Error ? error.name : "unknown" });
    return refused(locale, "failed");
  }
}
