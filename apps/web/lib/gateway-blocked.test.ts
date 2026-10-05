/**
 * A `403 gateway_blocked` from any call, read once, in the one place every answer passes through.
 *
 * Shaped like `plan-block.test.ts` and `api-client-plan-block.test.ts`: the real `apiFetch` with a
 * stubbed `fetch`, because what has to be true is about that shared path. On the hosted build the
 * answer flips the shared gate store, so every pane shows its calm "add your key" state and no pane
 * shows a generic failure. Off the hosted build it does nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api-client";
import { getGateState, resetGateStateForTests } from "./gate-state";
import {
  gatewayBlockedMessage,
  hostedGatewayBlocked,
  isGatewayBlockedText,
  messageUnlessBlocked,
  RECONCILE_MIN_GAP_MS,
  resetGatewayBlockedForTests,
} from "./gateway-blocked";
import { resetSettingsReadForTests } from "./settings-read";
import { applyLocale, resetLocaleForTests } from "./i18n";

type Answer = { status: number; body: unknown };

let answer: Answer = { status: 200, body: {} };

function response({ status, body }: Answer): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const BLOCKED: Answer = {
  status: 403,
  body: { error: "gateway_blocked", status: "needs_key", message: "No gateway key is saved on this machine." },
};

beforeEach(() => {
  answer = { status: 200, body: {} };
  resetGateStateForTests();
  resetGatewayBlockedForTests();
  resetSettingsReadForTests();
  vi.stubGlobal("fetch", async () => response(answer));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
  resetLocaleForTests();
});

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("on the hosted build", () => {
  beforeEach(() => vi.stubGlobal("__AGENTFORGE_SERVER__", "1"));

  it("flags the desk as needing a key when any route answers gateway_blocked", async () => {
    answer = BLOCKED;
    await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    await settled();

    expect(getGateState().blocked).toBe(true);
  });

  it("leaves the caller's own body readable: a report, not a theft", async () => {
    answer = BLOCKED;
    const res = await apiFetch("/api/v1/documents", { method: "POST", body: "{}" });
    await settled();

    expect(await res.json()).toEqual(BLOCKED.body);
  });

  it("does nothing for any other answer", async () => {
    for (const other of [
      { status: 200, body: { ok: true } },
      { status: 403, body: { error: "plan_past_due", message: "overdue" } },
      { status: 403, body: { error: { code: "forbidden", message: "no" } } },
      { status: 401, body: { error: { code: "session_required", message: "sign in" } } },
      { status: 500, body: { error: { code: "boom", message: "x" } } },
    ]) {
      answer = other;
      await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
      await settled();
    }
    expect(getGateState().blocked).toBe(false);
  });

  it("reads the flat gateway block only as a gateway block", () => {
    expect(hostedGatewayBlocked(BLOCKED.body)).toEqual({
      status: "needs_key",
      message: "No gateway key is saved on this machine.",
    });
    expect(hostedGatewayBlocked({ error: "plan_past_due" })).toBeNull();
    expect(hostedGatewayBlocked({ error: { code: "gateway_blocked", message: "x" } })).toBeNull();
    expect(hostedGatewayBlocked(null)).toBeNull();
  });
});

describe("a refusal is a local flag, and the host's gate is the truth (hosted)", () => {
  const OPEN_GATE = {
    status: "ok",
    allowed: true,
    grace: false,
    endpoint: "https://api.tokotokenai.com/v1",
    endpointLocked: true,
    checkedAt: "2026-10-01T00:00:00.000Z",
    lastOkAt: "2026-10-01T00:00:00.000Z",
  };
  const CLOSED_GATE = { ...OPEN_GATE, status: "needs_key", allowed: false, checkedAt: null, lastOkAt: null };
  let settingsGate: unknown = OPEN_GATE;
  let settingsReads = 0;

  beforeEach(() => {
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
    settingsGate = OPEN_GATE;
    settingsReads = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      if (String(input).includes("/api/v1/settings")) {
        settingsReads += 1;
        return response({ status: 200, body: { gateway: settingsGate } });
      }
      return response(answer);
    });
  });

  it("asks the host for its gate after a refusal, and an open gate clears the flag", async () => {
    answer = BLOCKED;
    await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settingsReads).toBe(1);
    // A verdict that had recovered: the host says the key works, so no pane stays quiet.
    expect(getGateState().blocked).toBe(false);
  });

  it("keeps the flag when the host agrees the gate is closed", async () => {
    settingsGate = CLOSED_GATE;
    answer = BLOCKED;
    await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getGateState().blocked).toBe(true);
    expect(getGateState().gate?.allowed).toBe(false);
  });

  it("asks at most once in a burst of refusals", async () => {
    answer = BLOCKED;
    for (let i = 0; i < 4; i += 1) {
      await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settingsReads).toBe(1);
    expect(RECONCILE_MIN_GAP_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("the refused-for-no-key banner, and only that banner", () => {
  it("recognises its own sentence and no other", () => {
    expect(isGatewayBlockedText(gatewayBlockedMessage())).toBe(true);
    for (const other of ["Request failed", "Could not read that file", "", null, undefined]) {
      expect(isGatewayBlockedText(other), String(other)).toBe(false);
    }
  });

  it("maps a hosted 403 to that sentence and leaves every other body to its own reader", () => {
    vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
    expect(messageUnlessBlocked(BLOCKED.body, () => "generic")).toBe(gatewayBlockedMessage());
    expect(messageUnlessBlocked({ error: { code: "x", message: "m" } }, () => "generic")).toBe("generic");
    expect(messageUnlessBlocked(null, () => "generic")).toBe("generic");
  });

  it("maps nothing on the Personal app", () => {
    expect(messageUnlessBlocked(BLOCKED.body, () => "generic")).toBe("generic");
  });
});

describe("off the hosted build — the Personal app", () => {
  it("never flags anything: a gateway_blocked answer is read exactly as it always was", async () => {
    answer = BLOCKED;
    const res = await apiFetch("/api/v1/research/stream", { method: "POST", body: "{}" });
    await settled();

    expect(res.status).toBe(403);
    expect(getGateState()).toEqual({ gate: null, blocked: false });
  });

  it("does not read a gateway block out of a body: callers keep the generic path they had", () => {
    expect(hostedGatewayBlocked(BLOCKED.body)).toBeNull();
  });
});

describe("the sentence", () => {
  it("is catalog copy in both languages, names Settings, and never carries the host's technical message", () => {
    const en = gatewayBlockedMessage();
    expect(en).toMatch(/key/i);
    expect(en).toMatch(/Settings/);
    expect(en).not.toMatch(/machine|HTTP|gateway_blocked/);

    applyLocale("id");
    const id = gatewayBlockedMessage();
    expect(id).not.toBe(en);
    expect(id).toMatch(/Pengaturan/);
  });
});
