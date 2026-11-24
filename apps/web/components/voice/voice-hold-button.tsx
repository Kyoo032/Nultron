"use client";

import { useRef, useState } from "react";
import { t } from "@/lib/i18n";

export type VoiceHoldButtonProps = {
  disabled: boolean;
  /** True while held via an external shortcut such as desktop Spacebar. */
  externalHeld?: boolean;
  onStart: () => void;
  onEnd: () => void;
};

/**
 * The big push-to-talk button: audio goes to the host only while it is held, and releasing it ends
 * the turn. It works by pointer (mouse, touch and pen, with the pointer captured so sliding off the
 * button does not strand the turn) and by keyboard (Space or Enter held down). Anything that takes the
 * press away, a blur or a cancelled pointer, releases it, so a turn is never left open.
 */
export function VoiceHoldButton({ disabled, externalHeld = false, onStart, onEnd }: VoiceHoldButtonProps) {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const active = held || externalHeld;

  function press() {
    if (disabled || heldRef.current) {
      return;
    }
    heldRef.current = true;
    setHeld(true);
    onStart();
  }

  function release() {
    if (!heldRef.current) {
      return;
    }
    heldRef.current = false;
    setHeld(false);
    onEnd();
  }

  return (
    <button
      type="button"
      className="voice-hold"
      disabled={disabled}
      aria-pressed={active}
      data-held={active ? "true" : "false"}
      data-testid="voice-hold"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onBlur={release}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          event.stopPropagation();
          press();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          release();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {active ? t("voice.mode.release") : t("voice.mode.hold")}
    </button>
  );
}
