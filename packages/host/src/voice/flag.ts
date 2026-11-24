import { isServerMode, type TenantContext } from "@agentforge/core";
import type { VoiceSettings } from "@agentforge/core/voice";

/**
 * Who may use live voice.
 *
 * - Voice is ON by default. Set `AGENTFORGE_VOICE=off`, `0` or `false` (case-insensitive) to disable it.
 * - `AGENTFORGE_VOICE_OWNERS`: server mode only. Optional comma-separated `userId`s allowed to use it.
 *   When unset or blank, all authenticated users on desks with a live key are allowed. When explicitly
 *   set, access is restricted to those listed `userId`s.
 * - `AGENTFORGE_VOICE_MODEL`: the talker model, instead of `VOICE_DEFAULT_MODEL`.
 */
export const VOICE_DEFAULT_MODEL = "qwen3.5-omni-flash";
export const VOICE_DEFAULT_VOICE = "Tina";

export const VOICE_FLAG_ENV = "AGENTFORGE_VOICE";
export const VOICE_OWNERS_ENV = "AGENTFORGE_VOICE_OWNERS";
export const VOICE_MODEL_ENV = "AGENTFORGE_VOICE_MODEL";

const OFF = new Set(["off", "0", "false"]);

/** Whether this person may use voice on this host, and with which model. */
export function voiceSettingsFor(
  tenant: TenantContext,
  env: NodeJS.ProcessEnv = process.env,
  serverMode: boolean = isServerMode(env),
): VoiceSettings {
  if (OFF.has(env[VOICE_FLAG_ENV]?.trim().toLowerCase() ?? "")) {
    return { enabled: false, model: null };
  }
  if (serverMode && !isAllowedServerOwner(tenant.userId, env[VOICE_OWNERS_ENV])) {
    return { enabled: false, model: null };
  }
  return { enabled: true, model: env[VOICE_MODEL_ENV]?.trim() || VOICE_DEFAULT_MODEL };
}

function isAllowedServerOwner(userId: string, list: string | undefined): boolean {
  const entries = (list ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return true;
  }
  const wanted = userId.trim().toLowerCase();
  return wanted.length > 0 && entries.includes(wanted);
}
