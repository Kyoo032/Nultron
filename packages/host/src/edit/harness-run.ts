import {
  editHarnessLine,
  encodeSse,
  extractMadeShot,
  extractPictureWords,
  framesInsideClip,
  getTool,
  harnessTargetClip,
  invokeToolGuarded,
  pictureWordsAreCaptions,
  planSceneFrames,
  planSilenceRanges,
  requireEditToolBackend,
  sceneProbeArgs,
  silenceProbeArgs,
  withOutputLanguage,
  wordsLanded,
  assetFramesToTimeline,
  type EditHarnessLineKey,
  type EditHarnessSkill,
  type EditProject,
  type SilenceRange,
  type TenantContext,
} from "@agentforge/core";
import { localeForRun } from "../run-context";
import { log } from "../log";
import { chargeTurnBudget, estimateEditJobUsd, type TurnBudget } from "./budget";
import { encodeEditSse } from "./events";
import { defaultEditGenerateModel } from "./model-route";
import { foldProject } from "./ops";
import { screenToolCompleted } from "./tool-screen";

const PROBE_ATTEMPTS = 2;

type Push = (frame: string) => void;

function say(push: Push, key: EditHarnessLineKey): void {
  push(encodeSse({ type: "assistant.delta", text: editHarnessLine(key, localeForRun()) }));
}

function pushTool(push: Push, output: unknown): void {
  if (!output || typeof output !== "object") {
    return;
  }
  const record = output as Record<string, unknown>;
  if ("ops" in record) {
    push(encodeEditSse({ type: "edit.ops", ops: record.ops }));
  }
  if ("card" in record) {
    push(encodeEditSse({ type: "edit.card", card: record.card }));
  }
  if ("job" in record) {
    push(encodeEditSse({ type: "edit.job", job: record.job }));
  }
}

/**
 * Every tool call goes through here, and a cancelled turn makes none: the person who cancelled is not
 * waiting, and a made shot or an export start is spend or a job nobody asked to keep. `runEditAgent`
 * reads the abort and closes the stream without reporting a failure.
 */
async function invoke(
  ctx: { push: Push; tenant: TenantContext; signal?: AbortSignal },
  toolKey: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  ctx.signal?.throwIfAborted();
  const { push, tenant } = ctx;
  const touching = typeof args.clipId === "string" ? [args.clipId] : [];
  push(encodeEditSse({ type: "tool.started", toolKey, touching }));
  const tool = getTool(toolKey);
  const output = tool ? await invokeToolGuarded(tool, args, tenant) : { error: "missing_tool" };
  const screened = screenToolCompleted(toolKey, output);
  push(encodeSse(screened));
  pushTool(push, screened.output);
  return output;
}

/** A start that failed is retried or reported; a start that was cancelled is neither. */
function rethrowCancel(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) {
    throw error;
  }
}

function jobAccepted(output: unknown): boolean {
  if (!output || typeof output !== "object") {
    return false;
  }
  const record = output as Record<string, unknown>;
  return (
    record.success === true && (record.job !== undefined || (Array.isArray(record.clips) && record.clips.length > 0))
  );
}

function spendRefusal(output: unknown): boolean {
  if (!output || typeof output !== "object") {
    return false;
  }
  const refused = (output as { refused?: string }).refused;
  return refused === "turn_cap_exceeded" || refused === "price_unknown";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

async function probeSilence(
  stub: boolean,
  clip: NonNullable<ReturnType<typeof harnessTargetClip<EditProject["clips"][number]>>>,
  attempt: number,
  tenant: TenantContext,
): Promise<SilenceRange[]> {
  if (stub || !clip.source?.assetId) {
    return stub ? planSilenceRanges(clip, attempt) : [];
  }
  try {
    const probed = await requireEditToolBackend().detectSilence(tenant, {
      assetId: clip.source.assetId,
      ...silenceProbeArgs(attempt),
    });
    return assetFramesToTimeline(clip, probed.ranges);
  } catch (error) {
    // The skill still says it found nothing; the log says why. The logger masks any secret in the message.
    log.warn("edit_silence_probe_failed", { attempt, detail: errorDetail(error) });
    return [];
  }
}

async function probeScenes(
  stub: boolean,
  clip: NonNullable<ReturnType<typeof harnessTargetClip<EditProject["clips"][number]>>>,
  attempt: number,
  tenant: TenantContext,
): Promise<number[]> {
  if (stub || !clip.source?.assetId) {
    return stub ? planSceneFrames(clip, attempt) : [];
  }
  try {
    const probed = await requireEditToolBackend().detectScenes(tenant, {
      assetId: clip.source.assetId,
      ...sceneProbeArgs(attempt),
    });
    return framesInsideClip(clip, probed.frames);
  } catch (error) {
    log.warn("edit_scene_probe_failed", { attempt, detail: errorDetail(error) });
    return [];
  }
}

async function liftDeadAir(input: RunInput): Promise<void> {
  const clip = harnessTargetClip(input.doc);
  if (!clip) {
    say(input.push, "liftDeadAirEmpty");
    return;
  }
  let ranges: SilenceRange[] = [];
  for (let attempt = 0; attempt < PROBE_ATTEMPTS && ranges.length === 0; attempt += 1) {
    ranges = await probeSilence(input.stub, clip, attempt, input.tenant);
  }
  if (ranges.length === 0) {
    say(input.push, "liftDeadAirEmpty");
    return;
  }
  await invoke(input, "remove_silence", { clipId: clip.id, ranges });
  say(input.push, "liftDeadAirRan");
}

async function cutOnShots(input: RunInput): Promise<void> {
  const clip = harnessTargetClip(input.doc);
  if (!clip) {
    say(input.push, "cutOnShotsEmpty");
    return;
  }
  let frames: number[] = [];
  for (let attempt = 0; attempt < PROBE_ATTEMPTS && frames.length === 0; attempt += 1) {
    frames = await probeScenes(input.stub, clip, attempt, input.tenant);
  }
  if (frames.length === 0) {
    say(input.push, "cutOnShotsEmpty");
    return;
  }
  await invoke(input, "split_at_scenes", { clipId: clip.id, frames });
  say(input.push, "cutOnShotsRan");
}

async function wordsOnPicture(input: RunInput): Promise<void> {
  const words = extractPictureWords(input.text);
  if (!words) {
    say(input.push, "wordsOnPictureEmpty");
    return;
  }
  const captions = pictureWordsAreCaptions(input.text);
  const toolKey = captions ? "add_caption" : "add_title";
  const args = captions ? { source: "script", text: words } : { text: words };
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    await invoke(input, toolKey, args);
    const folded = await foldProject(input.projectId, input.tenant.workspaceId);
    if (wordsLanded(folded.clips, words, captions ? "caption" : "title")) {
      say(input.push, "wordsOnPictureRan");
      return;
    }
  }
  say(input.push, "wordsOnPictureEmpty");
}

async function placeMadeShot(input: RunInput): Promise<void> {
  const shot = extractMadeShot(input.text);
  if (!shot) {
    say(input.push, "placeMadeShotEmpty");
    return;
  }
  const toolKey = shot.kind === "image" ? "generate_image" : "generate_video";
  const model = defaultEditGenerateModel(input.tenant, shot.kind);
  const seconds = shot.kind === "video" ? 4 : undefined;
  const estimate = estimateEditJobUsd(model, { seconds, count: 1 });
  const charged = chargeTurnBudget(input.budget, estimate);
  const prompt = withOutputLanguage(shot.prompt, "edit", localeForRun());
  const args: Record<string, unknown> = { prompt, model, tier: "standard" };
  if (seconds !== undefined) {
    args.seconds = seconds;
  }
  if (!charged.ok) {
    const output = await invoke(input, "propose_plan", {
      steps: [{ tool: toolKey, args, estimateUsd: estimate ?? undefined }],
      totalUsd: estimate ?? 0,
    });
    const plan = screenToolCompleted("propose_plan", output).output;
    if (plan && typeof plan === "object" && "card" in plan) {
      input.push(encodeEditSse({ type: "edit.plan", card: (plan as { card: unknown }).card }));
    }
    say(input.push, "placeMadeShotBlocked");
    return;
  }
  let output = await invoke(input, toolKey, args);
  if (!jobAccepted(output) && !spendRefusal(output)) {
    output = await invoke(input, toolKey, args);
  }
  if (spendRefusal(output)) {
    say(input.push, "placeMadeShotBlocked");
    return;
  }
  if (!jobAccepted(output)) {
    say(input.push, "placeMadeShotEmpty");
    return;
  }
  say(input.push, "placeMadeShotRan");
}

async function handBackFile(input: RunInput): Promise<void> {
  const open = await requireEditToolBackend().reviewGateOpen(input.projectId);
  if (!open) {
    say(input.push, "handBackFileBlocked");
    return;
  }
  const args = { preset: "h264-1080p" };
  let output: unknown;
  try {
    output = await invoke(input, "export", args);
  } catch (error) {
    rethrowCancel(input.signal, error);
    output = null;
  }
  if (!jobAccepted(output)) {
    try {
      output = await invoke(input, "export", args);
    } catch (error) {
      rethrowCancel(input.signal, error);
      output = null;
    }
  }
  if (!jobAccepted(output)) {
    say(input.push, "handBackFileFailed");
    return;
  }
  say(input.push, "handBackFileRan");
}

type RunInput = {
  tenant: TenantContext;
  projectId: string;
  text: string;
  skill: EditHarnessSkill;
  stub: boolean;
  budget: TurnBudget;
  doc: EditProject;
  push: Push;
  signal?: AbortSignal;
};

const RUNNERS: Record<EditHarnessSkill, (input: RunInput) => Promise<void>> = {
  "lift-dead-air": liftDeadAir,
  "cut-on-shots": cutOnShots,
  "words-on-picture": wordsOnPicture,
  "place-made-shot": placeMadeShot,
  "hand-back-file": handBackFile,
};

export async function runEditHarness(input: RunInput): Promise<void> {
  input.signal?.throwIfAborted();
  await RUNNERS[input.skill](input);
}
