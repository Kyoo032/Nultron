import { describe, expect, it, vi } from "vitest";
import { STEP_RETRY_DELAYS_MS, sendStepWithRetry, takeStepSend } from "./step-retry";

const status = (code: number) => new Response(`{"error":{"code":"x"}}`, { status: code });
const noWait = async (_ms: number) => {};

function scripted(codes: number[]) {
  const send = vi.fn(async () => status(codes[Math.min(send.mock.calls.length - 1, codes.length - 1)] ?? 200));
  return send;
}

describe("sendStepWithRetry", () => {
  it("sends once and hands back the answer when the step is the run's first", async () => {
    const send = scripted([503, 200]);
    const response = await sendStepWithRetry(send, { armed: false, sleep: noWait });
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a step after a tool again on 503 until it answers", async () => {
    const send = scripted([503, 200]);
    const response = await sendStepWithRetry(send, { armed: true, sleep: noWait });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("treats 502 like 503", async () => {
    const send = scripted([502, 200]);
    expect((await sendStepWithRetry(send, { armed: true, sleep: noWait })).status).toBe(200);
  });

  it("stops after its retries and hands back the last refusal", async () => {
    const send = scripted([503]);
    const sleep = vi.fn(noWait);
    const response = await sendStepWithRetry(send, { armed: true, sleep });
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1 + STEP_RETRY_DELAYS_MS.length);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([...STEP_RETRY_DELAYS_MS]);
  });

  it.each([400, 401, 404, 429, 500, 504])("never sends again on %i", async (code) => {
    const send = scripted([code, 200]);
    expect((await sendStepWithRetry(send, { armed: true, sleep: noWait })).status).toBe(code);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops waiting and sends nothing more once the run is cancelled", async () => {
    const abort = new AbortController();
    const send = scripted([503, 200]);
    const sleep = vi.fn(async (_ms: number) => {
      abort.abort(new Error("stopped"));
    });
    await expect(sendStepWithRetry(send, { armed: true, signal: abort.signal, sleep })).rejects.toThrow("stopped");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("takeStepSend", () => {
  it("leaves a call's first send unarmed and arms every send after it", () => {
    const gate = { sends: 0 };
    expect([takeStepSend(gate), takeStepSend(gate), takeStepSend(gate)]).toEqual([false, true, true]);
  });
});
