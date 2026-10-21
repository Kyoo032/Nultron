import {
  ApiError,
  DEFAULT_CHAT_MODEL,
  createOutboundGuard,
  createRuntime,
  editAgentBindings,
  editStubAssistantCopy,
  encodeSse,
  getTool,
  harnessSpecFor,
  hasLiveProvider,
  invokeToolGuarded,
  isServerMode,
  matchEditHarnessSkill,
  matchStubEditScenario,
  matchStubFillScenario,
  matchStubGenerateScenario,
  modeMessage,
  resolveRuntimeMode,
  runOutboundGuarded,
  stringsOf,
  stubEditCardCopy,
  withOutputLanguage,
  type RuntimeEvent,
  type TenantContext,
} from "@agentforge/core";
import { rememberJobUsage } from "../job-usage";
import type { ModelCacheScope } from "../model-cache";
import { defaultSelectableModel, toolMediaModels } from "../selectable-models";
import { loadSettings } from "../settings-store";
import { localeForRun } from "../run-context";
import { ensureToolsRegistered } from "../register-tools";
import { withEditToolContext } from "./context";
import { foldProject } from "./ops";
import { getEditDoctor, type EditDoctorReport } from "./doctor";
import { encodeEditSse } from "./events";
import { createTurnBudget, chargeTurnBudget, estimateEditJobUsd } from "./budget";
import { hostEditBackend } from "./backend";
import { undoCard } from "./undo";
import { appendEditMetric } from "./metrics";
import { runEditHarness } from "./harness-run";
import { screenEvent, screenToolCompleted } from "./tool-screen";

const MUTATING = new Set([
  "split_clip",
  "trim_clip",
  "move_clip",
  "delete_clips",
  "remove_silence",
  "split_at_scenes",
  "add_title",
  "add_caption",
  "reframe",
  "set_clip_volume",
  "clear_timeline",
]);

const GENERATION = new Set([
  "generate_image",
  "generate_video",
  "regenerate_clip",
  "variations",
  "extend_clip",
  "generate_storyboard",
  "animate_storyboard",
  "transcribe",
]);

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

/**
 * What the model is told about ffmpeg this turn.
 *
 * On a desk the machine is the owner's, so a missing ffmpeg comes with the install hint and the model
 * may pass it on. On the hosted service the machine is the operator's: the platform, the install
 * command and the "run it in a terminal, then press Check again" advice describe a server the tenant
 * cannot touch, and anything in the prompt can be repeated to them in chat. `doctor.ts` already drops
 * `ffmpeg.setup` from the report on the hosted server for that reason, so the prompt follows the same
 * rule: one neutral sentence that matches the banner (`edit.ffmpeg.hostedUnavailable`), no platform, no
 * command, no variable name, no path.
 *
 * In the packaged app the ffmpeg is the installer's own (`ffmpeg.setup.bundled`, set by `doctor.ts`): the
 * person installed nothing and has nothing to run, so the model is told to pass on "reinstall the app" and no
 * command.
 *
 * `report` is a seam for tests; the agent passes none and reads the cached probe.
 */
export function ffmpegPromptLine(report: Pick<EditDoctorReport, "ffmpeg"> = getEditDoctor()): string {
  const { ffmpeg } = report;
  if (ffmpeg.found) {
    return `ffmpeg ${ffmpeg.version ?? ""} is installed. Export and ffmpeg are free. Never call ffmpeg yourself.`;
  }
  if (isServerMode()) {
    return [
      "The video tools (probe, cut, captions, export) are not set up on this server yet, so those jobs may not work.",
      "If the owner asks for them, or asks why video tools fail, say that an administrator has to turn them on; there is nothing for them to install.",
      "Do not queue ffmpeg jobs.",
    ].join(" ");
  }
  const setup = ffmpeg.setup;
  if (setup?.bundled) {
    return [
      `The video tools that come with this app are NOT available: ${setup.summary}`,
      'If the owner asks for probe, cut, captions or export, or asks why video tools fail, tell them to reinstall the app and then press "Check again" in the Edit banner. There is nothing else for them to install.',
      "Do not queue ffmpeg jobs until they work.",
    ].join(" ");
  }
  return [
    `ffmpeg is NOT available on this ${setup?.platform ?? "machine"}: ${setup?.summary ?? "not found"}`,
    `If the owner asks for probe, cut, captions or export, or asks why video tools fail, tell them to run \`${setup?.installCommand ?? "install ffmpeg"}\` in a terminal, then press "Check again" in the Edit banner. No restart needed.`,
    "Do not queue ffmpeg jobs until it is installed.",
  ].join(" ");
}

export function compactPrompt(doc: Awaited<ReturnType<typeof foldProject>>, budgetUsd: number): string {
  return [
    "You are the Nultron Edit agent. Share one ops log with the owner. Every mutation is a card.",
    `Project ${doc.name} ${doc.width}x${doc.height} @${doc.fps}fps seq=${doc.seq} review=${JSON.stringify(doc.review)}`,
    `Tracks: ${doc.tracks.map((track) => `${track.id}:${track.kind}`).join(", ")}`,
    `Clips: ${doc.clips.map((clip) => `${clip.id}@${clip.trackId}:${clip.timelineStartFrame}+${clip.durationFrames}`).join("; ") || "(none)"}`,
    `Ingredients: ${doc.ingredients.map((item) => item.name).join(", ") || "(none)"}`,
    `Turn cap USD: ${budgetUsd}. ${ffmpegPromptLine()}`,
    "A direct edit is a tool call in this turn. A title card calls add_title with the words the owner asked for; style and timing may be omitted.",
    "propose_plan is only for paid generation over the turn cap.",
    "clear_timeline requires an explicit user ask AND confirm:true.",
  ].join("\n");
}

/** The refreshed chat default. "edit" is not a gateway model id. */
export function editAgentModelId(preferred?: string, scope?: ModelCacheScope): string {
  const picked = (preferred ?? defaultSelectableModel(undefined, scope)).trim();
  if (picked && picked.toLowerCase() !== "edit") {
    return picked;
  }
  return DEFAULT_CHAT_MODEL;
}

export function editToolFrames(output: unknown): Array<{ type: string; [key: string]: unknown }> {
  if (!output || typeof output !== "object") {
    return [];
  }
  const record = output as Record<string, unknown>;
  const frames: Array<{ type: string; [key: string]: unknown }> = [];
  if ("ops" in record) {
    frames.push({ type: "edit.ops", ops: record.ops });
  }
  if ("card" in record) {
    frames.push({ type: "edit.card", card: record.card });
  }
  if ("job" in record) {
    frames.push({ type: "edit.job", job: record.job });
  }
  if (Array.isArray(record.jobs)) {
    for (const job of record.jobs) {
      frames.push({ type: "edit.job", job });
    }
  }
  return frames;
}

function pushToolFrames(queue: StringQueue, output: unknown): void {
  for (const frame of editToolFrames(output)) {
    queue.push(encodeEditSse(frame));
  }
}

function firstClipId(doc: Awaited<ReturnType<typeof foldProject>>): string | undefined {
  return (
    doc.clips.find((clip) => doc.tracks.find((track) => track.id === clip.trackId)?.kind === "video")?.id ??
    doc.clips[0]?.id
  );
}

function firstAssetId(doc: Awaited<ReturnType<typeof foldProject>>): string | undefined {
  return Object.keys(doc.assets)[0];
}

/** The words in a project the person wrote or recorded: every string with a space in it (titles, captions, transcript). */
function projectTextOf(doc: unknown): string[] {
  return stringsOf(doc).filter((text) => /\s/u.test(text.trim()));
}

export async function runEditAgent(input: {
  tenant: TenantContext;
  projectId: string;
  text: string;
  abortSignal?: AbortSignal;
}): Promise<AsyncIterable<string>> {
  const queue = new StringQueue();
  const runId = crypto.randomUUID();
  const settings = loadSettings(input.tenant);
  ensureToolsRegistered();
  const budget = createTurnBudget({ capUsd: settings.editTurnCapUsd });
  const stub =
    resolveRuntimeMode({
      settingsHasKey: hasLiveProvider(settings),
      envRuntime: process.env.AGENTFORGE_RUNTIME,
    }) === "stub";

  void (async () => {
    try {
      // Safe web search (H3, 2026-10-13): the Edit agent's turn runs under its own outbound guard. The person's
      // instruction is theirs; the project's titles, captions and transcript are private and taint the turn.
      const outbound = createOutboundGuard({ userText: [input.text], privateText: [], locale: localeForRun() });
      await withEditToolContext({ tenant: input.tenant, projectId: input.projectId, runId }, () => runOutboundGuarded(outbound, async () => {
        const doc = await foldProject(input.projectId, input.tenant.workspaceId);
        outbound.taint(projectTextOf(doc));
        queue.push(encodeSse({ type: "run.started", runId }));
        const scripted =
          matchStubEditScenario(input.text) ??
          matchStubFillScenario(input.text) ??
          matchStubGenerateScenario(input.text);
        const skill = scripted ? null : matchEditHarnessSkill(input.text);
        if (skill) {
          await runEditHarness({
            tenant: input.tenant,
            projectId: input.projectId,
            text: input.text,
            skill,
            stub,
            budget,
            doc,
            push: (frame) => queue.push(frame),
            ...(input.abortSignal ? { signal: input.abortSignal } : {}),
          });
          const completed: RuntimeEvent = { type: "run.completed", runId };
          rememberJobUsage(completed, { tenant: input.tenant, mode: "edit", runId });
          queue.push(encodeSse(completed));
          await appendEditMetric({ projectId: input.projectId, runId, event: "agent.turn" });
          return;
        }
        if (stub) {
          await runStub(input, doc, runId, budget, queue);
        } else {
          const runtime = createRuntime(settings, toolMediaModels(input.tenant));
          await runtime.execute({
            tenant: input.tenant,
            runId,
            modality: "text",
            version: {
              id: "edit",
              agentId: "edit",
              organizationId: input.tenant.organizationId,
              version: 1,
              systemPrompt: withOutputLanguage(compactPrompt(doc, budget.turnBudget), "edit", localeForRun()),
              model: editAgentModelId(undefined, input.tenant),
              inputModalities: ["text"],
              config: {},
              createdAt: new Date(),
            },
            bindings: editAgentBindings(input.tenant.organizationId),
            budget: harnessSpecFor("edit").budget,
            history: [{ role: "user", parts: [{ type: "text", text: input.text }] }],
            ...(input.abortSignal ? { signal: input.abortSignal } : {}),
            onEvent: async (event: RuntimeEvent) => {
              const safe = screenEvent(event);
              queue.push(encodeSse(safe));
              if (safe.type === "tool.completed") {
                pushToolFrames(queue, safe.output);
              }
              if (event.type === "run.completed") {
                // Edit-agent spend is metered against the tenant now, not appended to one global
                // untenanted file (Phase 5 lane A).
                rememberJobUsage(event, { tenant: input.tenant, mode: "edit", runId });
              }
            },
          });
        }
      }));
    } catch (error) {
      // A cancel is the person's own, and the stream they cancelled is gone: not an Edit failure to report.
      if (input.abortSignal?.aborted) {
        return;
      }
      const message = error instanceof ApiError ? error.message : modeMessage("editAgentFailed", localeForRun());
      queue.push(encodeSse(screenEvent({ type: "run.failed", message })));
    } finally {
      queue.close();
    }
  })();

  return queue;
}

async function runStub(
  input: { tenant: TenantContext; projectId: string; text: string },
  doc: Awaited<ReturnType<typeof foldProject>>,
  runId: string,
  budget: ReturnType<typeof createTurnBudget>,
  queue: StringQueue,
): Promise<void> {
  const scenario =
    matchStubEditScenario(input.text) ?? matchStubFillScenario(input.text) ?? matchStubGenerateScenario(input.text);
  if (!scenario) {
    queue.push(encodeSse({ type: "assistant.delta", text: editStubAssistantCopy(localeForRun()).help }));
    queue.push(encodeSse({ type: "run.completed", runId }));
    return;
  }
  if (scenario.toolKey === "__undo__") {
    queue.push(encodeSse({ type: "assistant.delta", text: editStubAssistantCopy(localeForRun()).undo }));
    queue.push(encodeSse({ type: "run.completed", runId }));
    return;
  }
  if (scenario.toolKey === "run_recipe") {
    const tool = getTool("run_recipe");
    const args = "buildArgs" in scenario ? scenario.buildArgs(input.text) : scenario.args;
    queue.push(encodeEditSse({ type: "tool.started", toolKey: "run_recipe", touching: [] }));
    const output = tool ? await invokeToolGuarded(tool, args, input.tenant) : { error: "missing_tool" };
    const screenedRecipe = screenToolCompleted("run_recipe", output);
    queue.push(encodeSse(screenedRecipe));
    if (screenedRecipe.output && typeof screenedRecipe.output === "object" && "card" in screenedRecipe.output) {
      queue.push(encodeEditSse({ type: "edit.plan", card: (screenedRecipe.output as { card: unknown }).card }));
    }
    queue.push(encodeSse({ type: "run.completed", runId }));
    return;
  }
  if (scenario.id === "S9") {
    const tool = getTool("clear_timeline");
    const touching: string[] = [];
    queue.push(encodeEditSse({ type: "tool.started", toolKey: "clear_timeline", touching }));
    const output = tool
      ? await invokeToolGuarded(tool, scenario.args, input.tenant)
      : { success: false, refused: "confirm_required" };
    queue.push(encodeSse(screenToolCompleted("clear_timeline", output)));
    queue.push(encodeSse({ type: "run.completed", runId }));
    return;
  }

  // An edit scenario carries `args`; a fill or generate scenario carries `buildArgs(text)` instead,
  // and the union has neither in common. Resolve it once here rather than at each use below — the
  // three sites further down that already inline `"buildArgs" in scenario ? … : scenario.args` are
  // left as they are, so each of those still builds its own object.
  const scenarioArgs: Record<string, unknown> =
    "buildArgs" in scenario ? scenario.buildArgs(input.text) : scenario.args;

  let mutatingCount = 0;
  if (MUTATING.has(scenario.toolKey)) {
    mutatingCount += 1;
  }
  if (mutatingCount > 3) {
    const plan = await hostEditBackend.proposePlan(input.tenant, {
      steps: [{ tool: scenario.toolKey, args: scenarioArgs }],
      totalUsd: 0,
    });
    queue.push(encodeEditSse({ type: "edit.plan", card: plan.card }));
    queue.push(encodeSse({ type: "run.completed", runId }));
    return;
  }
  if (GENERATION.has(scenario.toolKey)) {
    const seconds = typeof scenarioArgs.seconds === "number" ? scenarioArgs.seconds : 5;
    const count = typeof scenarioArgs.count === "number" ? scenarioArgs.count : 1;
    const model =
      typeof scenarioArgs.model === "string"
        ? scenarioArgs.model
        : scenario.toolKey === "generate_image"
          ? "gpt-image-2"
          : "grok-imagine-video";
    const estimate = scenario.toolKey === "transcribe" ? 0.02 : estimateEditJobUsd(model, { seconds, count });
    const charged = chargeTurnBudget(budget, estimate);
    if (!charged.ok) {
      queue.push(encodeSse(screenToolCompleted(scenario.toolKey, charged.refusal)));
      const plan = await hostEditBackend.proposePlan(input.tenant, {
        steps: [
          {
            tool: scenario.toolKey,
            args: "buildArgs" in scenario ? scenario.buildArgs(input.text) : scenario.args,
            estimateUsd: estimate ?? undefined,
          },
        ],
        totalUsd: estimate ?? 0,
      });
      queue.push(encodeEditSse({ type: "edit.plan", card: plan.card }));
      queue.push(encodeSse({ type: "run.completed", runId }));
      return;
    }
  }

  const args = "buildArgs" in scenario ? { ...scenario.buildArgs(input.text) } : { ...scenario.args };
  if (!args.clipId && firstClipId(doc)) {
    args.clipId = firstClipId(doc);
  }
  if (scenario.toolKey === "match_look" && firstClipId(doc)) {
    const clips = doc.clips.filter((clip) => clip.trackId === "v1");
    args.clipId = clips[0]?.id ?? firstClipId(doc);
    args.referenceClipId = clips[1]?.id ?? clips[0]?.id ?? args.referenceClipId;
  }
  if (scenario.toolKey === "propose_alt_cut") {
    args.clipIds = doc.clips
      .filter((clip) => clip.trackId === "v1")
      .map((clip) => clip.id)
      .slice(0, 4);
    if (!Array.isArray(args.clipIds) || args.clipIds.length === 0) {
      args.clipIds = ["stub-a"];
    }
  }
  if (scenario.toolKey === "animate_storyboard" && Array.isArray(args.clipIds)) {
    const stills = doc.clips
      .filter((clip) => {
        const assetId = clip.source?.assetId;
        return clip.trackId === "v1" && assetId && doc.assets[assetId]?.kind === "image";
      })
      .map((clip) => clip.id);
    if (stills.length > 0) {
      args.clipIds = stills;
    }
  }
  const ASSET_TOOLS = new Set(["transcribe", "detect_silence", "detect_scenes", "probe_asset"]);
  if (ASSET_TOOLS.has(scenario.toolKey) && !args.assetId && firstAssetId(doc)) {
    args.assetId = firstAssetId(doc);
  }
  if (scenario.toolKey === "add_title" && !args.style) {
    args.style = {
      fontFamily: "Inter",
      fontSizePx: 48,
      primaryColor: "#FFFFFFFF",
      outlineColor: "#000000FF",
      outlinePx: 2,
      shadowPx: 0,
      bold: false,
      italic: false,
      alignment: 8,
      marginL: 80,
      marginR: 80,
      marginV: 40,
    };
    args.startFrame = args.startFrame ?? 0;
    args.durationFrames = args.durationFrames ?? 90;
  }
  if (scenario.toolKey === "move_clip" && !args.trackId) {
    args.trackId = "v1";
  }
  const touching = typeof args.clipId === "string" ? [args.clipId] : [];
  queue.push(encodeEditSse({ type: "tool.started", toolKey: scenario.toolKey, touching }));
  const tool = getTool(scenario.toolKey);
  const output = tool ? await invokeToolGuarded(tool, args, input.tenant) : { error: "missing_tool" };
  const screened = screenToolCompleted(scenario.toolKey, output);
  queue.push(encodeSse(screened));
  pushToolFrames(queue, screened.output);
  const card = stubEditCardCopy(scenario, localeForRun());
  queue.push(encodeSse({ type: "assistant.delta", text: `${card.verb} · ${card.object}` }));
  const completed: RuntimeEvent = { type: "run.completed", runId };
  rememberJobUsage(completed, { tenant: input.tenant, mode: "edit", runId });
  queue.push(encodeSse(completed));
  await appendEditMetric({ projectId: input.projectId, runId, event: "agent.turn" });
}

export { undoCard };
