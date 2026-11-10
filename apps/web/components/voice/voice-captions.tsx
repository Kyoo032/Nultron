"use client";

import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { isPinnedToEnd } from "@/lib/stick-to-bottom";
import type { VoiceCaption } from "@/lib/voice-view-state";

export type VoiceCaptionsProps = {
  captions: readonly VoiceCaption[];
  /** The agent's name on screen; the caption label for its lines. */
  assistantName?: string;
  /** Nothing has been said yet and the session is live. */
  showEmptyHint: boolean;
};

/**
 * What was said, as it is said: the person's words and the agent's, labelled. A caption that is still
 * being revised is drawn as it stands and replaced in place by its final one (the list is keyed by the
 * host's id). It follows the newest line unless the reader has scrolled up. Not a live region: the
 * state is announced elsewhere, and a screen reader does not need every partial word read to it.
 */
export function VoiceCaptions({ captions, assistantName, showEmptyHint }: VoiceCaptionsProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new or revised caption is what moves the view, without being read by it
  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [captions]);

  if (captions.length === 0) {
    return showEmptyHint ? (
      <p className="voice-empty" data-testid="voice-captions-empty">
        {t("voice.view.captionsEmpty")}
      </p>
    ) : (
      <div className="voice-captions-spacer" />
    );
  }
  return (
    <ul
      ref={listRef}
      className="voice-captions"
      role="log"
      aria-live="off"
      aria-label={t("voice.view.title")}
      data-testid="voice-captions"
      onScroll={() => {
        const el = listRef.current;
        if (el) {
          pinned.current = isPinnedToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
        }
      }}
    >
      {captions.map((caption) => (
        <li
          key={caption.id}
          className="voice-caption"
          data-role={caption.role}
          data-final={caption.final ? "true" : "false"}
          data-testid={`voice-caption-${caption.role}`}
        >
          <span className="voice-caption-who">
            {caption.role === "user" ? t("voice.view.you") : (assistantName ?? t("voice.view.assistant"))}
          </span>
          <span className="voice-caption-text">{caption.text}</span>
          {caption.interrupted ? <span className="voice-caption-cut">{t("voice.caption.interrupted")}</span> : null}
        </li>
      ))}
    </ul>
  );
}
