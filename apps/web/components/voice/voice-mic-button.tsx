"use client";

import { useId } from "react";
import { t } from "@/lib/i18n";

/** What the chat hands its composer so it can draw the mic. Absent, or not `available`, the composer draws none. */
export type ComposerVoice = {
  /** The host has voice on (`voice.enabled`). Off, no button. */
  readonly available: boolean;
  /** The voice view is open: the same button ends voice. */
  readonly active: boolean;
  /** A Chat reply is streaming. */
  readonly disabled: boolean;
  readonly onToggle: () => void;
};

export type VoiceMicButtonProps = {
  voice?: ComposerVoice;
  /** The composer is sending a message. */
  busy?: boolean;
};

/**
 * The mic in the composer's row, between the message box and Send. Nothing at all unless the host has
 * voice on. It is `aria-disabled`, not `disabled`, while a reply is streaming: it stays reachable with
 * the keyboard, so the reason for it (`voice.mic.disabledHint`) can be read, and a click does nothing.
 * While voice is open it is the way to end it, and a streaming reply does not block that.
 */
export function VoiceMicButton({ voice, busy = false }: VoiceMicButtonProps) {
  const hintId = useId();
  if (!voice?.available) {
    return null;
  }
  const { active, onToggle } = voice;
  const blocked = (voice.disabled || busy) && !active;
  const label = active ? t("voice.mic.stop") : t("voice.mic.start");
  return (
    <>
      <button
        type="button"
        className={`composer-mic${active ? " composer-mic-active" : ""}`}
        aria-pressed={active}
        aria-disabled={blocked ? "true" : undefined}
        aria-describedby={blocked ? hintId : undefined}
        aria-label={label}
        title={blocked ? t("voice.mic.disabledHint") : label}
        data-testid="composer-mic"
        onClick={() => {
          if (!blocked) {
            onToggle();
          }
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {active ? (
            <rect x="6" y="6" width="12" height="12" rx="2" />
          ) : (
            <>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </>
          )}
        </svg>
      </button>
      {blocked ? (
        <span id={hintId} className="sr-only">
          {t("voice.mic.disabledHint")}
        </span>
      ) : null}
    </>
  );
}
