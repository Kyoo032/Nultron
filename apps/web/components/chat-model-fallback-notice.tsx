"use client";

import { t } from "@/lib/i18n";

/**
 * A stand-in model that answered a turn: the one the person picked could not be reached, so the host answered
 * with the next live model (`run.model_fallback`, `packages/host/src/runs.ts`, `announceFallback`).
 */
export type ModelFallbackNotice = {
  readonly from: string;
  readonly to: string;
  /** The host's own sentence. Used only when the frame names no models. */
  readonly message: string;
};

/**
 * The notice to hold after another stand-in event in the same turn. The host can move twice in one turn (a model
 * skipped before the first try, then a retry mid-turn), so the line keeps the model the person picked, the `from`
 * of the first event, and names the model that answered last, with that event's sentence.
 */
export function nextModelFallback(held: ModelFallbackNotice | null, event: ModelFallbackNotice): ModelFallbackNotice {
  return held ? { from: held.from, to: event.to, message: event.message } : event;
}

/**
 * The line under the reply that says which model wrote it. Quiet, like the Finance notice: it states a fact
 * about the run and does not ask anything of the person. Hook-free, so the markup can be read in tests.
 */
export function ChatModelFallbackNotice({ notice }: { notice: ModelFallbackNotice }) {
  const text =
    notice.from && notice.to ? t("chat.harness.modelFallback", { from: notice.from, to: notice.to }) : notice.message;
  if (!text) {
    return null;
  }
  return (
    <p className="px-1 text-xs text-[var(--text-3)]" data-testid="chat-model-fallback" role="status">
      {text}
    </p>
  );
}
