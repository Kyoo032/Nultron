/**
 * How the portal signs people in, as the host learns it (`./portal-mode.ts`), and the wiring that keeps
 * a desk out of it. No test here reaches a network: every portal is a stub `fetch`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostAuthRoutes, resetHostAuthForTests } from "./index";
import {
  PORTAL_MODE_FRESH_MS,
  PORTAL_MODE_RETRY_MS,
  PORTAL_SIGNIN_MODE_PATH,
  createPortalModeReader,
} from "./portal-mode";

const BASE = "https://portal.example.test";

type Reply = { readonly status: number; readonly body?: unknown } | "throw" | "not-json";

function portal(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.length > 1 ? (replies.shift() as Reply) : replies[0];
    if (next === "throw") {
      throw new TypeError("fetch failed");
    }
    if (next === "not-json") {
      return new Response("<html>proxy</html>", { status: 200 });
    }
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("the portal's word", () => {
  it("is password only when the portal says exactly that", async () => {
    const { fetchImpl, calls } = portal([{ status: 200, body: { mode: "password" } }]);
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl });
    expect(await reader.read()).toBe("password");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}${PORTAL_SIGNIN_MODE_PATH}`);
    expect(calls[0].init?.method).toBe("GET");
    // A redirect is not the portal answering, and nothing is sent that a person typed.
    expect(calls[0].init?.redirect).toBe("manual");
    expect(Object.keys((calls[0].init?.headers ?? {}) as object)).toEqual(["accept"]);
  });

  it("is code when the portal does not have the route, which is how the default mode and an older portal answer", async () => {
    const { fetchImpl } = portal([{ status: 404, body: { error: "not_found" } }]);
    expect(await createPortalModeReader({ baseUrl: BASE, fetchImpl }).read()).toBe("code");
  });

  it("is code, and not believed, for anything it cannot read as an answer", async () => {
    const unreadable: Reply[] = [
      { status: 500 },
      { status: 502, body: { mode: "password" } },
      { status: 302, body: { mode: "password" } },
      { status: 200, body: { mode: "Password" } },
      { status: 200, body: { mode: ["password"] } },
      { status: 200, body: {} },
      { status: 200, body: null },
      "not-json",
      "throw",
    ];
    for (const reply of unreadable) {
      const { fetchImpl } = portal([reply]);
      const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl });
      expect(await reader.read(), JSON.stringify(reply)).toBe("code");
    }
  });

  it("is code when there is no portal URL to ask", async () => {
    const { fetchImpl, calls } = portal([{ status: 200, body: { mode: "password" } }]);
    const reader = createPortalModeReader({ env: {}, fetchImpl });
    expect(await reader.read()).toBe("code");
    expect(calls).toHaveLength(0);
  });

  it("never waits longer than its own timeout for a portal that does not answer", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    ) as unknown as typeof fetch;
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl: hang, timeoutMs: 40 });
    const started = Date.now();
    expect(await reader.read()).toBe("code");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("what it remembers", () => {
  it("asks once for any number of reads inside the fresh window", async () => {
    const time = clock();
    const { fetchImpl } = portal([{ status: 200, body: { mode: "password" } }]);
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl, now: time.now });
    await Promise.all(Array.from({ length: 10 }, () => reader.read()));
    time.advance(PORTAL_MODE_FRESH_MS - 1);
    expect(await reader.read()).toBe("password");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("answers from memory when it has gone stale and asks again behind the answer", async () => {
    const time = clock();
    const { fetchImpl } = portal([{ status: 200, body: { mode: "password" } }, { status: 404 }]);
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl, now: time.now });
    expect(await reader.read()).toBe("password");
    time.advance(PORTAL_MODE_FRESH_MS + 1);

    // The stale answer comes back at once; the portal has changed its mind by the next read.
    expect(await reader.read()).toBe("password");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(await reader.read()).toBe("code");
  });

  it("keeps a heard answer through a failure, and does not hammer a portal that is down", async () => {
    const time = clock();
    const { fetchImpl } = portal([{ status: 200, body: { mode: "password" } }, "throw"]);
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl, now: time.now });
    expect(await reader.read()).toBe("password");

    time.advance(PORTAL_MODE_FRESH_MS + 1);
    expect(await reader.read()).toBe("password");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    // Backing off: reads inside the retry window do not ask again.
    for (let index = 0; index < 5; index += 1) {
      expect(await reader.read()).toBe("password");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    time.advance(PORTAL_MODE_RETRY_MS);
    expect(await reader.read()).toBe("password");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });

  it("does not cache a failure as an answer: the next read after the back-off asks again", async () => {
    const time = clock();
    const { fetchImpl } = portal(["throw", { status: 200, body: { mode: "password" } }]);
    const reader = createPortalModeReader({ baseUrl: BASE, fetchImpl, now: time.now });
    expect(await reader.read()).toBe("code");
    expect(await reader.read()).toBe("code");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    time.advance(PORTAL_MODE_RETRY_MS);
    expect(await reader.read()).toBe("password");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("the hosted wiring", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
    vi.unstubAllEnvs();
    resetHostAuthForTests();
  });

  function stubPortal(mode: "password" | "code"): ReturnType<typeof vi.fn> {
    const stub = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith(PORTAL_SIGNIN_MODE_PATH)) {
        return mode === "password"
          ? new Response(JSON.stringify({ mode: "password" }), { status: 200 })
          : new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      throw new Error(`unexpected request ${String(url)}`);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    return stub;
  }

  it("tells a hosted sign-in screen that the portal uses a password, and nothing else changes", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    vi.stubEnv("AGENTFORGE_PORTAL_URL", BASE);
    const stub = stubPortal("password");
    resetHostAuthForTests();
    const result = await hostAuthRoutes().handleSession({
      method: "GET",
      path: "/api/v1/auth/session",
      query: {},
      params: {},
      headers: {},
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ signedIn: false, signInMode: "password" });
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("says nothing extra when the hosted portal is in the default mode", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    vi.stubEnv("AGENTFORGE_PORTAL_URL", BASE);
    stubPortal("code");
    resetHostAuthForTests();
    const result = await hostAuthRoutes().handleSession({
      method: "GET",
      path: "/api/v1/auth/session",
      query: {},
      params: {},
      headers: {},
    });
    expect(result.body).toEqual({ signedIn: false });
    expect(JSON.stringify(result.body)).toBe('{"signedIn":false}');
  });

  it("is not wired on a desk: Personal and webdev make no request and answer as they always did", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "0");
    vi.stubEnv("AGENTFORGE_PORTAL_URL", BASE);
    const stub = stubPortal("password");
    resetHostAuthForTests();
    const result = await hostAuthRoutes().handleSession({
      method: "GET",
      path: "/api/v1/auth/session",
      query: {},
      params: {},
      headers: {},
    });
    expect(result.body).toEqual({ signedIn: false });
    expect(stub).not.toHaveBeenCalled();
  });
});
