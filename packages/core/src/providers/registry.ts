/**
 * The providers an Enterprise tenant may bring a key for, and the one place that says where each
 * key may be sent (Enterprise "bring your own key", Phase A; owner decision 2026-10-01).
 *
 * Modelled on `gateway/pinned.ts`, and held to the same rules:
 *
 * - **A base URL is a literal in this file.** It is never a setting, never an environment variable
 *   and never part of a request. A caller names a provider id; this table names the host. That is
 *   what keeps a tenant's key from being posted to a host the tenant (or whoever wrote the
 *   request) chose.
 * - **HTTPS only**, with no credentials, query or trailing slash in any literal (`registry.test.ts`).
 * - **Integrity-checked.** The literals are digested into `PROVIDER_REGISTRY_SHA256`, and
 *   `registry-integrity.ts` (Node and tests only: the renderer must not load `node:crypto`)
 *   recomputes it, so a patched build that swapped one host fails loudly instead of quietly shipping
 *   a key somewhere else.
 * - **Frozen all the way down**, so no later line can widen it at runtime.
 *
 * Toko Token is the exception that proves the rule: its URL is the gateway pin and nothing else,
 * resolved at call time through `resolvedGatewayBaseUrl()`, so the brand-gateway and dev-hook rules
 * of `gateway/pinned.ts` keep applying to it and to nothing else here.
 *
 * `availableProviders()` is the Personal/Enterprise line: off the hosted server the only provider is
 * Toko Token, which is what keeps the desktop and webdev pinned to the gateway (SR-85).
 */
import { resolvedGatewayBaseUrl } from "../gateway";
import { isServerMode, type EnvLike } from "../server-mode";

export const PROVIDER_IDS = Object.freeze(["toko", "openai", "anthropic", "google", "openrouter"] as const);

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How the key travels: a bearer token, or a provider's own header. */
export type ProviderAuth = "bearer" | "x-api-key" | "x-goog-api-key";

/** The request shape the provider's chat endpoint speaks. */
export type ProviderWire = "chat_completions" | "anthropic_messages" | "google_generate_content";

export type ProviderEntry = Readonly<{
  id: ProviderId;
  label: string;
  auth: ProviderAuth;
  wire: ProviderWire;
}>;

function entry(value: ProviderEntry): ProviderEntry {
  return Object.freeze({ ...value });
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderEntry>> = Object.freeze({
  toko: entry({ id: "toko", label: "Toko Token", auth: "bearer", wire: "chat_completions" }),
  openai: entry({ id: "openai", label: "OpenAI", auth: "bearer", wire: "chat_completions" }),
  anthropic: entry({ id: "anthropic", label: "Anthropic", auth: "x-api-key", wire: "anthropic_messages" }),
  google: entry({ id: "google", label: "Google", auth: "x-goog-api-key", wire: "google_generate_content" }),
  openrouter: entry({ id: "openrouter", label: "OpenRouter", auth: "bearer", wire: "chat_completions" }),
});

/** The providers whose host is a literal here. Toko Token's is the gateway pin, not listed. */
export type StaticProviderId = Exclude<ProviderId, "toko">;

export type ProviderEndpoints = Readonly<{
  /** The chat (and model list) endpoint. */
  base: string;
  /** Where image, video and audio calls go when they are not on `base`. Google's OpenAI-compatible route. */
  media?: string;
}>;

export const PROVIDER_ENDPOINTS: Readonly<Record<StaticProviderId, ProviderEndpoints>> = Object.freeze({
  openai: Object.freeze({ base: "https://api.openai.com/v1" }),
  anthropic: Object.freeze({ base: "https://api.anthropic.com/v1" }),
  google: Object.freeze({
    base: "https://generativelanguage.googleapis.com/v1beta",
    media: "https://generativelanguage.googleapis.com/v1beta/openai",
  }),
  openrouter: Object.freeze({ base: "https://openrouter.ai/api/v1" }),
});

/**
 * SHA-256 (hex) of `canonicalRegistryText(PROVIDER_ENDPOINTS)`. `registry.test.ts` recomputes it
 * from the literals above, and `assertProviderRegistryIntegrity()` can at boot. Nothing calls it there
 * yet, exactly like its sibling `assertPinnedGatewayIntegrity`: wiring both into the hosted start-up is
 * one line each, and an owner call.
 */
export const PROVIDER_REGISTRY_SHA256 = "51cf2414c574be44ad5ee26ef20815f0d84d4d67cb02d5427708b9c626ab33f9";

/**
 * The text the digest covers: one `id.field=url` line per literal, sorted, joined by `\n`. Pure, so
 * the renderer-safe half of the check lives here and only the hashing lives in `registry-integrity.ts`.
 */
export function canonicalRegistryText(endpoints: Readonly<Record<string, ProviderEndpoints>>): string {
  const lines: string[] = [];
  for (const [id, value] of Object.entries(endpoints)) {
    for (const [field, url] of Object.entries(value)) {
      if (typeof url === "string") {
        lines.push(`${id}.${field}=${url}`);
      }
    }
  }
  return lines.sort().join("\n");
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerEntry(id: ProviderId): ProviderEntry {
  return PROVIDERS[id];
}

/** The base URL a provider's chat and model-list calls go to. Never read from a setting or the environment. */
export function providerBaseUrl(id: ProviderId): string {
  if (id === "toko") {
    return resolvedGatewayBaseUrl();
  }
  return PROVIDER_ENDPOINTS[id].base;
}

/** Where a provider's image, video and audio calls go when that is not `providerBaseUrl`, else null. */
export function providerMediaBaseUrl(id: ProviderId): string | null {
  if (id === "toko") {
    return null;
  }
  return PROVIDER_ENDPOINTS[id].media ?? null;
}

const ONLY_TOKO: readonly ProviderId[] = Object.freeze(["toko"] as const);

/**
 * The providers this process offers. Toko Token only, unless this is the hosted server: the desktop
 * and webdev stay pinned to the gateway. Read per call, like `isServerMode()`, because the suites
 * and `apps/web` set the flag after the module graph is loaded.
 */
export function availableProviders(env: EnvLike = process.env): readonly ProviderId[] {
  return isServerMode(env) ? PROVIDER_IDS : ONLY_TOKO;
}

function hostOf(url: string | undefined | null): string | null {
  const trimmed = url?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether `url` points at exactly this provider's host. A comparison of parsed hosts, not a search
 * for the provider's name inside the string, so `api.openai.com.evil.example`, a path or query that
 * mentions it and a lookalike before an `@` (`api.openai.com@evil.example`) all fail.
 *
 * It is a **classification, not an authorisation**: the scheme and any userinfo are not looked at, so
 * `http://api.openai.com` and `https://u:p@api.openai.com` match. What a key may be sent to is only ever
 * a literal of this registry (`providerBaseUrl`); use this to ask "is this value OpenAI's?", never to
 * decide that a caller-supplied URL may receive one.
 */
export function urlIsProviderHost(id: ProviderId, url: string | undefined | null): boolean {
  const actual = hostOf(url);
  return actual !== null && actual === hostOf(providerBaseUrl(id));
}
