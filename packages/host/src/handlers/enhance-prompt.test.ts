import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stubEnhancePrompt } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { getBootLocale } from "../locale-boot";
import { handlePostEnhancePrompt } from "./enhance-prompt";
import type { HostRequest } from "../types";

function request(body: unknown): HostRequest {
  return {
    method: "POST",
    path: "/api/v1/prompts/enhance",
    query: {},
    params: {},
    headers: {},
    body,
  };
}

describe("handlePostEnhancePrompt", () => {
  const previous = process.env.AGENTFORGE_RUNTIME;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.AGENTFORGE_RUNTIME;
    } else {
      process.env.AGENTFORGE_RUNTIME = previous;
    }
  });

  it("rejects empty input", async () => {
    process.env.AGENTFORGE_RUNTIME = "stub";
    const result = await handlePostEnhancePrompt(request({ text: "   " }));
    expect(result.type).toBe("json");
    if (result.type !== "json") {
      return;
    }
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "empty_input" } });
  });

  it("rewrites locally on stub without a preface", async () => {
    process.env.AGENTFORGE_RUNTIME = "stub";
    const result = await handlePostEnhancePrompt(request({ text: "Summarize this memo.", surface: "documents" }));
    expect(result.type).toBe("json");
    if (result.type !== "json") {
      return;
    }
    expect(result.status).toBe(200);
    const text = (result.body as { text?: string }).text ?? "";
    expect(text.length).toBeGreaterThan("Summarize this memo".length);
    expect(text).not.toMatch(/Enhanced prompt/i);
    expect(text.startsWith("Summarize this memo")).toBe(true);
  });
});

/**
 * Hosted: a tenant with no key gets 403 gateway_blocked, like every other gated route.
 *
 * The handler answered 200 with local stub text whenever the runtime resolved to "stub" (no saved key
 * and `AGENTFORGE_RUNTIME` not "ai"). On a desk that is the point of stub. On the hosted server it is
 * a misconfiguration and a lie: the tenant has no key, the gate is closed (`needs_key`), and the one
 * route that never said so was prompt enhancement, which answered a "rewrite" that no model had made.
 */
describe("handlePostEnhancePrompt on the hosted server", () => {
  const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
  const IDENTITY = { tenantId: "enhance-tenant", orgId: "enhance-org", userId: "enhance-user" };
  const previousRuntime = process.env.AGENTFORGE_RUNTIME;
  let store: ReturnType<typeof import("../auth/session-store").createMemorySessionStore>;
  let sessionId: string;
  let dispatch: typeof import("../router").dispatch;
  let secure: string;

  beforeAll(async () => {
    process.env.AGENTFORGE_SECRETS_KEY = "9d4b7e12a0c63f58e1b2d7a94c0368fe5a1d27b9c40e8f3615ad72be09c4f813";
    const { db, ensurePortalOwner } = await import("@agentforge/db");
    await ensurePortalOwner(db, { ...IDENTITY, role: "owner" });
    ({ dispatch } = await import("../router"));
    const { createSession, SESSION_COOKIE_SECURE } = await import("../auth/session");
    const { createMemorySessionStore } = await import("../auth/session-store");
    secure = SESSION_COOKIE_SECURE;
    store = createMemorySessionStore();
    const session = createSession({ ...IDENTITY, now: T0 });
    await store.create(session);
    sessionId = session.id;
  }, ROUTER_IMPORT_BUDGET_MS);

  beforeEach(() => {
    process.env.AGENTFORGE_SERVER = "1";
  });

  afterEach(() => {
    delete process.env.AGENTFORGE_SERVER;
    if (previousRuntime === undefined) {
      delete process.env.AGENTFORGE_RUNTIME;
    } else {
      process.env.AGENTFORGE_RUNTIME = previousRuntime;
    }
  });

  async function enhance(body: unknown) {
    const result = await dispatch(
      { ...request(body), headers: { cookie: `${secure}=${sessionId}` } },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
    if (result.type !== "json") {
      throw new Error(`expected json, got ${result.type}`);
    }
    return result;
  }

  it.each(["stub", undefined, "ai"])(
    "answers 403 gateway_blocked, never stub text, for a tenant with no key (runtime %s)",
    async (runtime) => {
      if (runtime === undefined) {
        delete process.env.AGENTFORGE_RUNTIME;
      } else {
        process.env.AGENTFORGE_RUNTIME = runtime;
      }

      const result = await enhance({ text: "Summarize this memo.", surface: "documents" });

      expect(result.status).toBe(403);
      // The flat body the renderer parses (`parseGatewayBlocked`), the same one every gated route sends.
      expect(result.body).toMatchObject({ error: "gateway_blocked", status: "needs_key" });
      expect(JSON.stringify(result.body)).not.toContain("Summarize this memo");
      expect((result.body as { source?: string }).source).toBeUndefined();
    },
  );

  it("still validates the input before it asks the gate", async () => {
    process.env.AGENTFORGE_RUNTIME = "stub";
    const result = await enhance({ text: "   " });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "empty_input" } });
  });
});

/**
 * Personal parity. A desk with no key and the stub runtime is how the app runs offline and under
 * test: it has always answered 200 with a local rewrite, and the hosted rule above does not reach it.
 */
describe("handlePostEnhancePrompt on a desk is unchanged", () => {
  const previousRuntime = process.env.AGENTFORGE_RUNTIME;

  afterEach(() => {
    delete process.env.AGENTFORGE_SERVER;
    if (previousRuntime === undefined) {
      delete process.env.AGENTFORGE_RUNTIME;
    } else {
      process.env.AGENTFORGE_RUNTIME = previousRuntime;
    }
  });

  it.each(["stub", undefined])(
    "answers 200 with exactly the local stub rewrite when there is no key (runtime %s)",
    async (runtime) => {
      delete process.env.AGENTFORGE_SERVER;
      if (runtime === undefined) {
        delete process.env.AGENTFORGE_RUNTIME;
      } else {
        process.env.AGENTFORGE_RUNTIME = runtime;
      }

      const result = await handlePostEnhancePrompt(request({ text: "Summarize this memo.", surface: "documents" }));

      expect(result.type).toBe("json");
      if (result.type !== "json") {
        return;
      }
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        text: stubEnhancePrompt("Summarize this memo.", "documents", getBootLocale()),
        source: "stub",
      });
    },
  );
});
