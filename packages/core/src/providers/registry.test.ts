import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolvedGatewayBaseUrl } from "../gateway";
import { assertProviderRegistryIntegrity, providerRegistryDigest } from "./registry-integrity";
import {
  GATEWAY_PROVIDER_ID,
  PROVIDER_ENDPOINTS,
  PROVIDER_IDS,
  PROVIDER_REGISTRY_SHA256,
  PROVIDERS,
  availableProviders,
  isProviderId,
  providerBaseUrl,
  providerEntry,
  providerMediaBaseUrl,
  urlIsProviderHost,
} from "./registry";

/**
 * Enterprise BYOK, Phase A: one frozen table says where each provider's key may be sent.
 *
 * Modelled on `gateway/pinned.ts`: the base URLs are literals in code, their digest is a second
 * literal, and a test recomputes the digest from the literals. A request, a setting or an environment
 * variable never names a host; it names a provider id, and this table names the host.
 */

const ENV_KEYS = [
  "AGENTFORGE_SERVER",
  "AGENTFORGE_GATEWAY_URL",
  "AGENTFORGE_PACKAGED",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "NODE_ENV",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

describe("the provider registry", () => {
  const previous = snapshotEnv();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("names exactly the five providers the owner approved", () => {
    expect([...PROVIDER_IDS]).toEqual([GATEWAY_PROVIDER_ID, "openai", "anthropic", "google", "openrouter"]);
    expect(Object.keys(PROVIDERS).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const id of PROVIDER_IDS) {
      expect(providerEntry(id).id).toBe(id);
    }
  });

  it("recognises a provider id and nothing else", () => {
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId(GATEWAY_PROVIDER_ID)).toBe(true);
    expect(isProviderId("volcengine")).toBe(false);
    expect(isProviderId("https://api.openai.com/v1")).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId({ id: "openai" })).toBe(false);
  });

  it("holds each provider's base URL as a literal", () => {
    expect(providerBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(providerBaseUrl("anthropic")).toBe("https://api.anthropic.com/v1");
    expect(providerBaseUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(providerBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
    expect(providerMediaBaseUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(providerMediaBaseUrl("openai")).toBeNull();
    expect(providerMediaBaseUrl(GATEWAY_PROVIDER_ID)).toBeNull();
  });

  it("says how each provider authenticates and which wire it speaks", () => {
    expect(PROVIDERS[GATEWAY_PROVIDER_ID]).toMatchObject({ auth: "bearer", wire: "chat_completions" });
    expect(PROVIDERS.openai).toMatchObject({ auth: "bearer", wire: "chat_completions" });
    expect(PROVIDERS.anthropic).toMatchObject({ auth: "x-api-key", wire: "anthropic_messages" });
    expect(PROVIDERS.google).toMatchObject({ auth: "x-goog-api-key", wire: "google_generate_content" });
    expect(PROVIDERS.openrouter).toMatchObject({ auth: "bearer", wire: "chat_completions" });
  });

  it("resolves the gateway provider through the gateway pin, unchanged", () => {
    expect(providerBaseUrl(GATEWAY_PROVIDER_ID)).toBe(resolvedGatewayBaseUrl());
    expect(providerBaseUrl(GATEWAY_PROVIDER_ID)).toBe("https://api.tokotokenai.com/v1");
  });

  it("follows the gateway pin's own dev hook for the gateway provider, and for no other", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGENTFORGE_PACKAGED;
    process.env.AGENTFORGE_GATEWAY_URL = "https://aihub.example.test/v1";
    expect(providerBaseUrl(GATEWAY_PROVIDER_ID)).toBe("https://aihub.example.test/v1");
    expect(providerBaseUrl("openai")).toBe("https://api.openai.com/v1");
  });

  it("serves only https endpoints with no credentials, query or trailing slash", () => {
    for (const [id, endpoints] of Object.entries(PROVIDER_ENDPOINTS)) {
      for (const [field, value] of Object.entries(endpoints)) {
        const parsed = new URL(value);
        expect(parsed.protocol, `${id}.${field}`).toBe("https:");
        expect(parsed.username, `${id}.${field}`).toBe("");
        expect(parsed.password, `${id}.${field}`).toBe("");
        expect(parsed.search, `${id}.${field}`).toBe("");
        expect(parsed.hash, `${id}.${field}`).toBe("");
        expect(value.endsWith("/"), `${id}.${field}`).toBe(false);
        expect(parsed.toString().replace(/\/$/, ""), `${id}.${field}`).toBe(value);
      }
    }
  });

  it("never reads a base URL from the environment", () => {
    process.env.OPENAI_BASE_URL = "https://evil.example/v1";
    process.env.ANTHROPIC_BASE_URL = "https://evil.example/v1";
    process.env.GOOGLE_GENERATIVE_AI_BASE_URL = "https://evil.example/v1beta";
    expect(providerBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(providerBaseUrl("anthropic")).toBe("https://api.anthropic.com/v1");
    expect(providerBaseUrl("google")).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("is frozen all the way down", () => {
    expect(Object.isFrozen(PROVIDER_IDS)).toBe(true);
    expect(Object.isFrozen(PROVIDERS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_ENDPOINTS)).toBe(true);
    for (const id of PROVIDER_IDS) {
      expect(Object.isFrozen(PROVIDERS[id]), id).toBe(true);
    }
    for (const endpoints of Object.values(PROVIDER_ENDPOINTS)) {
      expect(Object.isFrozen(endpoints)).toBe(true);
    }
    expect(() => {
      (PROVIDER_ENDPOINTS.openai as { base: string }).base = "https://evil.example/v1";
    }).toThrow(TypeError);
    expect(providerBaseUrl("openai")).toBe("https://api.openai.com/v1");
  });
});

describe("the registry's integrity digest", () => {
  it("matches the recomputed SHA-256 of the literals", () => {
    const canonical = [
      "anthropic.base=https://api.anthropic.com/v1",
      "google.base=https://generativelanguage.googleapis.com/v1beta",
      "google.media=https://generativelanguage.googleapis.com/v1beta/openai",
      "openai.base=https://api.openai.com/v1",
      "openrouter.base=https://openrouter.ai/api/v1",
    ].join("\n");
    const recomputed = createHash("sha256").update(canonical, "utf8").digest("hex");
    expect(PROVIDER_REGISTRY_SHA256).toBe(recomputed);
    expect(providerRegistryDigest(PROVIDER_ENDPOINTS)).toBe(recomputed);
  });

  it("passes the boot integrity check", () => {
    expect(() => assertProviderRegistryIntegrity()).not.toThrow();
  });

  it("fails loudly when one host is swapped", () => {
    const tampered = {
      ...PROVIDER_ENDPOINTS,
      anthropic: { base: "https://api.anthropic.com.evil.example/v1" },
    };
    expect(providerRegistryDigest(tampered)).not.toBe(PROVIDER_REGISTRY_SHA256);
    expect(() => assertProviderRegistryIntegrity(tampered)).toThrow(/integrity check failed/);
  });
});

describe("which providers a process offers", () => {
  it("offers only the gateway off the hosted server", () => {
    expect(availableProviders({})).toEqual([GATEWAY_PROVIDER_ID]);
    expect(availableProviders({ AGENTFORGE_SERVER: "0" })).toEqual([GATEWAY_PROVIDER_ID]);
    expect(availableProviders({ AGENTFORGE_SERVER: "" })).toEqual([GATEWAY_PROVIDER_ID]);
  });

  it("offers every provider on the hosted server", () => {
    expect(availableProviders({ AGENTFORGE_SERVER: "1" })).toEqual([...PROVIDER_IDS]);
    expect(availableProviders({ AGENTFORGE_SERVER: "true" })).toEqual([...PROVIDER_IDS]);
  });

  it("reads the process environment by default, per call", () => {
    delete process.env.AGENTFORGE_SERVER;
    expect(availableProviders()).toEqual([GATEWAY_PROVIDER_ID]);
    process.env.AGENTFORGE_SERVER = "1";
    expect(availableProviders()).toEqual([...PROVIDER_IDS]);
    delete process.env.AGENTFORGE_SERVER;
  });

  it("hands back a copy nobody can use to widen the list", () => {
    const offered = availableProviders({}) as string[];
    expect(Object.isFrozen(offered)).toBe(true);
  });
});

describe("matching a URL to a provider's host", () => {
  it("accepts the provider's own host, with or without a path or a scheme", () => {
    expect(urlIsProviderHost("openai", "https://api.openai.com/v1")).toBe(true);
    expect(urlIsProviderHost("openai", "https://api.openai.com")).toBe(true);
    expect(urlIsProviderHost("openai", "https://API.OpenAI.com/v1/")).toBe(true);
    expect(urlIsProviderHost("openai", "api.openai.com/v1")).toBe(true);
    expect(urlIsProviderHost("anthropic", "https://api.anthropic.com/v1")).toBe(true);
  });

  it("refuses a host that merely contains the provider's name", () => {
    expect(urlIsProviderHost("openai", "https://api.openai.com.evil.example/v1")).toBe(false);
    expect(urlIsProviderHost("openai", "https://evil.example/api.openai.com/v1")).toBe(false);
    expect(urlIsProviderHost("openai", "https://evil.example/v1?u=api.openai.com")).toBe(false);
    expect(urlIsProviderHost("openai", "https://notapi.openai.com/v1")).toBe(false);
    expect(urlIsProviderHost("openai", "https://api.openai.com@evil.example/v1")).toBe(false);
    expect(urlIsProviderHost("openai", "https://api.openai.com:8443/v1")).toBe(false);
  });

  it("refuses the wrong provider's host and anything that is not a URL", () => {
    expect(urlIsProviderHost("openai", "https://api.anthropic.com/v1")).toBe(false);
    expect(urlIsProviderHost("openai", "")).toBe(false);
    expect(urlIsProviderHost("openai", undefined)).toBe(false);
    expect(urlIsProviderHost("openai", "not a url at all")).toBe(false);
  });
});
