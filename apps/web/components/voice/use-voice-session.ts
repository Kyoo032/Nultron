"use client";

/**
 * Live voice in Chat, the React side: one hook that owns a `VoiceClient`, the view's reducer, and the
 * handful of things that tie the voice view to the chat around it.
 *
 * It keeps no audio logic. The client (`@/lib/voice-client`) does the microphone, the socket and the
 * order of a cut-in; the reducer (`@/lib/voice-view-state`) turns what the client reports into the
 * screen; this file only starts, stops and forwards, and cleans up. Stopping always goes through the
 * client, which is what releases the microphone.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { VoiceMode } from "@agentforge/core/voice";
import { browserVoiceDeps } from "@/lib/voice-browser-deps";
import { VoiceClient } from "@/lib/voice-client";
import { readStoredVoiceMode, readVoiceEnabled, writeStoredVoiceMode } from "@/lib/voice-settings";
import {
  initialVoiceViewState,
  voiceRunning,
  voiceShown,
  voiceViewReducer,
  type VoiceViewState,
} from "@/lib/voice-view-state";

/** How long "Started in Chat" stays up after a card is tapped, before the view gets out of the way of the reply. */
export const VOICE_CARD_STARTED_MS = 2_400;

export type UseVoiceSessionOptions = {
  /** The chat's own `ensureThread`: the thread the turns are saved to, made if there is none yet. */
  ensureThread: () => Promise<string>;
  /** Reloads a thread's messages, so the transcript under the view shows what was just said. */
  refresh: (threadId: string) => Promise<unknown>;
  /** Sends text as a normal Chat turn through the composer's own send path. False when it could not. */
  sendPrompt: (text: string) => boolean;
  /** Changes when the owner opens another session; voice does not follow them there. */
  sessionKey: string | number;
  /** A Chat reply is streaming. */
  chatRunning: boolean;
};

export type VoiceSession = {
  readonly view: VoiceViewState;
  /** The host has voice on (`voice.enabled`): only then is the mic offered. */
  readonly available: boolean;
  /** The voice view is on screen. */
  readonly shown: boolean;
  /** The mic button: opens voice, or ends it while it is open. */
  toggle(): void;
  /** Ends voice and closes the view. */
  close(): void;
  /** Talk again, on the same thread. */
  reconnect(): void;
  setMode(mode: VoiceMode): void;
  holdStart(): void;
  holdEnd(): void;
  /** The card's one tap. */
  runCard(): void;
};

export function useVoiceSession(options: UseVoiceSessionOptions): VoiceSession {
  const [available, setAvailable] = useState(false);
  const [view, dispatch] = useReducer(voiceViewReducer, undefined, () => initialVoiceViewState(readStoredVoiceMode()));
  const clientRef = useRef<VoiceClient | null>(null);
  const threadRef = useRef<string | null>(null);
  const modeRef = useRef<VoiceMode>(view.mode);
  const viewRef = useRef(view);
  viewRef.current = view;
  // The latest callbacks, read inside handlers that must not change identity.
  const latest = useRef(options);
  latest.current = options;
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readVoiceEnabled().then((enabled) => {
      if (!cancelled) {
        setAvailable(enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stopClient = useCallback(() => {
    const client = clientRef.current;
    clientRef.current = null;
    client?.stop();
  }, []);

  const close = useCallback(() => {
    stopClient();
    dispatch({ type: "close" });
  }, [stopClient]);

  const begin = useCallback(() => {
    stopClient();
    dispatch({ type: "open" });
    const client: VoiceClient = new VoiceClient({
      deps: browserVoiceDeps(),
      mode: modeRef.current,
      ensureThread: async () => {
        const id = await latest.current.ensureThread();
        threadRef.current = id;
        return id;
      },
      // A client that has been replaced or stopped says nothing more to the view.
      emit: (action) => {
        if (clientRef.current === client) {
          dispatch(action);
        }
      },
    });
    clientRef.current = client;
    // Straight from the tap: the client makes its audio before it awaits anything.
    void client.start();
  }, [stopClient]);

  const toggle = useCallback(() => {
    if (voiceShown(viewRef.current)) {
      close();
      return;
    }
    if (latest.current.chatRunning) {
      return;
    }
    returnFocusTo.current = typeof document === "undefined" ? null : document.activeElement;
    begin();
  }, [begin, close]);

  const reconnect = useCallback(() => begin(), [begin]);

  const setMode = useCallback((mode: VoiceMode) => {
    modeRef.current = mode;
    writeStoredVoiceMode(mode);
    if (clientRef.current) {
      clientRef.current.setMode(mode);
    } else {
      dispatch({ type: "mode", value: mode });
    }
  }, []);

  const holdStart = useCallback(() => clientRef.current?.holdStart(), []);
  const holdEnd = useCallback(() => {
    void clientRef.current?.holdEnd();
  }, []);

  const runCard = useCallback(() => {
    const card = viewRef.current.card;
    if (!card || card.started) {
      return;
    }
    // Voice ends first, so the microphone is released before the Chat turn starts; the run itself is
    // Chat's, with its own stop rules. Voice never runs the work.
    stopClient();
    if (latest.current.sendPrompt(card.prompt)) {
      dispatch({ type: "card_started" });
    }
  }, [stopClient]);

  // The host saved a turn: the thread under the view reloads, so it shows the turns as text.
  const savedSeen = useRef(view.saved);
  useEffect(() => {
    if (view.saved === savedSeen.current) {
      return;
    }
    savedSeen.current = view.saved;
    const threadId = threadRef.current;
    if (threadId) {
      void Promise.resolve(latest.current.refresh(threadId)).catch(() => undefined);
    }
  }, [view.saved]);

  // The owner opened another session: voice stays with the thread it was started on.
  const sessionSeen = useRef(options.sessionKey);
  useEffect(() => {
    if (sessionSeen.current === options.sessionKey) {
      return;
    }
    sessionSeen.current = options.sessionKey;
    if (voiceShown(viewRef.current)) {
      close();
    }
  }, [options.sessionKey, close]);

  // A reply started streaming in Chat (a message typed and sent while voice was up): voice stands down.
  useEffect(() => {
    if (options.chatRunning && voiceRunning(viewRef.current)) {
      close();
    }
  }, [options.chatRunning, close]);

  const shown = voiceShown(view);

  // Escape closes the view, wherever the focus is, unless something nearer already used the key.
  useEffect(() => {
    if (!shown) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, close]);

  // Focus goes back to where the tap came from, the mic button, when the view closes.
  const wasShown = useRef(false);
  useEffect(() => {
    if (wasShown.current && !shown) {
      const target = returnFocusTo.current;
      returnFocusTo.current = null;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus();
      }
    }
    wasShown.current = shown;
  }, [shown]);

  // "Started in Chat" stays up for a moment, then the view clears out so the reply can be seen.
  const cardStarted = view.card?.started === true && view.phase === "ended";
  useEffect(() => {
    if (!cardStarted) {
      return;
    }
    const timer = setTimeout(close, VOICE_CARD_STARTED_MS);
    return () => clearTimeout(timer);
  }, [cardStarted, close]);

  // Leaving the page, or the chat going away: every track stopped, the context and the socket closed.
  useEffect(() => stopClient, [stopClient]);

  return { view, available, shown, toggle, close, reconnect, setMode, holdStart, holdEnd, runCard };
}
