import type { ApplyableOp, EditOp, EditProject } from "@agentforge/core/edit";
import { applyOp, foldOps } from "@agentforge/core/edit";
import { apiFetch } from "@/lib/api-client";
import { applyOwnerOps, cardIdsClearedByTouch, clipIdsTouchedByOp, isHumanTouchOp } from "@/lib/edit-badges";

export type EditJob = {
  id: string;
  projectId?: string;
  kind?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | string;
  targetClipIds?: string[];
  cardId?: string;
  progress?: number;
  estimateUsd?: number | null;
  actualUsd?: number;
  error?: string;
};

export type OpCard = {
  id: string;
  projectId?: string;
  runId?: string;
  toolKey?: string;
  verb: string;
  object: string;
  opIds?: string[];
  jobId?: string;
  status: string;
  thumbs?: string[];
  estimateUsd?: number | null;
  tier?: string;
  args?: unknown;
  steps?: unknown;
  createdAt?: string;
};

export type UnplacedItem = {
  id: string;
  projectId?: string;
  jobId?: string;
  assetId: string;
  prompt?: string;
  createdAt?: string;
  placedClipId?: string;
  discardedAt?: string;
};

export type EditProjectRow = {
  id: string;
  name: string;
  updatedAt?: string;
};

export type FfmpegSetup = {
  platform: "macos" | "windows" | "linux";
  summary: string;
  installCommand: string;
  installUrl: string;
  steps: string[];
  envVar: string;
};

export type EditDoctor = {
  /**
   * `path` and `setup` are the owner's own machine's, so the hosted server omits both (`withoutBinaryPath`,
   * `packages/host/src/edit/doctor.ts`). Read them as optional: only `found` is always there.
   */
  ffmpeg?: { found?: boolean; path?: string | null; version?: string | null; reason?: string; setup?: FfmpegSetup };
  asr?: { available?: boolean };
};

export type LoadedProject = {
  project: EditProject;
  cards: OpCard[];
  jobs: EditJob[];
  unplaced: UnplacedItem[];
  seq: number;
};

export type OpInput = ApplyableOp;

export function isReviewOpen(project: EditProject | null): boolean {
  if (!project) {
    return true;
  }
  return project.review.ackSeq >= project.review.lastAgentSeq;
}

export function timelineEndFrame(project: EditProject): number {
  let end = project.fps * 10;
  for (const clip of project.clips) {
    end = Math.max(end, clip.timelineStartFrame + clip.durationFrames);
  }
  return Math.max(end, 1);
}

export function jobForClip(jobs: EditJob[], clipId: string, jobId?: string): EditJob | undefined {
  if (jobId) {
    const match = jobs.find((job) => job.id === jobId);
    if (match) {
      return match;
    }
  }
  return jobs.find((job) => job.targetClipIds?.includes(clipId));
}

export function activeJobs(jobs: EditJob[]): EditJob[] {
  return jobs.filter((job) => job.status === "queued" || job.status === "running");
}

export function turnSpendUsd(cards: OpCard[], jobs: EditJob[]): number {
  let sum = 0;
  for (const card of cards) {
    if (card.status === "undone") {
      continue;
    }
    if (typeof card.estimateUsd === "number") {
      sum += card.estimateUsd;
    }
  }
  for (const job of jobs) {
    if (job.status === "cancelled" || job.status === "interrupted") {
      continue;
    }
    if (typeof job.actualUsd === "number") {
      sum += job.actualUsd;
    }
  }
  return sum;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if (error && typeof error.code === "string" && error.code.trim()) {
      return error.code;
    }
  }
  return fallback;
}

export function parseLoadedProject(payload: Record<string, unknown>): LoadedProject | null {
  const project = payload.project as EditProject | undefined;
  if (!project || typeof project !== "object" || typeof project.id !== "string") {
    return null;
  }
  return {
    project,
    cards: Array.isArray(payload.cards) ? (payload.cards as OpCard[]) : [],
    jobs: Array.isArray(payload.jobs) ? (payload.jobs as EditJob[]) : [],
    unplaced: Array.isArray(payload.unplaced) ? (payload.unplaced as UnplacedItem[]) : [],
    seq: typeof payload.seq === "number" ? payload.seq : project.seq,
  };
}

export async function fetchEditDoctor(options: { recheck?: boolean } = {}): Promise<EditDoctor | null> {
  try {
    const response = await apiFetch(options.recheck ? "/api/v1/edit/doctor?recheck=1" : "/api/v1/edit/doctor");
    if (!response.ok) {
      return null;
    }
    return (await readJson(response)) as EditDoctor;
  } catch {
    return null;
  }
}

export async function fetchEditProjects(): Promise<{ items: EditProjectRow[]; status: number }> {
  const response = await apiFetch("/api/v1/edit/projects");
  const payload = await readJson(response);
  const items = Array.isArray(payload.items) ? (payload.items as EditProjectRow[]) : [];
  return { items, status: response.status };
}

export async function createEditProject(
  name: string,
  aspect: "16:9" | "9:16" | "1:1" = "16:9",
  starterId?: string,
): Promise<{
  project: EditProject | null;
  status: number;
  error?: string;
}> {
  const response = await apiFetch("/api/v1/edit/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, aspect, fps: 30, starterId }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return { project: null, status: response.status, error: errorMessage(payload, "Could not create project") };
  }
  const loaded = parseLoadedProject(payload);
  if (loaded) {
    return { project: loaded.project, status: response.status };
  }
  if (payload.id && typeof payload.id === "string") {
    return { project: payload as unknown as EditProject, status: response.status };
  }
  return { project: null, status: response.status, error: "Could not create project" };
}

export async function fetchEditProject(id: string): Promise<{ loaded: LoadedProject | null; status: number }> {
  const response = await apiFetch(`/api/v1/edit/projects/${id}`);
  const payload = await readJson(response);
  if (!response.ok) {
    return { loaded: null, status: response.status };
  }
  return { loaded: parseLoadedProject(payload), status: response.status };
}

export type FoldResult = {
  project: EditProject;
  /**
   * The ops could not be placed on this copy: a seq is missing between the copy and the frame, or an
   * op does not fit what the copy holds. `project` is then the copy it was given, unchanged, and the
   * caller reloads the project from the host (the host's fold is the one that counts).
   */
  diverged: boolean;
};

function foldUnvalidated(project: EditProject, ops: EditOp[]): EditProject {
  let next = project;
  for (const op of ops) {
    next = applyOp(next, { type: op.type, payload: op.payload });
    next = { ...next, seq: op.seq };
  }
  return next;
}

/**
 * Folds ops the host says it applied onto the renderer's copy. It never throws, because it runs on
 * frames the renderer did not ask for and a throw there takes the studio down with it.
 *
 * The host does not keep your own ops out of the project event stream, and the agent turn's stream
 * carries the same ops again, so the same op reaches the copy by more than one road. An op is
 * therefore applied once: anything at or below the copy's `seq` is already in it and is skipped, and
 * what is left has to follow the copy's `seq` without a gap. A gap or an op that does not fit is not
 * an error to show the owner; it means the copy fell behind, and the answer is `diverged`.
 */
export function foldApplied(project: EditProject, applied: EditOp[]): FoldResult {
  const fresh = applied
    .filter((op) => typeof op.projectId !== "string" || op.projectId === project.id)
    .filter((op) => typeof op.seq !== "number" || op.seq > project.seq)
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) {
    return { project, diverged: false };
  }
  let expected = project.seq + 1;
  for (const op of fresh) {
    if (op.seq !== expected) {
      return { project, diverged: true };
    }
    expected += 1;
  }
  try {
    return { project: foldOps(project, fresh), diverged: false };
  } catch {
    // `foldOps` also validates the whole document and wants a card on every agent op; the plain
    // fold below is what the owner's copy has always fallen back to when only that part objects.
  }
  try {
    return { project: foldUnvalidated(project, fresh), diverged: false };
  } catch {
    return { project, diverged: true };
  }
}

export type AppendOpsState = {
  project: EditProject;
  parent: string | null;
  clock: number;
  opsPosted: number;
};

export async function postEditOps(
  state: AppendOpsState,
  ops: OpInput[],
): Promise<{
  project: EditProject;
  parent: string | null;
  clock: number;
  opsPosted: number;
  keepCardIds: string[];
  error?: string;
  /** The host applied the ops, but they do not fit this copy: reload the project (see `FoldResult`). */
  diverged?: boolean;
  status: number;
}> {
  const keepCardIds = ops.flatMap((op) =>
    isHumanTouchOp(op) ? cardIdsClearedByTouch(state.project, clipIdsTouchedByOp(op)) : [],
  );
  const optimistic = applyOwnerOps(state.project, ops);
  const nextClock = state.clock + 1;
  const response = await apiFetch(`/api/v1/edit/projects/${state.project.id}/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops, parent: state.parent, clock: nextClock }),
  });
  const payload = await readJson(response);
  if (response.status === 404) {
    return {
      project: optimistic,
      parent: state.parent,
      clock: nextClock,
      opsPosted: state.opsPosted + ops.length,
      keepCardIds,
      status: 404,
    };
  }
  if (!response.ok) {
    return {
      project: state.project,
      parent: state.parent,
      clock: state.clock,
      opsPosted: state.opsPosted,
      keepCardIds: [],
      error: errorMessage(payload, "Could not apply edit"),
      status: response.status,
    };
  }
  const applied = Array.isArray(payload.applied) ? (payload.applied as EditOp[]) : [];
  const folded: FoldResult =
    applied.length > 0 ? foldApplied(state.project, applied) : { project: optimistic, diverged: false };
  const last = applied[applied.length - 1];
  return {
    project: folded.project,
    parent: last?.id ?? state.parent,
    clock: typeof last?.clock === "number" ? last.clock : nextClock,
    opsPosted: state.opsPosted + ops.length,
    keepCardIds,
    diverged: folded.diverged,
    status: response.status,
  };
}

export function parseSseBlockType(event: { type?: string }): string {
  return typeof event.type === "string" ? event.type : "";
}
