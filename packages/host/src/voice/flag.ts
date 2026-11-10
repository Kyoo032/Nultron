import { isServerMode, type TenantContext } from "@agentforge/core";
import type { VoiceSettings } from "@agentforge/core/voice";

/**
 * Who may use live voice (plan week one: Rizky only), so voice is off unless the host is told otherwise.
 *
 * - `AGENTFORGE_VOICE`: `on`, `1` or `true` turns it on (the same reading as `AGENTFORGE_CODE_RUNS`). Unset,
 *   blank or anything else is off, so a typo never opens it.
 * - `AGENTFORGE_VOICE_OWNERS`: server mode only. Comma-separated `userId`s allowed to use it. The tenant
 *   carries a user id and no e-mail (`TenantContext`), so the id is the stable identifier. Empty or unset
 *   means nobody.
 * - `AGENTFORGE_VOICE_MODEL`: the talker model, instead of `VOICE_DEFAULT_MODEL`.
 *
 * Off server mode (Personal, webdev) the flag alone is enough: the one person at the keyboard is the owner.
 */
export const VOICE_DEFAULT_MODEL = "qwen3.5-omni-flash";
export const VOICE_DEFAULT_VOICE = "Tina";

export const VOICE_FLAG_ENV = "AGENTFORGE_VOICE";
export const VOICE_OWNERS_ENV = "AGENTFORGE_VOICE_OWNERS";
export const VOICE_MODEL_ENV = "AGENTFORGE_VOICE_MODEL";

const ON = new Set(["on", "1", "true"]);

/** Whether this person may use voice on this host, and with which model. */
export function voiceSettingsFor(
  tenant: TenantContext,
  env: NodeJS.ProcessEnv = process.env,
  serverMode: boolean = isServerMode(env),
): VoiceSettings {
  if (!ON.has(env[VOICE_FLAG_ENV]?.trim().toLowerCase() ?? "")) {
    return { enabled: false, model: null };
  }
  if (serverMode && !isListedOwner(tenant.userId, env[VOICE_OWNERS_ENV])) {
    return { enabled: false, model: null };
  }
  return { enabled: true, model: env[VOICE_MODEL_ENV]?.trim() || VOICE_DEFAULT_MODEL };
}

function isListedOwner(userId: string, list: string | undefined): boolean {
  const wanted = userId.trim().toLowerCase();
  if (!wanted || !list) {
    return false;
  }
  return list.split(",").some((entry) => entry.trim().toLowerCase() === wanted);
}
