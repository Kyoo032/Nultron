import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_ADMIN_PATH,
  GATEWAY_ADMIN_STATUSES,
  parseGatewayAdminState,
  readGatewayAdmin,
  removeGatewayAdmin,
  saveGatewayAdmin,
} from "./gateway-admin-client";

const SENTINEL = "gw-mgmt-SENTINEL-7f3a9c";
const OK_STATE = { configured: true, accountIdSet: true, checkedAt: "2026-10-15T09:30:00.000Z", status: "ok" };
const EMPTY_STATE = { configured: false, accountIdSet: false, checkedAt: null, status: "unchecked" };

type Call = { input: string; init: RequestInit };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseGatewayAdminState", () => {
  it("reads the four fields", () => {
    expect(parseGatewayAdminState(OK_STATE)).toEqual(OK_STATE);
  });

  it("reads a body the transport nests under body", () => {
    expect(parseGatewayAdminState({ body: OK_STATE })).toEqual(OK_STATE);
  });

  it("keeps every status the host can report", () => {
    for (const status of GATEWAY_ADMIN_STATUSES) {
      expect(parseGatewayAdminState({ ...OK_STATE, status })?.status).toBe(status);
    }
  });

  it("reads an unknown status as not checked, so the screen never shows a made-up state", () => {
    expect(parseGatewayAdminState({ configured: true, status: "revoked" })).toEqual({
      configured: true,
      accountIdSet: false,
      checkedAt: null,
      status: "unchecked",
    });
  });

  it("refuses a payload without a configured flag", () => {
    expect(parseGatewayAdminState({ status: "ok" })).toBeNull();
    expect(parseGatewayAdminState({ configured: "yes", status: "ok" })).toBeNull();
    expect(parseGatewayAdminState(null)).toBeNull();
    expect(parseGatewayAdminState("configured")).toBeNull();
  });

  it("drops a blank checkedAt", () => {
    expect(parseGatewayAdminState({ configured: false, checkedAt: "   " })?.checkedAt).toBeNull();
  });
});

describe("readGatewayAdmin", () => {
  it("reads the status with a plain GET on the company path", async () => {
    const calls = stubFetch(() => json(200, OK_STATE));
    await expect(readGatewayAdmin()).resolves.toEqual({ ok: true, state: OK_STATE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(GATEWAY_ADMIN_PATH);
    expect(calls[0]?.init.method).toBeUndefined();
  });

  it("answers forbidden on a 403", async () => {
    stubFetch(() => json(403, { error: { code: "forbidden" } }));
    await expect(readGatewayAdmin()).resolves.toEqual({ ok: false, reason: "forbidden" });
  });

  it("answers failed on a server error and on a body that is not a state", async () => {
    stubFetch(() => json(500, { error: { message: "boom" } }));
    await expect(readGatewayAdmin()).resolves.toEqual({ ok: false, reason: "failed" });
    stubFetch(() => json(200, {}));
    await expect(readGatewayAdmin()).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("answers failed, and does not throw, when the request never arrives", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    await expect(readGatewayAdmin()).resolves.toEqual({ ok: false, reason: "failed" });
  });
});

describe("saveGatewayAdmin", () => {
  it("PUTs the token in the JSON body and never in the URL", async () => {
    const calls = stubFetch(() => json(200, OK_STATE));
    await saveGatewayAdmin({ token: SENTINEL });
    const put = calls.find((call) => call.init.method === "PUT");
    expect(put?.input).toBe(GATEWAY_ADMIN_PATH);
    expect(put?.input).not.toContain(SENTINEL);
    expect(bodyOf(put as Call)).toEqual({ token: SENTINEL });
  });

  it("sends accountId only when one is given", async () => {
    const calls = stubFetch(() => json(200, OK_STATE));
    await saveGatewayAdmin({ token: SENTINEL, accountId: 42 });
    expect(bodyOf(calls[0] as Call)).toEqual({ token: SENTINEL, accountId: 42 });
    await saveGatewayAdmin({ token: SENTINEL });
    expect("accountId" in bodyOf(calls[1] as Call)).toBe(false);
  });

  it("takes the state from the PUT answer without a second request", async () => {
    const calls = stubFetch(() => json(200, OK_STATE));
    await expect(saveGatewayAdmin({ token: SENTINEL })).resolves.toEqual({ ok: true, state: OK_STATE });
    expect(calls).toHaveLength(1);
  });

  it("reads the status again when the PUT answer carries no state", async () => {
    const calls = stubFetch((call) => (call.init.method === "PUT" ? json(200, {}) : json(200, OK_STATE)));
    await expect(saveGatewayAdmin({ token: SENTINEL })).resolves.toEqual({ ok: true, state: OK_STATE });
    expect(calls.map((call) => call.init.method ?? "GET")).toEqual(["PUT", "GET"]);
  });

  it("never hands the token back in its result", async () => {
    stubFetch(() => json(200, { ...OK_STATE, token: SENTINEL }));
    const result = await saveGatewayAdmin({ token: SENTINEL });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("answers forbidden on a 403 and failed on any other refusal", async () => {
    stubFetch(() => json(403, {}));
    await expect(saveGatewayAdmin({ token: SENTINEL })).resolves.toEqual({ ok: false, reason: "forbidden" });
    stubFetch(() => json(502, {}));
    await expect(saveGatewayAdmin({ token: SENTINEL })).resolves.toEqual({ ok: false, reason: "failed" });
  });
});

describe("removeGatewayAdmin", () => {
  it("DELETEs the company path and returns the state the host reports", async () => {
    const calls = stubFetch(() => json(200, EMPTY_STATE));
    await expect(removeGatewayAdmin()).resolves.toEqual({ ok: true, state: EMPTY_STATE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(GATEWAY_ADMIN_PATH);
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("answers failed when the host refuses the delete", async () => {
    stubFetch(() => json(500, {}));
    await expect(removeGatewayAdmin()).resolves.toEqual({ ok: false, reason: "failed" });
  });
});
