import {
  DELEGATE_BUDGET,
  DELEGATE_SUMMARY_MAX,
  DELEGATE_TOOL_KEY,
  FULL_CHAT_TOOLS,
  createRuntime,
  delegateToolKeys,
  delegatedRunPrompt,
  delegatedTaskMessage,
  delegatedThreadTitle,
  productModeLabel,
  redactSecrets,
  redactSecretsDeep,
  takeLastToolIo,
  typedTextOf,
  withChatOutputLanguage,
  type ContentPart,
  type ReasoningEffort,
  type TenantContext,
  type ToolBindingRecord,
  type ToolCallPart,
} from "@agentforge/core";
import { DEFAULT_MODEL_TIER } from "@agentforge/core/tiers";
import { getRunContext, localeForRun, withRunContext } from "../run-context";
import { loadSettings } from "../settings-store";
import { defaultSelectableModel, listSelectableModels, toolMediaModels } from "../selectable-models";
import { agentService } from "../tenant";
import { chooseTierRun } from "../tier-resolve";
import { createThread, finishRun, insertMessage, insertRun, insertToolInvocation, listMessages } from "../threads";
import { withToolRun } from "../tool-run-context";
import { recordChatRunUsage } from "../usage-record";
import { delegationRoster, resolveDelegatable } from "../team-bots";
import { currentWorkerChannel, runWithWorkerProgress, withWorkerChannel, WORKER_MAX_MS } from "../workers/worker-channel";
import { currentDelegation, withDelegation } from "./delegation-context";

export type DelegateRefusal =
  | "nested"
  | "no_chat"
  | "not_hired"
  | "no_answer"
  | "failed"
  | "cancelled"
  | "timeout";

/** What the asking agent gets back. The asked agent's whole answer stays in its own conversation. */
export type DelegateResult =
  | {
      readonly ok: true;
      /** The asked agent's handle: a mode id (`research`, …) or a team bot's `tb-` slug. */
      readonly agent: string;
      /** Who was asked, for the asking agent to name in its answer: a mode's label or a bot's name. */
      readonly agentName: string;
      readonly thread: { readonly id: string };
      readonly summary: string;
      /** True when the answer was longer than the asking agent is shown. The rest is in the conversation. */
      readonly truncated: boolean;
      readonly toolsUsed: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: DelegateRefusal;
      readonly message: string;
      readonly agent?: string;
      readonly agentName?: string;
      readonly thread?: { readonly id: string };
    };

export type DelegateArgs = {
  /** A catalog mode id or one of the desk's team bots (`tb-` slug or name). */
  readonly agent: string;
  readonly task: string;
  readonly context?: string | undefined;
};

function refused(
  reason: DelegateRefusal,
  message: string,
  agent?: string,
  agentName?: string,
): DelegateResult {
  return {
    ok: false,
    reason,
    message,
    ...(agent ? { agent } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  return trimmed.length <= max
    ? { text: trimmed, truncated: false }
    : { text: `${trimmed.slice(0, max - 1).trimEnd()}…`, truncated: true };
}

/**
 * The model of a delegated run: the Daily tier, like a conversation that names no other. Plan decision
 * C6 leans to Fastest for sub-agents to save cost; the budget of a delegated run (`DELEGATE_BUDGET`)
 * already bounds the cost, and a hand-off whose answer the asking agent has to trust is worth the
 * better model. Changing the tier is this one line.
 */
function delegateModel(tenant: TenantContext): { model: string; effort: ReasoningEffort; explicit: boolean } {
  const catalog = listSelectableModels(tenant);
  try {
    const tier = chooseTierRun({ tier: DEFAULT_MODEL_TIER }, "text", catalog);
    if (tier) {
      return { model: tier.model, effort: tier.reasoning.effort, explicit: tier.reasoning.explicit };
    }
  } catch {
    // No model answers the tier right now (no live gateway): the desk's default model, as for any run.
  }
  return { model: defaultSelectableModel(catalog, tenant), effort: "medium", explicit: false };
}

/**
 * The person's own words in the conversation that asked, never the task. The egress guard reads the sites
 * a person named from these, so a site a model wrote into a task is not one the person asked to open.
 */
async function personText(tenant: TenantContext, threadId: string): Promise<string[]> {
  const rows = await listMessages(tenant, threadId);
  return rows.flatMap((row) => {
    if (row.role !== "user" || !Array.isArray(row.content)) {
      return [];
    }
    return (row.content as ContentPart[]).flatMap((part) => (part.type === "text" ? [typedTextOf(part.text)] : []));
  });
}

function humanTool(toolKey: string): string {
  return toolKey.replaceAll("_", " ");
}

/**
 * One delegation: a fresh run of an agent the desk has hired, on one written task, started from inside
 * the asking agent's run and returning the answer. What bounds it, all in code:
 * - Depth one: the asked run does not bind `delegate`, and `currentDelegation()` refuses a second try.
 * - Cost: the run's own budget (`DELEGATE_BUDGET`), a ceiling on delegations per turn in the asker's
 *   budget, and the worker ceiling of eight minutes. Its model use joins the tenant ledger as chat usage.
 * - Money and approvals: no picture or clip tools, and the desk's files only, never the owner's folder.
 * - Private text: the run starts as if it had read private material (the egress guard is tainted) and
 *   knows only the person's own words as sites they named, so a task cannot launder a fetch.
 * - What the owner sees: the task and the answer are kept as a conversation of the asked agent.
 */
export async function runDelegation(args: DelegateArgs, tenant: TenantContext): Promise<DelegateResult> {
  if (currentDelegation()) {
    return refused("nested", "A delegated agent cannot delegate again. Do the task yourself, or say what is missing.");
  }
  const asking = getRunContext();
  if (!asking) {
    return refused("no_chat", "delegate works from inside a conversation with an agent, and this is not one.");
  }
  const asked = args.agent.trim();
  const target = await resolveDelegatable(tenant, asked);
  if (!target) {
    const roster = await delegationRoster(tenant);
    const names = [...roster.modes, ...roster.bots.map((bot) => bot.name)];
    return refused(
      "not_hired",
      names.length > 0
        ? `No agent called "${asked}" is on the owner's desk. Agents you can ask: ${names.join(", ")}.`
        : `No agent called "${asked}" is on the owner's desk, and no other agent is on it either. The owner can hire one on the Virtual agents page.`,
      asked,
    );
  }

  // A mode agent runs its registry prompt and tool set; a team bot runs its own published prompt
  // with the full chat tool set minus the delegation exclusions, as a `chat`-mode run.
  const agentKey = target.kind === "mode" ? target.agent.id : target.bot.slug;
  const agentName = target.kind === "mode" ? productModeLabel(target.agent.id) : target.bot.name;
  const label = target.kind === "mode" ? `${agentName} agent` : agentName;
  const toolRunMode = target.kind === "mode" ? target.agent.id : "chat";

  const published = await agentService.getPublishedForRun(tenant, target.row.id);
  const basePrompt = target.kind === "mode" ? target.agent.prompt : published.version.systemPrompt;
  const toolKeys =
    target.kind === "mode" ? delegateToolKeys(target.agent) : delegateToolKeys({ tools: FULL_CHAT_TOOLS });
  const locale = localeForRun();
  const { model, effort, explicit } = delegateModel(tenant);
  const message = delegatedTaskMessage(args.task, args.context);
  const knownSites = await personText(tenant, asking.threadId);

  const thread = await createThread(tenant, target.row.id, delegatedThreadTitle(args.task));
  if (!thread) {
    return refused("failed", "The task could not be started.", agentKey, agentName);
  }
  await insertMessage(tenant, thread.id, "user", [{ type: "text", text: message }]);
  const run = await insertRun(tenant, thread.id, published.version.id, "text");
  if (!run) {
    return refused("failed", "The task could not be started.", agentKey, agentName);
  }

  const bindings: ToolBindingRecord[] = toolKeys.map((toolKey) => ({
    id: `delegate-${agentKey}-${toolKey}`,
    agentVersionId: published.version.id,
    organizationId: published.version.organizationId,
    toolKey,
    config: {},
    enabled: true,
  }));
  const version = {
    ...published.version,
    model,
    systemPrompt: withChatOutputLanguage(delegatedRunPrompt({ prompt: basePrompt }), locale),
  };

  const deadline = AbortSignal.timeout(WORKER_MAX_MS);
  const askerSignal = currentWorkerChannel()?.signal;
  const signal = AbortSignal.any(askerSignal ? [deadline, askerSignal] : [deadline]);

  let answer = "";
  let failure = "";
  let usage: Record<string, unknown> | null = null;
  let stepLimit = false;
  const trace: ToolCallPart[] = [];
  const used = new Set<string>();

  const persist = async (status: "completed" | "failed", error?: string): Promise<void> => {
    const parts: ContentPart[] = [...trace];
    if (answer.trim()) {
      parts.push({ type: "text", text: answer.trim() });
    }
    if (parts.length > 0) {
      await insertMessage(tenant, thread.id, "assistant", parts);
    }
    const finished = await finishRun(tenant, run.id, status, error, usage);
    // The asked run spent the tenant's tokens, so it joins the ledger like any chat run.
    recordChatRunUsage(tenant, run.id, finished, usage);
  };

  const delegation = { agent: agentKey, fromThreadId: asking.threadId, threadId: thread.id };
  try {
    await withDelegation(delegation, () =>
      withToolRun({ runId: run.id, mode: toolRunMode }, () =>
        withRunContext({ threadId: thread.id, agentId: target.row.id, locale }, () =>
          runWithWorkerProgress(DELEGATE_TOOL_KEY, async (emit) => {
            emit({ type: "job.phase", phase: "delegating", label });
            // A worker the asked agent runs (a dossier) reports to the asker's own row, not to a row of its own.
            return withWorkerChannel({ emit: (_toolKey, job) => emit(job), signal }, () =>
              createRuntime(loadSettings(tenant), toolMediaModels(tenant)).execute({
                tenant,
                runId: run.id,
                modality: "text",
                version,
                bindings,
                history: [{ role: "user", parts: [{ type: "text", text: message }] }],
                thinking: effort !== "none",
                reasoningEffort: effort,
                reasoningEffortExplicit: explicit,
                locale,
                signal,
                budget: DELEGATE_BUDGET,
                egress: { userText: knownSites, tainted: true },
                onEvent: async (event) => {
                  switch (event.type) {
                    case "assistant.delta":
                      answer += event.text;
                      return;
                    case "run.failed":
                      failure = redactSecrets(event.message);
                      return;
                    case "run.completed":
                      if (event.usage) {
                        usage = event.usage;
                      }
                      return;
                    case "run.step_limit":
                      stepLimit = true;
                      return;
                    case "tool.started": {
                      const input = redactSecretsDeep(event.input);
                      trace.push({ type: "tool_call", toolKey: event.toolKey, status: "started", input });
                      await insertToolInvocation(tenant, run.id, event.toolKey, input, null, "started");
                      emit({
                        type: "job.step",
                        phase: "delegating",
                        label: `${label}: ${humanTool(event.toolKey)}`,
                      });
                      return;
                    }
                    case "tool.completed": {
                      const recorded = takeLastToolIo(event.toolKey);
                      const output = redactSecretsDeep(event.output);
                      const last = [...trace]
                        .reverse()
                        .find((item) => item.toolKey === event.toolKey && item.status === "started");
                      if (last) {
                        last.status = "completed";
                        last.output = output;
                      } else {
                        trace.push({ type: "tool_call", toolKey: event.toolKey, status: "completed", output });
                      }
                      used.add(event.toolKey);
                      await insertToolInvocation(
                        tenant,
                        run.id,
                        event.toolKey,
                        null,
                        redactSecretsDeep(recorded?.full ?? event.output),
                        "completed",
                      );
                      return;
                    }
                    default:
                      return;
                  }
                },
              }),
            );
          }),
        ),
      ),
    );
  } catch (error) {
    const stopped = askerSignal?.aborted === true ? "cancelled" : deadline.aborted ? "timeout" : null;
    const detail = redactSecrets(error instanceof Error ? error.message : "The delegated run failed.");
    await persist("failed", stopped ?? detail).catch(() => undefined);
    const threadRef = { id: thread.id };
    if (stopped === "cancelled") {
      return { ok: false, reason: "cancelled", message: "The run was stopped.", agent: agentKey, agentName, thread: threadRef };
    }
    if (stopped === "timeout") {
      return {
        ok: false,
        reason: "timeout",
        message: `The ${label} did not finish in time. Whatever it had done is in its conversation.`,
        agent: agentKey,
        agentName,
        thread: threadRef,
      };
    }
    return { ok: false, reason: "failed", message: detail, agent: agentKey, agentName, thread: threadRef };
  }

  const { text: summary, truncated } = clip(redactSecrets(answer), DELEGATE_SUMMARY_MAX);
  if (summary === "") {
    const message =
      failure !== ""
        ? failure
        : stepLimit
          ? `The ${label} used all its steps without writing an answer. What it did is in its conversation.`
          : `The ${label} did not write an answer.`;
    await persist("failed", message);
    return { ok: false, reason: failure !== "" ? "failed" : "no_answer", message, agent: agentKey, agentName, thread: { id: thread.id } };
  }
  await persist("completed");
  return {
    ok: true,
    agent: agentKey,
    agentName,
    thread: { id: thread.id },
    summary,
    truncated,
    toolsUsed: [...used],
  };
}
