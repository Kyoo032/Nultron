"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
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
import { useVoiceBridge } from "./use-voice-session";
import { VoiceCaptions } from "./voice-captions";
import { VoiceHoldButton } from "./voice-hold-button";
import "./voice-view.css";

export type VoiceViewProps = {
  view: VoiceViewState;
  /** The agent's name on screen (the shell knows it). The catalog's `view.assistant` stands in. */
  assistantName?: string;
  /** Smoothed 20 ms microphone RMS level (0..1). Optional; falls back to the active session bridge. */
  micLevel?: number;
  /** True when outgoing mic audio is muted locally. Optional; falls back to the active session bridge. */
  muted?: boolean;
  /** End voice and close the view. */
  onEnd: () => void;
  /** Talk again on the same thread. */
  onReconnect: () => void;
  onMode: (mode: VoiceMode) => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onToggleMute?: () => void;
  onInterrupt?: () => void;
  onCommit?: () => void;
  onDismissCard?: () => void;
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
  micLevel: micLevelProp,
  muted: mutedProp,
  onEnd,
  onReconnect,
  onMode,
  onHoldStart,
  onHoldEnd,
  onToggleMute,
  onInterrupt,
  onCommit,
  onDismissCard,
  onRunCard,
}: VoiceViewProps) {
  const { gatewayName } = useProductBrand();
  const titleId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const bridge = useVoiceBridge();
  const running = voiceRunning(view);
  const mascot = voiceMascot(view.phase, view.state);
  const notice = voiceNotice(view);
  const line = notice ? noticeLine(notice, gatewayName) : null;
  const muted = mutedProp ?? (bridge.active ? bridge.muted : view.muted);
  const level = muted ? 0 : Math.max(0, Math.min(1, micLevelProp ?? (bridge.active ? bridge.micLevel : 0)));
  const stateWord = muted && running ? t("voice.state.muted") : t(`voice.state.${view.state}`);

  const handleToggleMute = onToggleMute ?? bridge.toggleMute ?? undefined;
  const handleInterrupt = onInterrupt ?? bridge.interrupt ?? undefined;
  const handleCommit = onCommit ?? bridge.commit ?? undefined;
  const handleDismissCard = onDismissCard ?? bridge.dismissCard ?? undefined;

  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);
  const holdRef = useRef({ onHoldStart, onHoldEnd });
  holdRef.current = { onHoldStart, onHoldEnd };

  useBuddyClaim(running ? { state: mascot.state, busy: mascot.busy, priority: VOICE_BUDDY_PRIORITY } : null);

  // The view takes focus when it opens, so a keyboard user lands in it and Escape works from there.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Desktop Spacebar push-to-talk shortcut when live in push-to-talk mode.
  useEffect(() => {
    const pttLive = running && view.phase === "live" && view.mode === "push_to_talk";
    if (!pttLive) {
      if (spaceHeldRef.current) {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
        holdRef.current.onHoldEnd();
      }
      return;
    }
    const isInteractiveTarget = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      Boolean(target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="switch"]'));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      if (!spaceHeldRef.current) {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        holdRef.current.onHoldStart();
      }
    };
    const releaseSpace = () => {
      if (!spaceHeldRef.current) return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      holdRef.current.onHoldEnd();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== " " || !spaceHeldRef.current) return;
      event.preventDefault();
      releaseSpace();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
      releaseSpace();
    };
  }, [running, view.phase, view.mode]);

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
      data-muted={muted ? "true" : "false"}
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
          <div
            className="voice-visualizer"
            data-testid="voice-visualizer"
            data-running={running ? "true" : "false"}
            data-state={view.state}
            data-busy={running && (view.state === "thinking" || view.state === "speaking") ? "true" : undefined}
            data-muted={muted ? "true" : "false"}
            style={{ "--voice-level": String(level) } as CSSProperties}
          >
            <span className="voice-ring" aria-hidden="true" />
            <NultronMascot state={mascot.state} busy={mascot.busy} size={96} decorative />
          </div>
          {running ? (
            <>
              <div
                className="voice-bars"
                aria-hidden="true"
                data-testid="voice-bars"
                data-muted={muted ? "true" : "false"}
                style={{ "--voice-level": String(level) } as CSSProperties}
              >
                <span className="voice-bar voice-bar-1" />
                <span className="voice-bar voice-bar-2" />
                <span className="voice-bar voice-bar-3" />
                <span className="voice-bar voice-bar-4" />
                <span className="voice-bar voice-bar-5" />
              </div>
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
        ) : running && view.mode === "push_to_talk" ? (
          <p className="voice-hint" data-testid="voice-ptt-hint">
            {t("voice.hint.spaceHold")}
          </p>
        ) : null}

        {view.card ? (
          <div className="voice-card" data-testid="voice-card" data-started={view.card.started ? "true" : "false"}>
            <p className="voice-card-label">{t("voice.card.label")}</p>
            <p className="voice-card-summary">{view.card.summary}</p>
            <div className="voice-card-actions">
              {view.card.started ? (
                <p className="voice-card-started" role="status">
                  {t("voice.card.started")}
                </p>
              ) : (
                <button type="button" className="btn btn-primary" data-testid="voice-card-run" onClick={onRunCard}>
                  {t("voice.card.run")}
                </button>
              )}
              <button
                type="button"
                className="voice-card-dismiss"
                data-testid="voice-card-dismiss"
                onClick={handleDismissCard}
              >
                {t("voice.card.dismiss")}
              </button>
            </div>
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
            <button
              type="button"
              className="voice-mute"
              aria-pressed={muted}
              data-testid="voice-mute"
              data-muted={muted ? "true" : "false"}
              onClick={handleToggleMute}
            >
              {muted ? t("voice.controls.unmute") : t("voice.controls.mute")}
            </button>
            {view.mode === "hands_free" && view.state === "hearing" ? (
              <button
                type="button"
                className="voice-commit btn btn-primary"
                data-testid="voice-commit"
                onClick={handleCommit}
              >
                {t("voice.controls.done")}
              </button>
            ) : null}
            {view.state === "speaking" ? (
              <button
                type="button"
                className="voice-interrupt"
                data-testid="voice-interrupt"
                onClick={handleInterrupt}
              >
                {t("voice.controls.stop")}
              </button>
            ) : null}
            {view.mode === "push_to_talk" ? (
              <VoiceHoldButton
                disabled={view.phase !== "live"}
                externalHeld={spaceHeld}
                onStart={onHoldStart}
                onEnd={onHoldEnd}
              />
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
