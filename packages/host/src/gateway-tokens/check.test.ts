import { pinnedGatewayOrigin, redactSecrets } from "@agentforge/core";
import { describe, expect, it } from "vitest";
import { gatewayAdminPayload, parseGatewayAdminRecord } from "./admin-record";
import { checkGatewayManagementToken, gatewayAdminCheckUrl } from "./check";

const TOKEN = "mgmt-tok-7Kq2Xa9LpR4tZ8wY";

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): { fetchFn: typeof fetch; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen = { url: String(input), init: init ?? {} };
    calls.push(seen);
    return respond(seen);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the one read-only check that saves a management token", () => {
  it("the token is a value redaction leaves alone, so a leak test cannot pass by accident", () => {
    expect(redactSecrets(TOKEN)).toBe(TOKEN);
  });

  it("asks the pinned gateway origin for one token row, and nothing else", () => {
    expect(gatewayAdminCheckUrl()).toBe(`${pinnedGatewayOrigin()}/api/token/?p=1&page_size=1`);
  });

  it("sends the token as a bearer, the account id only when one is set, and refuses redirects", async () => {
    const { fetchFn, calls } = fakeFetch(() => json(200, { success: true, data: [] }));
    await checkGatewayManagementToken({ token: TOKEN, accountId: 12, fetchFn });
    await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(gatewayAdminCheckUrl());
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "New-Api-User": "12",
    });
    expect(calls[1].init.headers).toEqual({ Accept: "application/json", Authorization: `Bearer ${TOKEN}` });
  });

  it("answers ok for a 200 whose body says success", async () => {
    const { fetchFn } = fakeFetch(() => json(200, { success: true, message: "", data: [] }));
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("ok");
  });

  it("answers invalid for a 401 and for a 403", async () => {
    for (const status of [401, 403]) {
      const { fetchFn } = fakeFetch(() => json(status, { success: false, message: "no" }));
      expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("invalid");
    }
  });

  it("answers invalid for a 200 whose body says success is false, which a new-api gateway can send", async () => {
    const { fetchFn } = fakeFetch(() => json(200, { success: false, message: "invalid token" }));
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("invalid");
  });

  it("answers unreachable for a 200 with no readable success flag", async () => {
    const { fetchFn } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("unreachable");
  });

  it("answers unreachable for a timeout and for any network failure", async () => {
    const timeout = fakeFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn: timeout.fetchFn })).toBe(
      "unreachable",
    );
    const refused = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn: refused.fetchFn })).toBe(
      "unreachable",
    );
  });

  it("answers unreachable for a 5xx", async () => {
    const { fetchFn } = fakeFetch(() => json(503, { success: false }));
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("unreachable");
  });

  it("refuses a redirect: one request, no second hop, and unreachable", async () => {
    const { fetchFn, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/api/token/" } }),
    );
    expect(await checkGatewayManagementToken({ token: TOKEN, accountId: null, fetchFn })).toBe("unreachable");
    expect(calls).toHaveLength(1);
    expect(calls.map((call) => call.url)).not.toContain("https://elsewhere.example/api/token/");
  });

  it("never puts the token in what it returns", async () => {
    const { fetchFn } = fakeFetch(() => json(401, { success: false }));
    const result = await checkGatewayManagementToken({ token: TOKEN, accountId: 3, fetchFn });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("the stored record and what the renderer may see of it", () => {
  it("reads a damaged record as absent rather than guessing", () => {
    expect(parseGatewayAdminRecord({ token: "has a space" })).toBeNull();
    expect(parseGatewayAdminRecord({ token: "", accountId: null })).toBeNull();
    expect(parseGatewayAdminRecord({ token: TOKEN, accountId: 0 })).toBeNull();
    expect(parseGatewayAdminRecord({ token: TOKEN, accountId: "abc" })).toBeNull();
    expect(parseGatewayAdminRecord(null)).toBeNull();
  });

  it("keeps a valid record and falls an unknown status back to unchecked", () => {
    expect(parseGatewayAdminRecord({ token: TOKEN, accountId: 7, checkedAt: 5, status: "ok" })).toEqual({
      token: TOKEN,
      accountId: 7,
      checkedAt: 5,
      status: "ok",
    });
    expect(parseGatewayAdminRecord({ token: TOKEN, accountId: null, status: "weird" })?.status).toBe("unchecked");
  });

  it("projects a record to the four fields the GET answers, with no token in it", () => {
    const payload = gatewayAdminPayload({ token: TOKEN, accountId: 9, checkedAt: 100, status: "invalid" });
    expect(payload).toEqual({ configured: true, accountIdSet: true, checkedAt: 100, status: "invalid" });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(gatewayAdminPayload(null)).toEqual({
      configured: false,
      accountIdSet: false,
      checkedAt: null,
      status: "unchecked",
    });
  });
});
