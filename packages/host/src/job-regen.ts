import {
  ApiError,
  assertModelSupportsModality,
  createOutboundGuard,
  createRuntime,
  currentOutboundGuard,
  harnessSpecFor,
  runOutboundGuarded,
  type AgentVersionRecord,
  type AppLocale,
  type ContentPart,
  type ImageUrlPart,
  type JobMode,
  type JobModelFallbackNotice,
  type ModeHarnessSpec,
  type ProductMode,
  type RuntimeEvent,
  type StreamWatchdogLimits,
  type TenantContext,
  type ToolBindingRecord,
  usageModeFromRunPrefix,
} from "@agentforge/core";
import { isRenderableImageUrl } from "./composer-attach";
import { inlineLocalMediaParts } from "./inline-local-media";
import { throwIfJobAborted } from "./job-stream";
import { rememberJobUsage } from "./job-usage";
import { runWithJobModelFallback, type JobModelOutcome } from "./job-model-fallback";
import { log } from "./log";
import { loadSettings } from "./settings-store";
import { localeForRun } from "./run-context";
import { withToolRun } from "./tool-run-context";

export function readOptionalInstruction(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const instruction = (body as { instruction?: unknown }).instruction;
  return typeof instruction === "string" ? instruction.trim() : "";
}

/**
 * Did the person pick this job's model, or is it the seeded default every studio sends?
 *
 * The studios send `model` on every request, so the id alone cannot tell a pick from a default, and a
 * job that read every request as a pick could never be rescued onto a second model when the gateway
 * cannot reach the first. The studio sends `modelPinned: true` only when its picker was changed
 * (`apps/web/lib/model-choice.ts`); callers hand this answer to the job run as `modelExplicit`.
 *
 * A pin with no model names nothing to hold the host to, so it is not a pin: the host default the
 * request would fall back on was nobody's choice.
 */
export function readModelPinned(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const record = body as { model?: unknown; modelPinned?: unknown };
  return record.modelPinned === true && typeof record.model === "string" && record.model.trim() !== "";
}

export function appendRegenInstruction(prompt: string, instruction: string): string {
  return instruction ? `${prompt}\n\nUser instruction:\n${instruction}` : prompt;
}

export function readJobRegenAttachments(body: unknown): ImageUrlPart[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const raw = (body as { attachments?: unknown }).attachments;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ApiError("invalid_request", "attachments must be an array", 400);
  }
  const parts: ImageUrlPart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new ApiError("invalid_request", "Each attachment must be an image_url part", 400);
    }
    const record = item as { type?: unknown; image_url?: { url?: unknown; detail?: unknown } };
    const url = record.image_url && typeof record.image_url.url === "string" ? record.image_url.url.trim() : "";
    if (record.type !== "image_url" || !url || !isRenderableImageUrl(url)) {
      throw new ApiError("invalid_request", "Each attachment must be an image_url part", 400);
    }
    const detail = record.image_url?.detail;
    parts.push({
      type: "image_url",
      image_url: {
        url,
        detail: detail === "low" || detail === "high" || detail === "auto" ? detail : "high",
      },
    });
  }
  return parts;
}

/**
 * Which product mode's harness a job run answers to. Every `JobMode` is also a product mode id, so
 * this is the identity, written out so a new job mode is a compile error until someone maps it. The
 * sub-tasks (`document-section`, `finance-repair`, `finance-ratios-buckets`, `market-team`,
 * `market-section`, `presentation-slide`, `meeting-translate`, `enhance`) carry their parent's
 * `jobMode` at their call sites, and so run under the parent's spec. The knowledge brain and verifier
 * call as `research`, the mode whose spec has no tools.
 */
const PRODUCT_MODE_OF_JOB_MODE: Readonly<Record<JobMode, ProductMode>> = {
  documents: "documents",
  research: "research",
  presentations: "presentations",
  finance: "finance",
  data: "data",
  market: "market",
  legal: "legal",
  meeting: "meeting",
};

/**
 * The tools a job asked for, cut to what its mode's spec declares. A tool outside the spec is dropped
 * and named in the log: the mode that forgot to declare it sees the tool missing, rather than the run
 * quietly holding more than its harness says.
 */
function toolKeysWithinSpec(spec: ModeHarnessSpec, requested: readonly string[]): string[] {
  const declared = new Set(spec.tools);
  const kept: string[] = [];
  for (const toolKey of requested) {
    if (declared.has(toolKey)) {
      kept.push(toolKey);
    } else {
      // `tool`, not `toolKey`: the logger drops any field whose name contains "key".
      log.warn("job_tool_outside_spec", { mode: spec.mode, tool: toolKey });
    }
  }
  return kept;
}

async function runJobAssistantOnce(options: {
  tenant: TenantContext;
  model: string;
  systemPrompt: string;
  runPrefix: string;
  agentId: string;
  versionId: string;
  prompt: string;
  attachments?: ImageUrlPart[];
  /** Tool keys the model may call (registered tools only). Empty by default. */
  toolKeys?: string[];
  /** Observe runtime events (tool calls, deltas) while the job runs. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Raise the stream watchdog above the model defaults for this run (never lowers them). */
  streamWatchdog?: Partial<StreamWatchdogLimits>;
  /** The studio this run belongs to. Sends the thinking-off knob on always-thinking models. */
  jobMode?: JobMode;
  /** App locale for runtime copy (timeouts, contact errors). Defaults to the run context. */
  locale?: AppLocale;
  /** The job's cancel. The runtime aborts the request in flight when it fires; omitted, the call runs to the end. */
  signal?: AbortSignal;
  /**
   * What the outbound guard compares this run's search queries and page addresses against (SR-112, review
   * 2026-10-13). `userText` is what the person typed; `privateText` is the job's private inputs. Omitted, the
   * whole prompt counts as private and nothing as typed, which is the safe reading for a caller that has not
   * said. A guard the caller already opened is used as it is.
   */
  outbound?: { userText: readonly string[]; privateText: readonly string[] };
}): Promise<string> {
  const settings = loadSettings(options.tenant);
  const runtime = createRuntime(settings);
  const attachments = options.attachments ?? [];
  if (attachments.length > 0) {
    assertModelSupportsModality(options.model, "image");
  }
  const imageParts = attachments.length > 0 ? await inlineLocalMediaParts(options.tenant, attachments) : [];
  const version: AgentVersionRecord = {
    id: options.versionId,
    agentId: options.agentId,
    organizationId: options.tenant.organizationId,
    version: 1,
    systemPrompt: options.systemPrompt,
    model: options.model,
    inputModalities: attachments.length > 0 ? ["text", "image"] : ["text"],
    config: {},
    createdAt: new Date(),
  };

  // Every job run is metered against its tenant, under the mode its `runPrefix` names. Derived
  // rather than passed: the twenty job call sites already carry a prefix, and five of them have no
  // `JobMode` to give. See `usageModeFromRunPrefix` in @agentforge/core.
  const usageMode = usageModeFromRunPrefix(options.jobMode ?? options.runPrefix);
  const runId = `${options.runPrefix}-${Date.now()}`;

  let assistantText = "";
  let failedMessage = "";
  // The runtime ends a tool run quietly in two cases a job must not swallow: the call after a tool failed
  // (`run.interrupted`) and the step cap cut the loop (`run.step_limit`). Chat words both; a job fails.
  let interruptedReason = "";
  let stepLimitReached = false;
  const parts: ContentPart[] = [{ type: "text", text: options.prompt }, ...imageParts];
  // The mode's declared harness: its tool set bounds the bindings and its budget bounds the run. A call
  // that names no `jobMode` is not a studio run and keeps what it asked for.
  const spec = options.jobMode ? harnessSpecFor(PRODUCT_MODE_OF_JOB_MODE[options.jobMode]) : undefined;
  const requestedToolKeys = options.toolKeys ?? [];
  const toolKeys = spec ? toolKeysWithinSpec(spec, requestedToolKeys) : requestedToolKeys;
  const bindings: ToolBindingRecord[] = toolKeys.map((toolKey) => ({
    id: `${options.versionId}-${toolKey}`,
    agentVersionId: options.versionId,
    organizationId: options.tenant.organizationId,
    toolKey,
    config: {},
    enabled: true,
  }));

  const locale = options.locale ?? localeForRun();
  // Every job run with tools checks what it sends out. A web tool reached with no guard open refuses, so
  // the job opens one here unless its caller (a research run, say) already did.
  const openGuard = currentOutboundGuard()
    ? <T>(fn: () => T): T => fn()
    : <T>(fn: () => T): T =>
        runOutboundGuarded(
          createOutboundGuard({
            userText: options.outbound?.userText ?? [],
            privateText: options.outbound?.privateText ?? [options.prompt],
            tainted: attachments.length > 0,
            locale,
          }),
          fn,
        );

  // File writes by a tool record who made them; a job has no thread, so the run is named here.
  await openGuard(() =>
    withToolRun({ runId, mode: spec?.mode ?? usageMode }, () =>
      runtime.execute({
        tenant: options.tenant,
        runId,
        modality: "text",
        version,
        bindings,
        history: [{ role: "user", parts }],
        // Without this every job-side timeout and contact error is English on an Indonesian desk.
        locale,
        ...(spec ? { budget: spec.budget } : {}),
        ...(options.streamWatchdog ? { streamWatchdog: options.streamWatchdog } : {}),
        ...(options.jobMode ? { jobMode: options.jobMode } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onEvent: (event) => {
          if (event.type === "assistant.delta") {
            assistantText += event.text;
          }
          if (event.type === "run.failed") {
            failedMessage = event.message;
          }
          if (event.type === "run.interrupted") {
            interruptedReason = event.message.trim().slice(0, 300) || "interrupted";
          }
          if (event.type === "run.step_limit") {
            stepLimitReached = true;
          }
          options.onEvent?.(event);
          rememberJobUsage(event, { tenant: options.tenant, mode: usageMode, runId });
        },
      }),
    ),
  );

  if (failedMessage) {
    throw new ApiError("generation_failed", failedMessage, 502);
  }
  const indonesian = (options.locale ?? localeForRun()) === "id";
  if (interruptedReason) {
    // The gateway's own words stay in the log (redacted by the logger), not in the error: a "503" in this
    // sentence would read as an unreachable gateway to `maySwapModel` and replay a job whose tools ran.
    log.warn("job_run_interrupted", { runId, reason: interruptedReason });
    throw new ApiError(
      "generation_failed",
      indonesian
        ? "Model berhenti setelah memakai alat dan tidak menyelesaikan jawaban. Coba lagi atau pilih model lain."
        : "The model stopped after using a tool and did not finish its answer. Try again or pick another model.",
      502,
    );
  }
  if (stepLimitReached && assistantText.trim().length === 0) {
    throw new ApiError(
      "generation_failed",
      indonesian
        ? "Model memakai semua langkah alatnya tanpa menulis jawaban. Coba lagi dengan permintaan yang lebih sempit."
        : "The model used all of its tool steps without writing an answer. Try again with a narrower request.",
      502,
    );
  }
  return assistantText;
}

/** What a job run actually used: the text, the model that produced it, and any fallback notice. */
export type JobAssistantRun = {
  text: string;
  /** The model that answered — the stand-in when the requested one could not be reached. */
  model: string;
  /** Set only when a stand-in answered. `code` is `model_fallback`; the desk writes the sentence. */
  notice?: JobModelFallbackNotice;
};

export type JobAssistantOptions = Parameters<typeof runJobAssistantOnce>[0] & {
  /** The person picked this model in the UI for this request: return the error, never swap it. */
  modelExplicit?: boolean;
  /** Chat ids this workspace lists. Defaults to the live selectable catalog. */
  availableModelIds?: string[];
};

/**
 * One job call, with one retry on another model when the gateway could not be reached at all — so
 * a desk whose mode default is down still gets its brief instead of a 500. Callers that want to
 * show which model answered use this; the rest keep `collectJobAssistantText` and are rescued
 * without changing.
 */
export async function collectJobAssistantRun(options: JobAssistantOptions): Promise<JobAssistantRun> {
  const run = await runWithJobModelFallback(options, async (model): Promise<JobModelOutcome<string>> => {
    // A cancelled job starts no call: not the first, and not a stand-in after the first one failed.
    throwIfJobAborted(options.signal);
    let streamed = false;
    try {
      const text = await runJobAssistantOnce({
        ...options,
        model,
        onEvent: (event) => {
          // A tool that started has acted (a desk-file write, `run_code`); replaying the job on another
          // model would act twice, so it counts as the model having answered.
          if (
            (event.type === "assistant.delta" && event.text.length > 0) ||
            event.type === "tool.started" ||
            event.type === "tool.completed"
          ) {
            streamed = true;
          }
          options.onEvent?.(event);
        },
      });
      return { ok: true, value: text };
    } catch (error) {
      // A cancel is the caller's answer, not the model's failure: thrown past the fallback, so no
      // stand-in retries it and the circuit never marks the model down for it. It is the job's own
      // 499 `aborted`, not the signal's raw reason, so a caller that swallows a failed call (a
      // repair pass, a naming pass) can tell a cancel from a model that could not answer.
      throwIfJobAborted(options.signal);
      return { ok: false, error, streamed };
    }
  });
  return { text: run.value, model: run.model, ...(run.notice ? { notice: run.notice } : {}) };
}

/**
 * The text only. This drops which model answered, so it is for callers that neither record nor show
 * a model. A job that saves `model` into an artifact, a work card or a notice must use
 * `collectJobAssistantRun` and record `run.model`: after a fallback the requested id is the one model
 * that did not write the answer.
 */
export async function collectJobAssistantText(options: JobAssistantOptions): Promise<string> {
  return (await collectJobAssistantRun(options)).text;
}
