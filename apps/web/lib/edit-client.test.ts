import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyProject, type EditOp, type EditProject } from "@agentforge/core/edit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { foldApplied, postEditOps } from "./edit-client";

const PROJECT_ID = "p1";
const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function project(): EditProject {
  return emptyProject({ id: PROJECT_ID, workspaceId: "w1", name: "Echo", aspect: "16:9" });
}

function op(seq: number, type: EditOp["type"], payload: unknown, extra: Partial<EditOp> = {}): EditOp {
  return {
    id: `op-${seq}`,
    projectId: PROJECT_ID,
    seq,
    parent: seq > 1 ? `op-${seq - 1}` : null,
    clock: seq,
    actor: "owner",
    type,
    payload,
    inverse: null,
    createdAt: `2026-10-02T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...extra,
  };
}

const addAsset = (seq: number, id = "a-1") =>
  op(seq, "add_asset", { asset: { id, kind: "video", storagePath: `${id}.mp4`, durationFrames: 300 } });
const addClip = (seq: number, id = "c-1", assetId = "a-1") =>
  op(seq, "add_clip", {
    clip: {
      id,
      trackId: "v1",
      timelineStartFrame: 0,
      durationFrames: 120,
      status: "ready",
      source: { assetId, inFrame: 0 },
    },
  });

describe("foldApplied: the host echoes your own ops back", () => {
  it("applies new ops and moves the copy to their seq", () => {
    const folded = foldApplied(project(), [addAsset(1), addClip(2)]);
    expect(folded.diverged).toBe(false);
    expect(folded.project.clips.map((clip) => clip.id)).toEqual(["c-1"]);
    expect(folded.project.seq).toBe(2);
  });

  it("takes the same ops a second time as a no-op instead of throwing 'clip id already exists'", () => {
    const ops = [addAsset(1), addClip(2)];
    const once = foldApplied(project(), ops);
    const twice = foldApplied(once.project, ops);
    expect(twice.diverged).toBe(false);
    expect(twice.project).toBe(once.project);
    expect(twice.project.clips).toHaveLength(1);
  });

  it("applies only the part of a frame the copy has not seen", () => {
    const first = foldApplied(project(), [addAsset(1)]);
    const next = foldApplied(first.project, [addAsset(1), addClip(2)]);
    expect(next.diverged).toBe(false);
    expect(next.project.clips.map((clip) => clip.id)).toEqual(["c-1"]);
    expect(next.project.seq).toBe(2);
  });

  it("ignores ops that belong to another project", () => {
    const base = project();
    const folded = foldApplied(base, [addAsset(1), op(2, "delete_clip", { clipId: "x" }, { projectId: "other" })]);
    expect(folded.diverged).toBe(false);
    expect(folded.project.seq).toBe(1);
  });

  it("says diverged, and hands the copy back untouched, when a frame skips a seq", () => {
    const base = project();
    const folded = foldApplied(base, [addAsset(2)]);
    expect(folded.diverged).toBe(true);
    expect(folded.project).toBe(base);
  });

  it("says diverged instead of throwing when a new op does not fit the copy", () => {
    const base = foldApplied(project(), [addAsset(1), addClip(2)]).project;
    // seq 3 is new, but the clip id is already on the timeline: the copy is out of step with the host.
    const folded = foldApplied(base, [addClip(3)]);
    expect(folded.diverged).toBe(true);
    expect(folded.project).toBe(base);
  });

  it("does nothing for an empty frame", () => {
    const base = project();
    expect(foldApplied(base, [])).toEqual({ project: base, diverged: false });
  });
});

describe("postEditOps: the response can arrive after the stream already folded the ops", () => {
  const mocked = vi.mocked(apiFetch);

  beforeEach(() => {
    mocked.mockReset();
  });

  function respond(applied: EditOp[]) {
    mocked.mockResolvedValue(new Response(JSON.stringify({ applied }), { status: 200 }));
  }

  const split = { type: "split_clip" as const, payload: { clipId: "c-1", atFrame: 60, newClipId: "c-2" } };

  it("does not throw when the response repeats ops the copy already holds", async () => {
    const seeded = foldApplied(project(), [addAsset(1), addClip(2)]).project;
    const splitOp = op(3, "split_clip", split.payload);
    const streamed = foldApplied(seeded, [splitOp]).project;
    respond([splitOp]);
    // The posted op is only here to give `postEditOps` something harmless to run optimistically; the
    // response is what matters: it repeats seq 3, which the copy already holds.
    const result = await postEditOps({ project: streamed, parent: "op-3", clock: 3, opsPosted: 0 }, [
      { type: "set_volume", payload: { clipId: "c-1", volume: 1 } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.diverged).toBe(false);
    expect(result.project.clips.map((clip) => clip.id).sort()).toEqual(["c-1", "c-2"]);
  });

  it("answers a refused op with the host's message and the copy it already had", async () => {
    const seeded = foldApplied(project(), [addAsset(1), addClip(2)]).project;
    mocked.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_op", message: "clip id already exists: c-1" } }), {
        status: 400,
      }),
    );
    const result = await postEditOps({ project: seeded, parent: "op-2", clock: 2, opsPosted: 0 }, [
      { type: "set_volume", payload: { clipId: "c-1", volume: 1 } },
    ]);
    expect(result.error).toBe("clip id already exists: c-1");
    expect(result.project).toBe(seeded);
    expect(result.diverged).toBeUndefined();
  });

  it("flags divergence, keeps the copy and shows no error when the applied ops do not fit it", async () => {
    const seeded = foldApplied(project(), [addAsset(1), addClip(2)]).project;
    respond([op(5, "delete_clip", { clipId: "c-1" })]);
    const result = await postEditOps({ project: seeded, parent: "op-2", clock: 2, opsPosted: 0 }, [
      { type: "set_volume", payload: { clipId: "c-1", volume: 1 } },
    ]);
    expect(result.diverged).toBe(true);
    expect(result.project).toBe(seeded);
    expect(result.error).toBeUndefined();
  });
});

describe("EditStudio applies host frames only through the guarded fold", () => {
  const studio = readFileSync(join(web, "components/edit-studio.tsx"), "utf8");

  it("never applies an op inside a state updater, where a throw unmounts the studio", () => {
    expect(studio).not.toMatch(/setProject\(\s*\(\s*current\s*\)\s*=>[^;]*applyOp\(/);
    expect(studio).not.toMatch(/setProject\(\s*\(\s*current\s*\)\s*=>[^;]*foldApplied\(/);
  });

  it("does not import applyOp at all", () => {
    expect(studio).not.toMatch(/\bapplyOp\b/);
  });

  it("resyncs from the host when a frame does not fit", () => {
    expect(studio).toMatch(/diverged/);
    expect(studio).toMatch(/resyncProject/);
  });
});
