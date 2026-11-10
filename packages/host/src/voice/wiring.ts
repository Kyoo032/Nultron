/**
 * What the relay is given. Tests replace the whole bundle. Production resolves the gateway and the
 * tenant's key on the host and opens the HTTP talker and the gateway transcriber with them.
 */
import {
  hasLiveProvider,
  resolveProviderKeys,
  resolveRuntimeMode,
  resolvedGatewayBaseUrl,
  type TenantContext,
} from "@agentforge/core";
import { loadSettings } from "../settings-store";
import { askNultron, type AskInput, type AskResult } from "./ask";
import { type VoiceClock, systemClock } from "./clock";
import { VOICE_DEFAULT_VOICE } from "./flag";
import type { Talker, Transcriber } from "./talker";
import { createOmniHttpTalker } from "./talker-omni-http";
import { createGatewayTranscriber } from "./transcriber-gateway";

export type VoiceModels = { readonly talker: Talker; readonly transcriber: Transcriber };

/**
 * The talker and the transcriber for this tenant, or null when this tenant has no gateway key to
 * speak with (H1 answers 503).
 *
 * The key is the one a Chat turn would use: `createRuntime` hands `resolveProviderKeys(loadSettings(
 * tenant))` to the model runtime, so voice reads the same call. Personal: the pinned gateway, the
 * key saved on this desk (or `OPENAI_API_KEY` on a desk that asked for the live runtime). Hosted
 * server: the tenant's own key only, because `providerEnv` is empty in server mode, and it is the key
 * the gate (`requireGatewayAllowedFor`, which H1 and the upgrade both ran) approved. A desk on the
 * stub runtime has no live Chat, so it has no live voice either; a stray environment key does not
 * open one.
 *
 * The key is read here, on the host, and goes only into the two `Authorization` headers the talker
 * and the transcriber build. It is never sent to the browser, put in a frame or written to a log.
 */
export function createVoiceModels(tenant: TenantContext, model: string): VoiceModels | null {
  const settings = loadSettings(tenant);
  const live =
    resolveRuntimeMode({
      settingsHasKey: hasLiveProvider(settings),
      envRuntime: process.env.AGENTFORGE_RUNTIME,
    }) === "ai";
  if (!live) return null;
  const apiKey = resolveProviderKeys(settings).openai?.trim();
  if (!apiKey) return null;
  const baseUrl = resolvedGatewayBaseUrl();
  return {
    talker: createOmniHttpTalker({ baseUrl, apiKey, model, voice: VOICE_DEFAULT_VOICE }),
    transcriber: createGatewayTranscriber({ baseUrl, apiKey }),
  };
}

export type VoiceWiring = {
  /** One pair per session. Null when the tenant has no key to speak with, which is H1's 503. */
  modelsFor(tenant: TenantContext, model: string): VoiceModels | null;
  ask(input: AskInput): Promise<AskResult>;
  clock: VoiceClock;
};

function defaultWiring(): VoiceWiring {
  return {
    modelsFor: (tenant, model) => createVoiceModels(tenant, model),
    ask: (input) => askNultron(input),
    clock: systemClock(),
  };
}

let current: VoiceWiring = defaultWiring();

export function voiceWiring(): VoiceWiring {
  return current;
}

/** Tests only. Pass null to restore the production bundle. */
export function setVoiceWiringForTests(next: Partial<VoiceWiring> | null): void {
  current = next ? { ...defaultWiring(), ...next } : defaultWiring();
}
