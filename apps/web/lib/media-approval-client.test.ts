import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAlwaysAllow,
  fetchMediaProposal,
  generateMediaProposal,
  setAlwaysAllow,
  skipMediaProposal,
} from "./media-approval-client";

type Call = { readonly input: string; readonly method: string; readonly body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stub(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      input,
      method: (init.method ?? "GET").toUpperCase(),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

const PROPOSAL = {
  id: "p1",
  kind: "image",
  prompt: "a red boat",
  model: "gpt-image",
  estimate: { amountMicros: 40000, currency: "USD" },
  status: "pending",
  threadId: "t1",
  createdAt: "2026-10-15T10:00:00.000Z",
  decidedAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media proposal calls", () => {
  it("reads one proposal from GET /api/v1/media/proposals/:id", async () => {
    const calls = stub(() => json({ proposal: PROPOSAL }));
    const outcome = await fetchMediaProposal("p1");
    expect(calls).toEqual([{ input: "/api/v1/media/proposals/p1", method: "GET", body: undefined }]);
    expect(outcome).toEqual({
      ok: true,
      value: {
        id: "p1",
        kind: "image",
        prompt: "a red boat",
        status: "pending",
        estimate: { amountMicros: 40000, currency: "USD" },
      },
    });
  });

  it("encodes the id in the path", async () => {
    const calls = stub(() => json({ proposal: { ...PROPOSAL, id: "a/b" } }));
    await fetchMediaProposal("a/b");
    expect(calls[0]?.input).toBe("/api/v1/media/proposals/a%2Fb");
  });

  it("POSTs generate and reads the proposal and the tool's result", async () => {
    const calls = stub(() =>
      json({
        proposal: { ...PROPOSAL, status: "generated" },
        result: { success: true, backend: "gateway", image: "/api/v1/media/m1/file" },
      }),
    );
    const outcome = await generateMediaProposal("p1");
    expect(calls).toEqual([{ input: "/api/v1/media/proposals/p1/generate", method: "POST", body: undefined }]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.proposal.status).toBe("generated");
      expect(outcome.value.result).toEqual({ success: true, backend: "gateway", image: "/api/v1/media/m1/file" });
    }
  });

  it("keeps a generate result that is absent as null, not as an error", async () => {
    stub(() => json({ proposal: { ...PROPOSAL, status: "failed" } }));
    const outcome = await generateMediaProposal("p1");
    expect(outcome.ok && outcome.value.result).toBeNull();
  });

  it("POSTs skip to /skip and reads the proposal", async () => {
    const calls = stub(() => json({ proposal: { ...PROPOSAL, status: "skipped" } }));
    const outcome = await skipMediaProposal("p1");
    expect(calls[0]).toEqual({ input: "/api/v1/media/proposals/p1/skip", method: "POST", body: undefined });
    expect(outcome.ok && outcome.value.status).toBe("skipped");
  });

  it("keeps a nested refusal's code, status and the host's message", async () => {
    stub(() => json({ error: { code: "not_pending", message: "Already decided." } }, 409));
    const outcome = await skipMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "not_pending", status: 409, message: "Already decided." });
  });

  it("reads the expired refusal as its own code", async () => {
    stub(() => json({ error: { code: "expired", message: "Too old." } }, 409));
    const outcome = await generateMediaProposal("p1");
    expect(outcome.ok ? null : outcome.code).toBe("expired");
  });

  it("reads a 404 as not_found, the same for a missing id and another person's", async () => {
    stub(() => json({ error: { code: "not_found", message: "Not found." } }, 404));
    const outcome = await fetchMediaProposal("someone-else");
    expect(outcome).toEqual({ ok: false, code: "not_found", status: 404, message: "Not found." });
  });

  it("reads the flat gateway_blocked body, which has no nested envelope", async () => {
    stub(() => json({ error: "gateway_blocked", status: "needs_key", message: "No key." }, 403));
    const outcome = await generateMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "gateway_blocked", status: 403, message: "No key." });
  });

  it("passes a quota refusal's own code and host message through unchanged", async () => {
    stub(() => json({ error: { code: "storage_quota_exceeded", message: "No storage left." } }, 403));
    const outcome = await generateMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "storage_quota_exceeded", status: 403, message: "No storage left." });
  });

  it("reads a network failure as network, with status 0", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await fetchMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "network", status: 0, message: null });
  });

  it("reads a body of the wrong shape as unknown rather than throwing", async () => {
    stub(() => json({ nope: true }));
    const outcome = await fetchMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "unknown", status: 200, message: null });
  });

  it("reads a failure with no JSON body as unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    const outcome = await generateMediaProposal("p1");
    expect(outcome).toEqual({ ok: false, code: "unknown", status: 500, message: null });
  });
});

describe("always allow calls", () => {
  it("reads both kinds from GET /api/v1/media/always-allow", async () => {
    const calls = stub(() => json({ image: false, video: true }));
    const outcome = await fetchAlwaysAllow();
    expect(calls).toEqual([{ input: "/api/v1/media/always-allow", method: "GET", body: undefined }]);
    expect(outcome).toEqual({ ok: true, value: { image: false, video: true } });
  });

  it("PUTs the kind and the choice as JSON and reads both kinds back", async () => {
    const calls = stub(() => json({ image: true, video: false }));
    const outcome = await setAlwaysAllow("image", true);
    expect(calls).toEqual([
      { input: "/api/v1/media/always-allow", method: "PUT", body: { kind: "image", allow: true } },
    ]);
    expect(outcome).toEqual({ ok: true, value: { image: true, video: false } });
  });

  it("refuses a read that is not both kinds", async () => {
    stub(() => json({ image: true }));
    const outcome = await fetchAlwaysAllow();
    expect(outcome.ok ? null : outcome.code).toBe("unknown");
  });
});
