import { describe, expect, it, vi } from "vitest";
import type { MediaProposalStatus } from "@/components/tool-rows/media-result";
import type { MediaApi, MediaFailure } from "./media-approval-client";
import {
  CHECKING,
  checkProposal,
  generateProposal,
  skipProposal,
  startAction,
  unavailable,
} from "./media-approval-flow";

const IMAGE_RESULT = { success: true, backend: "gateway", image: "/api/v1/media/m1/file" };

function proposal(status: MediaProposalStatus) {
  return {
    id: "p1",
    kind: "image" as const,
    prompt: "a boat",
    status,
    estimate: { amountMicros: 40000, currency: "USD" as const },
  };
}

function refused(code: string, status = 409, message: string | null = null): MediaFailure {
  return { ok: false, code, status, message };
}

function fakeApi(over: Partial<Record<keyof MediaApi, ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    fetchProposal: vi.fn(async () => ({ ok: true, value: proposal("pending") })),
    generate: vi.fn(async () => ({ ok: true, value: { proposal: proposal("generated"), result: IMAGE_RESULT } })),
    skip: vi.fn(async () => ({ ok: true, value: proposal("skipped") })),
    setAlwaysAllow: vi.fn(async () => ({ ok: true, value: { image: true, video: false } })),
    fetchAlwaysAllow: vi.fn(async () => ({ ok: true, value: { image: false, video: false } })),
    ...over,
  };
  return { api: api as unknown as MediaApi, calls: api };
}

describe("the card's first read", () => {
  it("starts in checking, with nothing decided", () => {
    expect(CHECKING).toEqual({ phase: "checking", action: null, status: null, result: null, failure: null });
  });

  it("a pending proposal asks", async () => {
    const { api } = fakeApi();
    expect(await checkProposal(api, "p1")).toEqual({
      phase: "asking",
      action: null,
      status: null,
      result: null,
      failure: null,
    });
  });

  it("every decided status is shown as that status", async () => {
    for (const status of ["generated", "skipped", "expired", "failed"] as const) {
      const { api } = fakeApi({ fetchProposal: vi.fn(async () => ({ ok: true, value: proposal(status) })) });
      expect(await checkProposal(api, "p1")).toMatchObject({ phase: "ended", status, failure: null });
    }
  });

  it("another person's or a purged proposal is read-only", async () => {
    const { api } = fakeApi({ fetchProposal: vi.fn(async () => refused("not_found", 404)) });
    expect(await checkProposal(api, "p1")).toMatchObject({ phase: "readonly" });
  });

  it("a failed read asks, with the failure, so the person can still try", async () => {
    const { api } = fakeApi({ fetchProposal: vi.fn(async () => refused("network", 0)) });
    expect(await checkProposal(api, "p1")).toMatchObject({ phase: "asking", failure: { code: "network" } });
  });
});

describe("Generate", () => {
  it("shows the tool's own media result when the picture is made", async () => {
    const { api, calls } = fakeApi();
    const next = await generateProposal(api, "p1", "image", false);
    expect(calls.generate).toHaveBeenCalledWith("p1");
    expect(calls.setAlwaysAllow).not.toHaveBeenCalled();
    expect(next).toEqual({ phase: "result", action: null, status: "generated", result: IMAGE_RESULT, failure: null });
  });

  it("ends as generated when there is no media to show", async () => {
    const { api } = fakeApi({
      generate: vi.fn(async () => ({ ok: true, value: { proposal: proposal("generated"), result: null } })),
    });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "ended", status: "generated" });
  });

  it("ends as failed when the run failed", async () => {
    const { api } = fakeApi({
      generate: vi.fn(async () => ({ ok: true, value: { proposal: proposal("failed"), result: { success: false } } })),
    });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "ended", status: "failed" });
  });

  it("keeps asking when the host says the proposal is still pending", async () => {
    const { api } = fakeApi({
      generate: vi.fn(async () => ({ ok: true, value: { proposal: proposal("pending"), result: null } })),
    });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "asking", failure: null });
  });

  it("answers the models-off refusal with the failure, and asks again", async () => {
    const failure = refused("gateway_blocked", 403, "No key.");
    const { api } = fakeApi({ generate: vi.fn(async () => failure) });
    expect(await generateProposal(api, "p1", "image", false)).toEqual({
      phase: "asking",
      action: null,
      status: null,
      result: null,
      failure,
    });
  });

  it("is read-only when the proposal is not this person's", async () => {
    const { api } = fakeApi({ generate: vi.fn(async () => refused("not_found", 404)) });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "readonly" });
  });

  it("shows the status when the proposal was already decided (not_pending)", async () => {
    const { api, calls } = fakeApi({
      generate: vi.fn(async () => refused("not_pending")),
      fetchProposal: vi.fn(async () => ({ ok: true, value: proposal("generated") })),
    });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "ended", status: "generated" });
    expect(calls.fetchProposal).toHaveBeenCalledTimes(1);
  });

  it("shows expired when the proposal has expired", async () => {
    const { api } = fakeApi({
      generate: vi.fn(async () => refused("expired")),
      fetchProposal: vi.fn(async () => ({ ok: true, value: proposal("expired") })),
    });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "ended", status: "expired" });
  });

  it("passes a quota refusal through with the host's own message", async () => {
    const failure = refused("storage_quota_exceeded", 403, "No storage left.");
    const { api } = fakeApi({ generate: vi.fn(async () => failure) });
    expect(await generateProposal(api, "p1", "image", false)).toMatchObject({ phase: "asking", failure });
  });
});

describe("Always allow", () => {
  it("turns the kind on, then generates", async () => {
    const { api, calls } = fakeApi();
    const next = await generateProposal(api, "p1", "video", true);
    expect(calls.setAlwaysAllow).toHaveBeenCalledWith("video", true);
    expect(calls.generate).toHaveBeenCalledWith("p1");
    expect(calls.setAlwaysAllow.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      calls.generate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(next).toMatchObject({ phase: "result" });
  });

  it("does not generate when the setting cannot be saved", async () => {
    const failure = refused("unknown", 500);
    const { api, calls } = fakeApi({ setAlwaysAllow: vi.fn(async () => failure) });
    expect(await generateProposal(api, "p1", "image", true)).toMatchObject({ phase: "asking", failure });
    expect(calls.generate).not.toHaveBeenCalled();
  });
});

describe("Skip", () => {
  it("ends as skipped", async () => {
    const { api, calls } = fakeApi();
    expect(await skipProposal(api, "p1")).toEqual({
      phase: "ended",
      action: null,
      status: "skipped",
      result: null,
      failure: null,
    });
    expect(calls.skip).toHaveBeenCalledWith("p1");
  });

  it("shows the status when the proposal was already decided", async () => {
    const { api } = fakeApi({
      skip: vi.fn(async () => refused("not_pending")),
      fetchProposal: vi.fn(async () => ({ ok: true, value: proposal("generated") })),
    });
    expect(await skipProposal(api, "p1")).toMatchObject({ phase: "ended", status: "generated" });
  });

  it("is read-only for someone who did not ask", async () => {
    const { api } = fakeApi({ skip: vi.fn(async () => refused("not_found", 404)) });
    expect(await skipProposal(api, "p1")).toMatchObject({ phase: "readonly" });
  });
});

describe("the other states", () => {
  it("working names the action that is running", () => {
    expect(startAction("skip")).toEqual({
      phase: "working",
      action: "skip",
      status: null,
      result: null,
      failure: null,
    });
  });

  it("a request that could not be sent asks again with a network failure", () => {
    expect(unavailable()).toMatchObject({ phase: "asking", failure: { code: "network", status: 0 } });
  });
});
