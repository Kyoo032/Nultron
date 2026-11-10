/**
 * What the relay is given. Tests replace the whole bundle. Production resolves the gateway on the
 * host and, until the HTTP talker lands, has no model to open.
 */
import type { TenantContext } from "@agentforge/core";
import { askNultron, type AskInput, type AskResult } from "./ask";
import { type VoiceClock, systemClock } from "./clock";
import type { Talker, Transcriber } from "./talker";

export type VoiceModels = { readonly talker: Talker; readonly transcriber: Transcriber };

/**
 * SEAM for the integration worker. `talker-omni-http.ts` and `transcriber-gateway.ts` are not in
 * this tree, so this returns null and H1 answers 503. Replace the body with:
 *
 *   const baseUrl = resolvedGatewayBaseUrl();
 *   const apiKey = resolveProviderKeys(loadSettings(tenant)).openaiApiKey;
 *   if (!apiKey) return null;
 *   return {
 *     talker: createOmniHttpTalker({ baseUrl, apiKey, model, voice: VOICE_DEFAULT_VOICE }),
 *     transcriber: createGatewayTranscriber({ baseUrl, apiKey }),
 *   };
 *
 * The key is read here, on the host, and is never sent to the browser or written to a log.
 */
export function createVoiceModels(_tenant: TenantContext, _model: string): VoiceModels | null {
  return null;
}

export type VoiceWiring = {
  /** One pair per session. Null until the integration seam is filled, which is H1's 503. */
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

/** Tests only. Pass null to restore the production bundle, which has no talker. */
export function setVoiceWiringForTests(next: Partial<VoiceWiring> | null): void {
  current = next ? { ...defaultWiring(), ...next } : defaultWiring();
}
