/**
 * Live voice, the real browser behind `VoiceClientDeps`. The only file besides `voice-audio.ts` that
 * touches `window`, `document`, `navigator` or `WebSocket`; the rest of the voice code is handed what
 * it needs, which is what lets a node test run it.
 */

import { VoiceAudio } from "./voice-audio";
import type { VoiceClientDeps, VoiceSocketLike } from "./voice-client";
import { openVoiceSession, voiceSocketUrl } from "./voice-session-api";

/** A phone or tablet: a touch-only screen, or a browser that says it is one. */
export function isPhoneLike(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) {
      return true;
    }
  } catch {
    // no matchMedia
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * When voice has to stop because the screen is not the person's any more: the page is hidden on a
 * phone (a locked screen, another app in front), or the page is going away. A hidden tab on a desktop
 * keeps talking: the person is looking at something else while the desk answers.
 */
function watchBackground(run: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden" && isPhoneLike()) {
      run();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", run);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", run);
  };
}

export function browserVoiceDeps(): VoiceClientDeps {
  return {
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : true,
    supported: {
      webSocket: typeof WebSocket !== "undefined",
      getUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
      audioWorklet:
        typeof AudioWorkletNode !== "undefined" &&
        (typeof AudioContext !== "undefined" ||
          typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined"),
    },
    createAudio: () => new VoiceAudio(),
    openSession: (threadId, mode) => openVoiceSession(threadId, mode),
    // One cast at the boundary: the DOM's handler signatures take an event and are `this`-typed, which is wider
    // than the structural slice `VoiceClient` assigns to.
    createSocket: (streamPath) =>
      new WebSocket(voiceSocketUrl(window.location, streamPath)) as unknown as VoiceSocketLike,
    watchBackground,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    debug: import.meta.env.DEV ? (label, value) => console.debug(label, value) : undefined,
  };
}
