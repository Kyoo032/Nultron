import { t } from "@/lib/i18n";

/**
 * The sentence an Edit turn leaves on the panel when its model call failed after a tool had already run.
 * The edits the tools made are kept; this says the answer did not come, and why. `reason` is the host's own
 * failure text, already masked on the host; a blank one falls back to the generic agent failure.
 */
export function editInterruptedNote(reason: string): string {
  const text = reason.trim() || t("edit.errors.agentFailed");
  return t("edit.agent.interrupted", { reason: text });
}
