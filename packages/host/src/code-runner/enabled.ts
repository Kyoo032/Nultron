import { type EnvLike, isServerMode } from "@agentforge/core";
import { CODE_RUNS_ENV } from "./limits";

/**
 * The kill switch for the code sandbox (`AGENTFORGE_CODE_RUNS`).
 *
 * Unset, `run_code` is offered on Personal and webdev and withheld on the hosted server: the sandbox has
 * not been proven inside the Docker image (Node 22, read-only root, noexec /tmp, cap_drop ALL), so the
 * operator turns it on with `AGENTFORGE_CODE_RUNS=on` once it has been driven there.
 *
 * Off means the model is never told the tool exists and the tool refuses if something calls it anyway.
 * This file imports nothing heavy, so the settings store can ask it on every load.
 */

/** The registry key of the tool, as the bindings and the disabled-tools list spell it. */
export const RUN_CODE_TOOL_KEY = "run_code";

const ON = new Set(["on", "1", "true"]);

/**
 * Whether code runs are on. Unset or blank takes the default for the mode; "on", "1" and "true" are on;
 * every other value is off, including a typo, because a kill switch that a misspelling leaves on is not one.
 */
export function codeRunsEnabled(env: EnvLike = process.env): boolean {
  const raw = env[CODE_RUNS_ENV]?.trim().toLowerCase();
  if (!raw) {
    return !isServerMode(env);
  }
  return ON.has(raw);
}

/**
 * The settings a run reads, with `run_code` on the disabled-tools list when code runs are off. The core
 * runtime leaves a disabled tool out of the set it offers the model and refuses it at the guard, so this
 * one overlay covers Chat and every job. A copy: the stored settings are never touched, so turning the
 * switch back on needs nothing but the variable.
 */
export function withCodeRunPolicy<T extends { disabledTools?: string[] }>(settings: T, env: EnvLike = process.env): T {
  if (codeRunsEnabled(env)) {
    return settings;
  }
  const current = settings.disabledTools ?? [];
  if (current.includes(RUN_CODE_TOOL_KEY)) {
    return settings;
  }
  return { ...settings, disabledTools: [...current, RUN_CODE_TOOL_KEY] };
}
