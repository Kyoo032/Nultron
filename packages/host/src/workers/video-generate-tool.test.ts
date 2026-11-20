import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_POLL_DEADLINE_MS, getTool, videoGenerateTool, type TenantContext } from "@agentforge/core";
import { ensureToolsRegistered } from "../register-tools";
import { chatVideoGenerateTool } from "./video-generate-tool";
import { WORKER_HEARTBEAT_MS, WORKER_STREAM_IDLE_MS, withWorkerChannel } from "./worker-channel";

/**
 * Chat calls `video_generate` inside a run whose stall guard ends the turn after 60 s of silence. A
 * Seedance render takes longer than that (105 s measured for a 15 s clip at 480p), so the tool keeps
 * the run fed while it waits and sends the thread nothing.
 */

const TENANT: TenantContext = {
  tenantId: "video-keep-alive-tenant",
  organizationId: "video-keep-alive-org",
  workspaceId: "video-keep-alive-desk",
  userId: "video-keep-alive-user",
  role: "owner",
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the chat video_generate tool", () => {
  it("is core's tool under the same key, schema and words", () => {
    expect(chatVideoGenerateTool.key).toBe(videoGenerateTool.key);
    expect(chatVideoGenerateTool.schema).toBe(videoGenerateTool.schema);
    expect(chatVideoGenerateTool.description).toBe(videoGenerateTool.description);
    expect(chatVideoGenerateTool.capability).toBe(videoGenerateTool.capability);
    expect(chatVideoGenerateTool.trust).toBe(videoGenerateTool.trust);
  });

  it("is the one Chat resolves from the registry", () => {
    ensureToolsRegistered();
    expect(getTool("video_generate")).toBe(chatVideoGenerateTool);
  });

  it("keeps the chat run fed for the whole wait, and sends the thread nothing", async () => {
    let finish!: (value: unknown) => void;
    const spy = vi.spyOn(videoGenerateTool, "execute").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const alive = vi.fn();
    const emit = vi.fn();

    const run = withWorkerChannel({ emit, alive }, () =>
      chatVideoGenerateTool.execute({ prompt: "a long pour", seconds: 15 }, TENANT),
    );
    // Two minutes: longer than the 60 s idle budget, shorter than the tool's own deadline.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(alive.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(120_000 / WORKER_HEARTBEAT_MS) - 1);
    expect(emit).not.toHaveBeenCalled();

    finish({ success: true, video: "https://cdn.example/long.mp4" });
    await expect(run).resolves.toEqual({ success: true, video: "https://cdn.example/long.mp4" });
    expect(spy).toHaveBeenCalledWith({ prompt: "a long pour", seconds: 15 }, TENANT);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the tool plainly where there is no chat run (the Videos studio, the Edit jobs)", async () => {
    vi.spyOn(videoGenerateTool, "execute").mockResolvedValue({ success: false, error: "no key" });
    await expect(chatVideoGenerateTool.execute({ prompt: "x" }, TENANT)).resolves.toEqual({
      success: false,
      error: "no key",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("beats past the tool's own deadline, then stops before the model stream's budget runs out", async () => {
    let finish!: (value: unknown) => void;
    vi.spyOn(videoGenerateTool, "execute").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const alive = vi.fn();
    const run = withWorkerChannel({ emit: vi.fn(), alive }, () => chatVideoGenerateTool.execute({ prompt: "x" }, TENANT));

    await vi.advanceTimersByTimeAsync(VIDEO_POLL_DEADLINE_MS + 30_000);
    expect(alive.mock.calls.length).toBeGreaterThanOrEqual(VIDEO_POLL_DEADLINE_MS / WORKER_HEARTBEAT_MS);

    // A tool that never answers cannot hold the turn open: the beat is over before the stream budget is.
    await vi.advanceTimersByTimeAsync(WORKER_STREAM_IDLE_MS - VIDEO_POLL_DEADLINE_MS - 30_000);
    const beats = alive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * WORKER_HEARTBEAT_MS);
    expect(alive.mock.calls.length).toBe(beats);

    finish({ success: false });
    await run;
  });
});
