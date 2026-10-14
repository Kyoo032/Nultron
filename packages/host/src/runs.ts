import {
  assertAgentSupportsModality,
  assertChatModelAcceptsModality,
  createRuntime,
  encodeSse,
  redactSecrets,
  redactSecretsDeep,
  abortErrorMessage,
  isDefaultChatAgent,
  parseImageRunInput,
  parseTextRunInput,
  parseVideoRunInput,
  readOptionalModel,
  readReasoningEffortChoice,
  readOptionalChatWire,
  resolveChatModel,
  hasModelVisibleContent,
  modelHistoryParts,
  redactAttachedParts,
  attachmentsAsMentions,
  takeLastToolIo,
  type ContentPart,
  type InputModality,
  type TenantContext,
  type ToolBindingRecord,
  type ToolCallPart,
  withChatOutputLanguage,
  withoutDisabledToolSentences,
  bindingsForChatModality,
  chatTurnCopy,
  settleChatTurn,
} from "@agentforge/core";
import { ApiError } from "@agentforge/core";
import { agentService } from "./tenant";
import { armRunStallGuard, isRunOutputEvent } from "./run-stall";
import { knowledgeInjection } from "./knowledge";
import { workspaceForRun, workspacePromptBlock } from "./projects/service";
import { citedSources } from "./knowledge-cites";
import { recordCites } from "./knowledge-graph";
import { recordRetrievals, recordsRetrievals } from "./knowledge-retrievals";
import { ingestWorkSource } from "./knowledge-ingest";
import { chatWorkCard } from "./work-cards";
import { withChatMediaReferences } from "./chat-media-resolver";
import {
  finishRun,
  getThread,
  insertMessage,
  insertRun,
  insertToolInvocation,
  listMessages,
  setThreadTitleFromParts,
} from "./threads";
import { redactToolEvent } from "./chat-tool-events";
import { historyMediaPart, historyToolNote } from "./chat-history-note";
import { ensureToolsRegistered } from "./register-tools";
import { recordChatRunUsage } from "./usage-record";
import { loadSettings, loadUserLocale } from "./settings-store";
import { defaultSelectableModel, listSelectableModels } from "./selectable-models";
import { resolveTierRun } from "./tier-resolve";
import { markJobModelDown, maySwapModel, pickNext, startModel } from "./job-model-fallback";
import { readModelPinned } from "./job-regen";
import { collectToolMediaParts } from "./tool-media";
import { assertChatImagesSendable, prepareChatImageHistory, type ChatTurn } from "./chat-image-history";
import { saveGeneratedImage, saveGeneratedVideo } from "./media";
import { getRunContext, hostedRequestLocale, localeForRun, withRunContext } from "./run-context";
import { withToolRun } from "./tool-run-context";
import type { JobEvent } from "@agentforge/core/jobs";
import { DEFAULT_CHAT_MODALITIES, GENERALIST_WORKER_PROMPT, virtualAgentFor } from "@agentforge/core";
import { runPolicyFor, withGeneralistWorkers } from "./virtual-agents";
import { WORKER_STREAM_IDLE_MS, withWorkerChannel } from "./workers/worker-channel";
import { formatPastSessionsHint } from "./session-recall";
import { log } from "./log";

/** The longest reason the closing sentence of an interrupted turn carries: a failure's headline, not a stack. */
const INTERRUPTED_REASON_MAX = 400;

const parsers = {
  text: parseTextRunInput,
  image: parseImageRunInput,
  video: parseVideoRunInput,
} as const;

class StringQueue {
  private items: string[] = [];
  private waiters: Array<(next: IteratorResult<string>) => void> = [];
  private closed = false;

  push(item: string): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as unknown as string, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as string;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<string>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

function withPastSessionsBinding(bindings: ToolBindingRecord[]): ToolBindingRecord[] {
  if (bindings.some((binding) => binding.toolKey === "past_sessions" && binding.enabled)) {
    return bindings;
  }
  return [
    ...bindings,
    {
      id: "past-sessions-local",
      agentVersionId: bindings[0]?.agentVersionId ?? "",
      organizationId: bindings[0]?.organizationId ?? "",
      toolKey: "past_sessions",
      config: {},
      enabled: true,
    },
  ];
}

export async function* startModalityRun(options: {
  tenant: TenantContext;
  threadId: string;
  modality: InputModality;
  body: unknown;
  abortSignal?: AbortSignal;
}): AsyncIterable<string> {
  ensureToolsRegistered();
  const parsed = parsers[options.modality](options.body as { content?: unknown; stream?: unknown });
  const settings = loadSettings(options.tenant);
  const userParts = settings.injectionGuardBypass === true ? parsed.parts : redactAttachedParts(parsed.parts);
  // A body that names a `tier` gets its model and Thinking choice from the tier, and the body's own
  // `thinking` and `reasoningEffort` are never read. A body that names none is `null` and runs as before.
  const tierRun = resolveTierRun({ body: options.body, modality: options.modality, tenant: options.tenant });
  // `explicit` is what lets the runtime send a model it has never seen no effort at all unless the
  // person picked one; the level alone cannot say that.
  const { effort: reasoningEffort, explicit: reasoningEffortExplicit } =
    tierRun?.reasoning ?? readReasoningEffortChoice(options.body);
  const thinkingEnabled = reasoningEffort !== "none";
  const wire = readOptionalChatWire(options.body);
  const thread = await getThread(options.tenant, options.threadId);
  if (!thread) {
    throw new ApiError("not_found", "Thread not found", 404);
  }
  const published = await agentService.getPublishedForRun(options.tenant, thread.agentId);
  const catalog = listSelectableModels(options.tenant);
  const defaultChat = isDefaultChatAgent(published.agent);
  // Tester code: a mode agent's conversation. Its prompt, tools and budget come from the registry in
  // code, never from the agent row (`./virtual-agents.ts`). Null for Chat and for an agent a person built.
  const agentPolicy = runPolicyFor(published);
  // The host picks the model for Chat and for a mode agent; an agent a person built is pinned to its own.
  const hostPicksModel = defaultChat || agentPolicy != null;
  const fallback = hostPicksModel ? defaultSelectableModel(catalog, options.tenant) : published.version.model;
  const requestedModel = readOptionalModel(options.body);
  const model = tierRun?.model ?? resolveChatModel(requestedModel, fallback, catalog);
  // Only the default Chat agent on the host's own default model may be moved to a stand-in when the
  // gateway cannot reach it. The composer sends `model` on every turn, so a pick is any model other than
  // the default, or one the picker marked `modelPinned`; an agent the owner built is pinned to its model.
  // A tier chooses its model on the host side (tester code), so it is never moved to a stand-in either.
  const modelExplicit = tierRun != null || !hostPicksModel || readModelPinned(options.body) || model !== fallback;
  // A mode agent is a full chat (owner, 2026-10-09), so it gets what Chat gets: its own earlier
  // conversations and the desk's Knowledge Base. The egress guard bounds both the same way for both.
  const pastHint = await formatPastSessionsHint(options.tenant, thread.agentId, thread.id);
  const userText = userParts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
  // The thread's own work card is skipped so Chat never retrieves its last reply back into itself.
  // A chat started in a Workspace (W1) searches that Workspace's sources too, and no other Workspace's.
  // Checked on every run (K-D22): a person who left, or an agent that was taken out, runs as an ordinary chat.
  const projectId = workspaceForRun(options.tenant, thread.projectId ?? null, published.agent.slug);
  const knowledge = await knowledgeInjection(options.tenant, userText, { excludeThreadId: thread.id, projectId });
  // Phase 4: the language of the person who sent the message, not the language the process booted
  // in. On a desk they are the same value, because `saveUserLocale` writes both; on a hosted server
  // two people on one desk each get their own, and `withRunContext` below carries it through every
  // `localeForRun()` in the run.
  //
  // Hosted, the request already knows it: the person's stored choice, or the browser's language for
  // someone who never chose (`sessionLocale`), so Chat answers in the language the screen is in. Off
  // server mode no request locale is set and this is `loadUserLocale`, exactly as before.
  const locale = hostedRequestLocale() ?? loadUserLocale(options.tenant);
  // The model is only told about tools this run offers: a tool that is off (code runs on the hosted
  // server, or turned off in Settings) loses its sentence in the prompt, so it is not invited to call it.
  // Every virtual agent is also told about the harnesses it can run from its own chat (tester code): a
  // mode agent's prompt carries that paragraph already, and the default agent's gains it here.
  const agentPrompt = agentPolicy
    ? withoutDisabledToolSentences(agentPolicy.systemPrompt, settings.disabledTools ?? [])
    : withoutDisabledToolSentences(published.version.systemPrompt, settings.disabledTools ?? []) +
      (defaultChat ? GENERALIST_WORKER_PROMPT : "");
  const version = {
    ...published.version,
    model,
    // A mode agent has the last word on who is speaking, after the desk's Soul block (`closingPrompt`).
    systemPrompt: withChatOutputLanguage(
      agentPrompt +
        workspacePromptBlock(options.tenant, projectId) +
        pastHint +
        knowledge.prompt +
        (agentPolicy?.closingPrompt ?? ""),
      locale,
    ),
  };
  // A mode agent takes what Chat takes (text, pictures, video), whatever its row was created with.
  assertAgentSupportsModality(
    agentPolicy ? [...DEFAULT_CHAT_MODALITIES] : published.version.inputModalities,
    options.modality,
  );
  // An image goes to any model not known to be text-only; a model we have no line for is tried, and
  // refused by the gateway in words if it cannot (`chat-image-history.ts`, `image-input.ts`).
  assertChatModelAcceptsModality(version.model, options.modality);

  const queue = new StringQueue();
  let queueClosed = false;
  const closeQueue = () => {
    queueClosed = true;
    queue.close();
  };
  const send = (event: Parameters<typeof encodeSse>[0]) => {
    queue.push(encodeSse(event));
  };
  queue.push(": connected\n\n");
  // Shared with `work` so the watchdog / client-abort paths can finalize the run row. Without this a
  // run whose model call never answers stays `streaming` forever (observed under a hung gateway).
  let runId: string | null = null;
  // True once the watchdog or a client abort reported failure. The user has seen `run.failed`, so a
  // model answer that arrives later is dropped instead of being persisted as a completed turn.
  let settled = false;
  let settledMessage = "";
  // The model call's own cancel. The watchdog and a client that left both tell the person the run
  // failed; this is what makes the request in flight stop, so a run nobody is waiting for stops billing.
  const modelAbort = new AbortController();
  const settleRun = (message: string) => {
    settled = true;
    settledMessage = message;
    if (!runId) {
      // The row does not exist yet; `work` finalizes it right after insertRun (see below).
      return;
    }
    void finishRun(options.tenant, runId, "failed", message, null).catch(() => undefined);
  };
  // Rearmed by every runtime event below, so it guards the first token and then the gaps
  // between them instead of capping the whole run.
  const stall = armRunStallGuard({
    model,
    locale,
    onStall: (message) => {
      if (queueClosed) {
        return;
      }
      send({ type: "run.failed", message });
      send({ type: "run.completed", runId: runId ?? "unknown" });
      closeQueue();
      settleRun(message);
      modelAbort.abort(new Error(message));
    },
  });
  const onClientAbort = () => {
    if (queueClosed) {
      return;
    }
    const message = abortErrorMessage(options.abortSignal?.reason, locale);
    send({ type: "run.failed", message });
    send({ type: "run.completed", runId: runId ?? "unknown" });
    closeQueue();
    settleRun(message);
    modelAbort.abort(options.abortSignal?.reason);
  };
  options.abortSignal?.addEventListener("abort", onClientAbort, { once: true });
  // A disconnect that landed while the thread, the model list and the knowledge were being read has
  // already fired: an aborted signal never calls a listener added after the fact.
  if (options.abortSignal?.aborted) {
    onClientAbort();
  }

  const work = (async () => {
    let assistantText = "";
    // The model's own words, kept before the host's closing sentence is added. The Knowledge card reads these.
    let modelAnswer = "";
    let thinkingText = "";
    // Lines the host wrote into Thinking itself (the model-fallback notice, "looking at the attachment").
    // They are shown live, and saved only beside something the model produced: on their own they are not
    // an answer, and a thinking-only message would mark a failed run as completed.
    let hostThinking = "";
    let failedMessage = "";
    const mediaParts: ContentPart[] = [];
    const toolTrace: ToolCallPart[] = [];
    let persisted = false;
    // Set when the runtime says the tool loop used every step and the last one was still working.
    let stepLimitReached = false;
    // Set when a model call failed after a tool had completed: the turn is kept, and this is the reason.
    let interruptedReason = "";
    let runUsage: Record<string, unknown> | null = null;
    let settledRunMetered = false;
    /**
     * A run the watchdog or a client abort already finished as `failed` never reaches the
     * `finishRun`-gated metering below, yet a call that completed at the gateway was billed. It joins
     * the tenant ledger here, once, from whichever of the three exits sees the usage first.
     */
    const meterSettledRun = () => {
      if (settledRunMetered || !runId || !runUsage) {
        return;
      }
      settledRunMetered = true;
      recordChatRunUsage(options.tenant, runId, true, runUsage);
    };
    const persistAssistant = async () => {
      if (persisted) {
        return true;
      }
      const replyLocale = getRunContext() ? localeForRun() : locale;
      modelAnswer = assistantText;
      const settled = settleChatTurn({
        text: assistantText,
        offeredSources: knowledge.chunks.length,
        tools: toolTrace,
        locale: replyLocale,
        stepLimit: stepLimitReached,
        interrupted: interruptedReason,
      });
      if (settled.appended) {
        send({ type: "assistant.delta", text: settled.appended });
      }
      assistantText = settled.text;
      const assistantParts: ContentPart[] = [];
      const producedContent =
        thinkingText.trim().length > 0 ||
        toolTrace.length > 0 ||
        assistantText.trim().length > 0 ||
        mediaParts.length > 0;
      const savedThinking = (producedContent ? `${hostThinking}${thinkingText}` : "").trim();
      if (savedThinking) {
        assistantParts.push({ type: "thinking", text: savedThinking });
      }
      for (const tool of toolTrace) {
        assistantParts.push(tool);
      }
      if (assistantText.trim()) {
        assistantParts.push({ type: "text", text: assistantText.trim() });
      }
      if (settled.stepLimit) {
        assistantParts.push({ type: "step_limit", tools: settled.stepLimit.tools });
      }
      assistantParts.push(...mediaParts);
      if (assistantParts.length === 0) {
        return false;
      }
      await insertMessage(options.tenant, thread.id, "assistant", assistantParts);
      persisted = true;
      return true;
    };
    try {
      // A picture that cannot be sent is refused before the message is stored, so the refusal does not
      // leave a bubble with no answer. This reads each image's row, not its bytes; the run reads those.
      await assertChatImagesSendable(options.tenant, userParts, { locale });
      await insertMessage(options.tenant, thread.id, "user", userParts);
      // The title names an attached file, never starts with its text or the host's notes about it.
      await setThreadTitleFromParts(
        options.tenant,
        thread.id,
        userParts.map((part) => (part.type === "text" ? { ...part, text: attachmentsAsMentions(part.text) } : part)),
      );
      const run = await insertRun(options.tenant, thread.id, published.version.id, options.modality);
      runId = run.id;
      if (settled) {
        // Client went away (or the watchdog fired) while the user message was being stored.
        await finishRun(options.tenant, run.id, "failed", settledMessage || "client_disconnected", null);
        return;
      }
      const historyRows = await listMessages(options.tenant, thread.id);
      const storedHistory: ChatTurn[] = [];
      for (const row of historyRows) {
        if (row.role !== "user" && row.role !== "assistant") {
          continue;
        }
        const parts = row.content as ContentPart[];
        if (row.role === "assistant" && !hasModelVisibleContent(parts)) {
          continue;
        }
        // An assistant turn's stored media is named by reference, so a later turn can edit it (chat-history-note.ts).
        const media = row.role === "assistant" ? historyMediaPart(parts) : null;
        const modelParts = modelHistoryParts(parts);
        storedHistory.push({
          role: row.role as "user" | "assistant",
          parts: media ? [...modelParts, media] : modelParts,
        });
      }
      // The latest assistant turn also tells the model what its tools returned, so "continue" does not run
      // them again. Older turns stay text only.
      const lastAssistantRow = [...historyRows].reverse().find((row) => row.role === "assistant");
      const lastAssistantTurn = [...storedHistory].reverse().find((turn) => turn.role === "assistant");
      if (lastAssistantRow && lastAssistantTurn && hasModelVisibleContent(lastAssistantRow.content as ContentPart[])) {
        const note = historyToolNote(lastAssistantRow.content as ContentPart[]);
        if (note) {
          lastAssistantTurn.parts = [...lastAssistantTurn.parts, { type: "text", text: note }];
        }
      }
      // Images leave as bytes, within one budget, or the person is told why they cannot. A stored
      // `/api/v1/media/...` reference is never handed on: no remote model can open it.
      const history = await prepareChatImageHistory(options.tenant, storedHistory, { model, locale });
      const runtime = withChatMediaReferences(createRuntime(settings));
      send({ type: "run.started", runId: run.id });

      // Model fallback, as jobs have it (`job-model-fallback.ts`): when the model this turn was given cannot
      // be reached before it has produced anything, the same turn runs once on the next live model of the
      // same gateway. Never when the person picked the model, and never once it has streamed a word.
      let activeModel = model;
      let activeVersion = version;
      let modelSpoke = false;
      let retried = false;
      let heldNext: string | undefined;
      const fallbackOptions = modelExplicit
        ? undefined
        : {
            model,
            availableModelIds: catalog.map((entry) => entry.id),
            signal: modelAbort.signal,
            // The down circuit is per company: this turn's outage is not another company's.
            tenant: options.tenant,
          };
      const acceptsModality = (id: string) => {
        try {
          assertChatModelAcceptsModality(id, options.modality);
          return true;
        } catch {
          return false;
        }
      };
      const fallbackFor = (from: string, failure: string): string | undefined => {
        if (!fallbackOptions || retried || settled) {
          return undefined;
        }
        if (!maySwapModel({ error: new Error(failure), streamed: false }, fallbackOptions)) {
          return undefined;
        }
        const next = pickNext(fallbackOptions, from, Date.now());
        return next && acceptsModality(next) ? next : undefined;
      };
      const announceFallback = (from: string, to: string) => {
        const message = chatTurnCopy(locale).modelFallback.replaceAll("{from}", from).replaceAll("{to}", to);
        send({ type: "run.model_fallback", from, to, message });
        if (thinkingEnabled) {
          const line = `${message}\n`;
          hostThinking += line;
          send({ type: "assistant.thinking", text: line });
        }
        stall.touch();
      };
      if (fallbackOptions) {
        // A model this process already saw unreachable is skipped before the first try, not after it.
        const started = startModel(fallbackOptions, Date.now());
        if (started !== model && acceptsModality(started)) {
          activeModel = started;
          activeVersion = { ...version, model: started };
          announceFallback(model, started);
        }
      }

      // `withRunContext` is thread-scoped; a tool that records an author (a file write) reads the
      // tool-run context, so Chat sets it too, keyed by this turn's run. Without it the author of
      // every file written in a conversation was the thread id.
      // A worker tool sends its harness's progress here. Each event is also a sign of life: a dossier
      // spends minutes inside one tool call, and without it the stall guard would end the run.
      const workerChannel = {
        emit: (toolKey: string, job: JobEvent) => {
          if (queueClosed || settled) {
            return;
          }
          stall.touch();
          // The result travels in `tool.completed`; a harness's own closing events are not for the thread.
          if (job.type === "job.phase" || job.type === "job.step" || job.type === "job.round") {
            send({ type: "tool.progress", toolKey, job });
          }
        },
        signal: modelAbort.signal,
      };
      const inChatRun = <T>(fn: () => Promise<T>): Promise<T> =>
        withToolRun({ runId: run.id, mode: agentPolicy ? agentPolicy.agent.id : "chat" }, () =>
          withRunContext({ threadId: thread.id, agentId: thread.agentId, locale, projectId }, () =>
            withWorkerChannel(workerChannel, fn),
          ),
        );
      const attempt = () =>
        inChatRun(async () => {
          if (options.modality !== "text" && thinkingEnabled && !retried) {
            const line = `${chatTurnCopy(localeForRun()).lookingAttached}\n`;
            hostThinking += line;
            send({ type: "assistant.thinking", text: line });
          }
          await runtime.execute({
            tenant: options.tenant,
            runId: run.id,
            modality: options.modality,
            version: activeVersion,
            bindings: agentPolicy
              ? bindingsForChatModality(agentPolicy.bindings, options.modality)
              : bindingsForChatModality(
                  // The default agent can run every wired harness from its own chat, hired or not.
                  defaultChat
                    ? withGeneralistWorkers(withPastSessionsBinding(published.bindings))
                    : withPastSessionsBinding(published.bindings),
                  options.modality,
                ),
            // The default agent's budget is Chat's declared one plus a ceiling for each worker; a mode
            // agent's is its own; an agent the owner built keeps the runtime's.
            ...(agentPolicy
              ? { budget: agentPolicy.budget }
              : defaultChat
                ? { budget: virtualAgentFor("chat").budget }
                : {}),
            history,
            thinking: thinkingEnabled,
            reasoningEffort,
            reasoningEffortExplicit,
            wire,
            locale,
            signal: modelAbort.signal,
            // A run that binds a worker: the runtime's own stream watchdog must not read a working tool
            // as a dead stream. The stall guard above keeps the model's budget (`worker-channel.ts`).
            ...(agentPolicy || defaultChat ? { streamWatchdog: { idleMs: WORKER_STREAM_IDLE_MS } } : {}),
            onEvent: async (event) => {
              stall.touch();
              if (isRunOutputEvent(event)) {
                stall.touchOutput();
              }
              if (isRunOutputEvent(event)) {
                modelSpoke = true;
              }
              if (event.type === "run.failed") {
                const next = modelSpoke ? undefined : fallbackFor(activeModel, event.message);
                if (next) {
                  // Held, not sent: the catch below retries once on `next` and the person never sees this one.
                  heldNext = next;
                  return;
                }
                failedMessage = redactSecrets(event.message);
                send({ ...event, message: failedMessage });
                return;
              }
              if (event.type === "run.completed") {
                if (event.usage) {
                  runUsage = event.usage;
                }
                if (settled) {
                  // The person was already told this run failed. A call that finished just before the
                  // cancel keeps its bill, but its answer is not saved on a run marked `failed`.
                  meterSettledRun();
                  return;
                }
                await persistAssistant();
                send(event);
                return;
              }
              if (event.type === "run.step_limit") {
                // Not a frame for the screen: it decides the closing sentence `persistAssistant` adds.
                stepLimitReached = true;
                return;
              }
              if (event.type === "run.interrupted") {
                // Same: not a frame, the closing sentence. The reason is a failure's text, so it is masked
                // like `run.failed`'s, and held to one short paragraph.
                interruptedReason = redactSecrets(event.message).trim().slice(0, INTERRUPTED_REASON_MAX);
                return;
              }
              // What leaves the runtime (the screen, the thread, the tool rows) is the redacted copy of a
              // tool's input and output. `event` stays the runtime's own: media is read from it below.
              const safe = redactToolEvent(event);
              send(safe);
              if (event.type === "assistant.delta") {
                assistantText += event.text;
              }
              if (event.type === "assistant.thinking") {
                thinkingText += event.text;
              }
              if (safe.type === "tool.started") {
                toolTrace.push({
                  type: "tool_call",
                  toolKey: safe.toolKey,
                  status: "started",
                  input: safe.input,
                });
                await insertToolInvocation(options.tenant, run.id, safe.toolKey, safe.input, null, "started");
              }
              if (safe.type === "tool.completed" && event.type === "tool.completed") {
                const recorded = takeLastToolIo(event.toolKey);
                const fullOutput = recorded?.full ?? event.output;
                const persistOutput = redactSecretsDeep(fullOutput);
                const last = [...toolTrace]
                  .reverse()
                  .find((item) => item.toolKey === safe.toolKey && item.status === "started");
                if (last) {
                  last.status = "completed";
                  last.output = safe.output;
                } else {
                  toolTrace.push({
                    type: "tool_call",
                    toolKey: safe.toolKey,
                    status: "completed",
                    output: safe.output,
                  });
                }
                await insertToolInvocation(options.tenant, run.id, safe.toolKey, null, persistOutput, "completed");
                for (const part of collectToolMediaParts(fullOutput)) {
                  // Every generated URL is mirrored into the local store first: the renderer
                  // only loads host-served media, so a part we cannot mirror is dropped
                  // rather than persisted as a remote URL that would never display.
                  const mirrored = await mirrorToolMediaPart(options.tenant, part);
                  if (mirrored) {
                    mediaParts.push(mirrored);
                  }
                }
              }
            },
          });
        });
      try {
        await attempt();
      } catch (error) {
        if (!heldNext) {
          throw error;
        }
      }
      if (heldNext && !settled) {
        // The default model was unreachable and had said nothing: one more try on the next live model.
        // The held `run.failed` is dropped; if this try fails too, its own failure is what the person gets.
        const next = heldNext;
        heldNext = undefined;
        retried = true;
        markJobModelDown(activeModel, Date.now(), options.tenant);
        announceFallback(activeModel, next);
        activeModel = next;
        activeVersion = { ...version, model: next };
        await attempt();
      }
      if (settled) {
        // Covers a cancel that landed while the completed event was still being handled.
        meterSettledRun();
        return;
      }
      await persistAssistant();
      const finished = await finishRun(options.tenant, run.id, "completed", undefined, runUsage);
      // Chat spend joins the tenant ledger here, guarded by `finished`: `finishRun` only transitions
      // a `streaming` row, so whichever of the watchdog, the client abort and the completion settles
      // first writes exactly one usage row (Phase 5 lane A).
      recordChatRunUsage(options.tenant, run.id, finished, runUsage);
      // The Retrieved edge of the knowledge loop: one row per chunk this run was actually given.
      // Counted only for a completed run, and never allowed to fail one.
      if (recordsRetrievals(finished, "completed")) {
        recordRetrievals(options.tenant, {
          threadId: thread.id,
          runId: run.id,
          backend: knowledge.backend,
          chunks: knowledge.chunks,
        });
        // The Cited edge of the loop: what the reply itself pointed at with its `[n]` markers, as
        // opposed to what it was offered above. Same once-per-completed-turn discipline, and just
        // as unable to fail the run — an empty citation set writes nothing.
        recordCites(options.tenant, {
          threadId: thread.id,
          sourceIds: citedSources(assistantText, knowledge.chunks),
        });
      }
      if (finished && modelAnswer.trim()) {
        // Fire-and-forget: indexing must not delay stream end. One card per thread, latest exchange only.
        // Anything that goes wrong here is a knowledge concern, never a run failure.
        try {
          const fresh = await getThread(options.tenant, thread.id).catch(() => null);
          ingestWorkSource(
            options.tenant,
            chatWorkCard({
              threadId: thread.id,
              title: fresh?.title ?? "",
              // An attached file is named in the card, not carried into it: its text is in the person's
              // own private desk copy, and this card is read from the desk-wide Knowledge Base.
              userText: attachmentsAsMentions(userText),
              assistantText: modelAnswer,
              model: activeModel,
            }),
          );
        } catch (error) {
          log.warn("knowledge_ingest_chat_card_skipped", {
            detail: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    } catch (error) {
      if (settled) {
        meterSettledRun();
        return;
      }
      const message = redactSecrets(error instanceof Error ? error.message : "run_failed");
      const saved = await persistAssistant();
      if (runId) {
        const status = saved ? "completed" : "failed";
        const finished = await finishRun(options.tenant, runId, status, saved ? undefined : message, runUsage);
        // A run that broke mid-stream still reached the gateway and still cost the tenant money, so
        // it is metered on the same terms as the happy path.
        recordChatRunUsage(options.tenant, runId, finished, runUsage);
        // A run that broke mid-stream but still saved partial text ends `completed`, and it was
        // given the same chunks the happy path was. Counting it there and not here would undercount
        // the Retrieved edge exactly when retrieval is most worth measuring.
        if (recordsRetrievals(finished, status)) {
          recordRetrievals(options.tenant, {
            threadId: thread.id,
            runId,
            backend: knowledge.backend,
            chunks: knowledge.chunks,
          });
          // A run that broke mid-stream but still saved partial text was given the same chunks and
          // may cite the same sources; its Cited edge is counted here or not at all.
          recordCites(options.tenant, {
            threadId: thread.id,
            sourceIds: citedSources(assistantText, knowledge.chunks),
          });
        }
      }
      if (!saved && !failedMessage) {
        send({ type: "run.failed", message });
      }
      send({ type: "run.completed", runId: runId ?? "unknown" });
    } finally {
      stall.close();
      options.abortSignal?.removeEventListener("abort", onClientAbort);
      closeQueue();
    }
  })();

  try {
    yield* queue;
  } finally {
    // Do not await `work` here. A wedged model call would block host:stream-end
    // and leave the packaged composer on Running forever.
    void work.catch(() => undefined);
  }
}

/**
 * Copy a tool's generated media into the local store and return the part pointing at it.
 * Returns null when the media cannot be mirrored (blocked host, over cap, bad response):
 * the turn keeps its text and drops the picture rather than carrying a remote URL.
 */
async function mirrorToolMediaPart(tenant: TenantContext, part: ContentPart): Promise<ContentPart | null> {
  try {
    if (part.type === "image_url") {
      const stored = await saveGeneratedImage(tenant, part.image_url.url);
      return { type: "image_url", image_url: { url: stored } };
    }
    if (part.type === "video_url") {
      const stored = await saveGeneratedVideo(tenant, part.video_url.url);
      return { type: "video_url", video_url: { url: stored } };
    }
    return part;
  } catch (error) {
    log.warn("tool_media_not_mirrored", { detail: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}
