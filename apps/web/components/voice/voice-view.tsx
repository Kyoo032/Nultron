"use client";

import { useEffect, useId, useRef } from "react";
import type { VoiceMode } from "@agentforge/core/voice";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { useBuddyClaim } from "@/lib/use-buddy-claim";
import { t } from "@/lib/i18n";
import { useProductBrand } from "@/lib/product-brand";
import { voiceErrorKey } from "@/lib/voice-errors";
import {
  VOICE_BUDDY_PRIORITY,
  voiceCanRetry,
  voiceMascot,
  voiceNotice,
  voiceRunning,
  type VoiceNotice,
  type VoiceViewState,
} from "@/lib/voice-view-state";
import { VoiceCaptions } from "./voice-captions";
import { VoiceHoldButton } from "./voice-hold-button";
import "./voice-view.css";

export type VoiceViewProps = {
  view: VoiceViewState;
  /** The agent's name on screen (the shell knows it). The catalog's `view.assistant` stands in. */
  assistantName?: string;
  /** End voice and close the view. */
  onEnd: () => void;
  /** Talk again on the same thread. */
  onReconnect: () => void;
  onMode: (mode: VoiceMode) => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  /** The card's one tap. */
  onRunCard: () => void;
};

/** The line that says why the view is not live, and whether asking again can help. */
function noticeLine(notice: VoiceNotice, gatewayName: string): { text: string; canRetry: boolean } {
  switch (notice.kind) {
    case "error":
      return { text: t(voiceErrorKey(notice.code), { gatewayName }), canRetry: voiceCanRetry(notice.code) };
    case "backgrounded":
      return { text: t("voice.phone.backgrounded"), canRetry: true };
    case "ended":
      return { text: t(`voice.ended.${notice.reason}`), canRetry: notice.reason !== "user" };
  }
}

/**
 * The voice view, over the chat's thread: the character and what it is doing in a word, the words as
 * they are said, the way to switch between hands-free and push-to-talk, the big hold button when it is
 * push-to-talk, the one card when the agent wants a go-ahead, and the end button.
 *
 * It decides nothing. Everything it draws comes from `view` (the reducer's value), and every press is
 * handed up. While it is open it claims the desk buddy, ahead of the chat's own claim, so the one
 * character on screen shows what the voice is doing.
 */
export function VoiceView({
  view,
  assistantName,
  onEnd,
  onReconnect,
  onMode,
  onHoldStart,
  onHoldEnd,
  onRunCard,
}: VoiceViewProps) {
  const { gatewayName } = useProductBrand();
  const titleId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const running = voiceRunning(view);
  const mascot = voiceMascot(view.phase, view.state);
  const notice = voiceNotice(view);
  const line = notice ? noticeLine(notice, gatewayName) : null;
  const stateWord = t(`voice.state.${view.state}`);

  useBuddyClaim(running ? { state: mascot.state, busy: mascot.busy, priority: VOICE_BUDDY_PRIORITY } : null);

  // The view takes focus when it opens, so a keyboard user lands in it and Escape works from there.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <section
      ref={rootRef}
      className="voice-view"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="voice-view"
      data-phase={view.phase}
      data-state={view.state}
      data-mode={view.mode}
    >
      <div className="voice-panel">
        <header className="voice-head">
          <h2 id={titleId} className="voice-title">
            {t("voice.view.title")}
          </h2>
          <button
            type="button"
            className="voice-close"
            aria-label={t("voice.view.close")}
            title={t("voice.view.close")}
            data-testid="voice-close"
            onClick={onEnd}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="voice-stage">
          <NultronMascot state={mascot.state} busy={mascot.busy} size={96} decorative />
          {running ? (
            <>
              <p className="voice-state" data-testid="voice-state" aria-hidden="true">
                {stateWord}
              </p>
              {/* The one place a state change is announced; the word above is for the eye. */}
              <p className="sr-only" role="status" aria-live="polite" data-testid="voice-live">
                {t("voice.a11y.stateLive", { state: stateWord })}
              </p>
            </>
          ) : null}
        </div>

        {line ? (
          <div className="voice-notice" role="alert" data-testid="voice-notice" data-kind={notice?.kind}>
            <p>{line.text}</p>
            {line.canRetry ? (
              <button type="button" className="btn btn-primary" data-testid="voice-reconnect" onClick={onReconnect}>
                {t("voice.reconnect.button")}
              </button>
            ) : null}
          </div>
        ) : null}

        <VoiceCaptions captions={view.captions} assistantName={assistantName} showEmptyHint={running && !line} />

        {running && view.state === "speaking" ? (
          <p className="voice-hint" data-testid="voice-hint">
            {t("voice.hint.bargeIn")}
          </p>
        ) : null}

        {view.card ? (
          <div className="voice-card" data-testid="voice-card" data-started={view.card.started ? "true" : "false"}>
            <p className="voice-card-label">{t("voice.card.label")}</p>
            <p className="voice-card-summary">{view.card.summary}</p>
            {view.card.started ? (
              <p className="voice-card-started" role="status">
                {t("voice.card.started")}
              </p>
            ) : (
              <button type="button" className="btn btn-primary" data-testid="voice-card-run" onClick={onRunCard}>
                {t("voice.card.run")}
              </button>
            )}
          </div>
        ) : null}

        {running ? (
          <div className="voice-controls">
            <div className="voice-modes" role="group" aria-label={t("voice.mode.switchLabel")}>
              <button
                type="button"
                className="voice-mode"
                aria-pressed={view.mode === "hands_free"}
                data-testid="voice-mode-hands-free"
                onClick={() => onMode("hands_free")}
              >
                {t("voice.mode.handsFree")}
              </button>
              <button
                type="button"
                className="voice-mode"
                aria-pressed={view.mode === "push_to_talk"}
                data-testid="voice-mode-push-to-talk"
                onClick={() => onMode("push_to_talk")}
              >
                {t("voice.mode.pushToTalk")}
              </button>
            </div>
            {view.mode === "push_to_talk" ? (
              <VoiceHoldButton disabled={view.phase !== "live"} onStart={onHoldStart} onEnd={onHoldEnd} />
            ) : null}
            <button type="button" className="voice-end" data-testid="voice-end" onClick={onEnd}>
              {t("voice.view.end")}
            </button>
          </div>
        ) : null}

        <p className="voice-saved" data-testid="voice-saved">
          {t("voice.view.savedNote")}
        </p>
      </div>
    </section>
  );
}
