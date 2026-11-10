/**
 * Live voice, whether to offer it: `voice` in `GET /api/v1/settings` (`VoiceSettings`, the contract
 * in `packages/core/src/voice/protocol.ts`). The mic button shows only when `enabled` is true. A host
 * that does not send the field, an older one, means off.
 */

import type { SettingsBody } from "./settings-read";
import { readSettings } from "./settings-read";

/** True only when the host says voice is on. Anything malformed is off. */
export function voiceEnabled(body: SettingsBody | null | undefined): boolean {
  const voice = body?.voice;
  return Boolean(voice && typeof voice === "object" && (voice as { enabled?: unknown }).enabled === true);
}

/** Reads the shared settings answer and says whether voice is offered. A failed read is off. */
export async function readVoiceEnabled(): Promise<boolean> {
  try {
    const answer = await readSettings();
    return answer.ok && voiceEnabled(answer.body);
  } catch {
    return false;
  }
}

const MODE_KEY = "nultron.voice.mode";

/** The last talking mode the person chose, a convenience of this browser and nothing more. */
export function readStoredVoiceMode(): "hands_free" | "push_to_talk" {
  try {
    return globalThis.localStorage?.getItem(MODE_KEY) === "push_to_talk" ? "push_to_talk" : "hands_free";
  } catch {
    return "hands_free";
  }
}

export function writeStoredVoiceMode(mode: "hands_free" | "push_to_talk"): void {
  try {
    globalThis.localStorage?.setItem(MODE_KEY, mode);
  } catch {
    // private window or blocked storage: the choice lasts until the page is closed
  }
}
