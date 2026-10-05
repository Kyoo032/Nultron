import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSdkRuntime } from "./ai-sdk-runtime";
import { resetLearnedEffortLimits } from "./effort-selfheal";
import { isRetryableModelFailure } from "./retry";
import { redirectRefusedFailure } from "../gateway-http-copy";
import type { TenantContext } from "../tenancy/types";
import type { AgentVersionRecord } from "../agents/service";
import type { RuntimeEvent } from "./types";

/**
 * Enterprise BYOK, Phase A: what the runtime does with a tenant's key on the hosted server.
 *
 * Two rules, both gated on server mode, both with a Personal twin that says nothing moved:
 *
 * 1. **A key-bearing request never follows a redirect.** Node strips `Authorization` when a redirect
 *    crosses origins but NOT `x-api-key` / `x-goog-api-key`, which are the headers the Anthropic
 *    Messages and Google generateContent wires carry. A 3xx from the provider (or from whoever sits
 *    in front of it) would otherwise carry the key to the host the `Location` names.
 * 2. **A provider's host comes from the registry.** The runtime ignores the base URLs its caller
 *    resolved for Google, Anthropic and Volcengine and uses the registry's literals.
 *
 * Real loopback servers for rule 1 (the redirect is the thing under test, a stubbed `fetch` could not
 * see it); a stubbed `fetch` for rule 2 (the URL is the thing under test).
 */

const tenant: TenantContext = {
  tenantId: "tenant-a",
  organizationId: "org",
  workspaceId: "ws",
  userId: "user",
  role: "owner",
};

const KEY = "sk-test-redirect-secret-1234567890";

function versionFor(model: string): AgentVersionRecord {
  return {
    id: `v-${model}`,
    agentId: "chat",
    organizationId: "org",
    version: 1,
    systemPrompt: "You are helpful.",
    model,
    inputModalities: ["text"],
    config: {},
    createdAt: new Date(0),
  };
}

type Keys = ConstructorParameters<typeof AiSdkRuntime>[0];

async function run(
  keys: Keys,
  model: string,
  locale: "en" | "id" = "en",
  signal?: AbortSignal,
): Promise<{ events: RuntimeEvent[]; failed: Error | undefined }> {
  const events: RuntimeEvent[] = [];
  let failed: Error | undefined;
  try {
    await new AiSdkRuntime(keys).execute({
      tenant,
      runId: "run-server-mode",
      modality: "text",
      version: versionFor(model),
      bindings: [],
      history: [{ role: "user", parts: [{ type: "text", text: "Say ok." }] }],
      locale,
      ...(signal ? { signal } : {}),
      onEvent: (event) => {
        events.push(event);
      },
    });
  } catch (error) {
    failed = error instanceof Error ? error : new Error(String(error));
  }
  return { events, failed };
}

type Seen = { url: string; headers: IncomingHttpHeaders };

type Pair = {
  /** Answers every request with a 307 to `target`. */
  origin: string;
  /** The host the redirect names. Records what reached it. */
  target: Seen[];
  close: () => Promise<void>;
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function redirectingPair(status = 307): Promise<Pair> {
  const target: Seen[] = [];
  const attacker = createServer((request, response) => {
    target.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const attackerPort = await listen(attacker);
  const provider = createServer((_request, response) => {
    response.writeHead(status, { Location: `http://127.0.0.1:${attackerPort}/stolen` });
    response.end();
  });
  const providerPort = await listen(provider);
  return {
    origin: `http://127.0.0.1:${providerPort}`,
    target,
    close: async () => {
      await closeServer(provider);
      await closeServer(attacker);
    },
  };
}

/** A 401 the runtime reads as a hard stop. An empty body would be retried, with backoff, for seconds. */
function refused(): Response {
  return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Incorrect API key provided." } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

const SERVER_FLAG = "AGENTFORGE_SERVER";
let previousFlag: string | undefined;

beforeEach(() => {
  previousFlag = process.env[SERVER_FLAG];
  resetLearnedEffortLimits();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousFlag === undefined) {
    delete process.env[SERVER_FLAG];
  } else {
    process.env[SERVER_FLAG] = previousFlag;
  }
});

/** One model per wire: Messages (x-api-key), generateContent (x-goog-api-key) and Responses (a bearer). */
const WIRES = [
  { wire: "anthropic_messages", model: "claude-sonnet-5-5" },
  { wire: "google_generate_content", model: "gemini-3.5-flash" },
  { wire: "responses", model: "gpt-6-luna" },
] as const;

describe("a key-bearing request never follows a redirect on the hosted server", () => {
  for (const { wire, model } of WIRES) {
    it(`${wire}: a 307 to another host is refused and the key does not travel`, async () => {
      process.env[SERVER_FLAG] = "1";
      const pair = await redirectingPair(307);
      try {
        const { events, failed } = await run({ openai: KEY, openaiBaseUrl: `${pair.origin}/v1` }, model);
        expect(pair.target, "the redirect target must never be contacted").toEqual([]);
        expect(failed).toBeDefined();
        const message = events.find((event) => event.type === "run.failed");
        expect(message && "message" in message ? message.message : "").toMatch(/redirect/i);
        expect(JSON.stringify(events)).not.toContain(KEY);
        expect(failed?.message ?? "").not.toContain(KEY);
      } finally {
        await pair.close();
      }
    });
  }

  it("refuses every redirect status, not only 307", async () => {
    process.env[SERVER_FLAG] = "1";
    for (const status of [301, 302, 303, 308]) {
      const pair = await redirectingPair(status);
      try {
        const { failed } = await run({ openai: KEY, openaiBaseUrl: `${pair.origin}/v1` }, "claude-sonnet-5-5");
        expect(failed, String(status)).toBeDefined();
        expect(pair.target, String(status)).toEqual([]);
      } finally {
        await pair.close();
      }
    }
  });

  it("does not treat the refusal as a transient fault worth retrying", async () => {
    for (const locale of ["en", "id"] as const) {
      const failure = redirectRefusedFailure(307, locale);
      expect(failure.status).toBe(307);
      expect(isRetryableModelFailure(failure.message), failure.message).toBe(false);
      expect(failure.message).toContain("307");
    }
  });

  it("explains the refusal in both app locales", () => {
    expect(redirectRefusedFailure(307, "en").message).toMatch(/redirect/i);
    expect(redirectRefusedFailure(307, "id").message).toMatch(/pengalihan/i);
    expect(redirectRefusedFailure(307, "id").message).not.toBe(redirectRefusedFailure(307, "en").message);
  });

  it("asks fetch for manual redirects on the hosted server", async () => {
    process.env[SERVER_FLAG] = "1";
    const inits: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      inits.push(init);
      return refused();
    });
    for (const { model } of WIRES) {
      await run({ openai: KEY, openaiBaseUrl: "https://gateway.test/v1" }, model);
    }
    expect(inits.length).toBeGreaterThanOrEqual(WIRES.length);
    for (const init of inits) {
      expect(init?.redirect).toBe("manual");
    }
  });
});

describe("Personal parity: off the hosted server the runtime follows redirects exactly as before", () => {
  it("asks fetch for nothing special", async () => {
    delete process.env[SERVER_FLAG];
    const inits: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      inits.push(init);
      return refused();
    });
    for (const { model } of WIRES) {
      await run({ openai: KEY, openaiBaseUrl: "https://gateway.test/v1" }, model);
    }
    expect(inits.length).toBeGreaterThanOrEqual(WIRES.length);
    for (const init of inits) {
      expect(init && "redirect" in init, "no redirect option may appear in Personal's request").toBe(false);
    }
  });

  it("still follows a cross-origin redirect, and the Messages wire's x-api-key goes along (the exposure this fix closes on the server)", async () => {
    delete process.env[SERVER_FLAG];
    const pair = await redirectingPair(307);
    try {
      await run({ openai: KEY, openaiBaseUrl: `${pair.origin}/v1` }, "claude-sonnet-5-5");
      expect(pair.target.length).toBeGreaterThanOrEqual(1);
      expect(pair.target[0]?.headers["x-api-key"]).toBe(KEY);
      // Node's own rule, for the record: the bearer header does not survive a cross-origin redirect.
      expect(pair.target[0]?.headers.authorization).toBeUndefined();
    } finally {
      await pair.close();
    }
  });
});

/**
 * Runs the model against a stub that records each request and then ends the run. The direct Anthropic
 * path waits several seconds for usage after a refusal (it did before this change), and nothing here
 * is about that, so the caller "leaves" after the first request.
 */
async function recordFirstRequest(keys: Keys, model: string): Promise<{ url: string; init: RequestInit | undefined }[]> {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const leave = new AbortController();
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    leave.abort(new Error("test: first request recorded"));
    return refused();
  });
  await run(keys, model, "en", leave.signal);
  return seen;
}

/** The URL each direct provider path posts to, whatever base URL its caller handed in. */
async function directUrls(keys: Keys, model: string): Promise<string[]> {
  return (await recordFirstRequest(keys, model)).map((request) => request.url);
}

describe("a provider's host comes from the registry on the hosted server", () => {
  const HOSTILE = "https://evil.example";

  it("Anthropic direct path ignores the base URL its caller resolved", async () => {
    process.env[SERVER_FLAG] = "1";
    const urls = await directUrls(
      { openai: "sk-gw", anthropic: "sk-ant-test", anthropicBaseUrl: `${HOSTILE}/v1`, openaiBaseUrl: "https://gateway.test/v1" },
      "claude-haiku-4-5",
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("https://api.anthropic.com/v1/"), url).toBe(true);
    }
  });

  it("Google direct path ignores the base URL its caller resolved", async () => {
    process.env[SERVER_FLAG] = "1";
    // `gemma-3-27b` is a Google-provider id on the Completions wire, which is what sends a run down the direct path.
    const urls = await directUrls(
      { openai: "sk-gw", google: "AIza-test", googleBaseUrl: `${HOSTILE}/v1beta`, openaiBaseUrl: "https://gateway.test/v1" },
      "gemma-3-27b",
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("https://generativelanguage.googleapis.com/v1beta/"), url).toBe(true);
    }
  });

  it("Volcengine direct path ignores the base URL its caller resolved", async () => {
    process.env[SERVER_FLAG] = "1";
    const urls = await directUrls(
      { volcengine: "ark-test", volcengineBaseUrl: `${HOSTILE}/api/v3`, openaiBaseUrl: "https://gateway.test/v1" },
      "doubao-seed-2-1-turbo-260628",
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("https://ark.cn-beijing.volces.com/api/v3/"), url).toBe(true);
    }
  });

  it("the direct paths do not follow a redirect either", async () => {
    process.env[SERVER_FLAG] = "1";
    const seen = [
      ...(await recordFirstRequest(
        { openai: "sk-gw", anthropic: "sk-ant-test", openaiBaseUrl: "https://gateway.test/v1" },
        "claude-haiku-4-5",
      )),
      ...(await recordFirstRequest(
        { openai: "sk-gw", google: "AIza-test", openaiBaseUrl: "https://gateway.test/v1" },
        "gemma-3-27b",
      )),
      ...(await recordFirstRequest(
        { volcengine: "ark-test", openaiBaseUrl: "https://gateway.test/v1" },
        "doubao-seed-2-1-turbo-260628",
      )),
    ];
    expect(seen.length).toBe(3);
    expect(seen.map((request) => new URL(request.url).hostname)).toEqual([
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
      "ark.cn-beijing.volces.com",
    ]);
    for (const request of seen) {
      expect(request.init?.redirect).toBe("manual");
    }
  });

  it("Personal parity: off the hosted server the caller's base URL is used as before", async () => {
    delete process.env[SERVER_FLAG];
    const anthropic = await directUrls(
      { openai: "sk-gw", anthropic: "sk-ant-test", anthropicBaseUrl: `${HOSTILE}/v1`, openaiBaseUrl: "https://gateway.test/v1" },
      "claude-haiku-4-5",
    );
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.every((url) => url.startsWith(`${HOSTILE}/v1/`))).toBe(true);
    const google = await directUrls(
      { openai: "sk-gw", google: "AIza-test", googleBaseUrl: `${HOSTILE}/v1beta`, openaiBaseUrl: "https://gateway.test/v1" },
      "gemma-3-27b",
    );
    expect(google.length).toBeGreaterThan(0);
    expect(google.every((url) => url.startsWith(`${HOSTILE}/v1beta/`))).toBe(true);
    const ark = await directUrls(
      { volcengine: "ark-test", volcengineBaseUrl: `${HOSTILE}/api/v3`, openaiBaseUrl: "https://gateway.test/v1" },
      "doubao-seed-2-1-turbo-260628",
    );
    expect(ark.length).toBeGreaterThan(0);
    expect(ark.every((url) => url.startsWith(`${HOSTILE}/api/v3/`))).toBe(true);
  });
});
