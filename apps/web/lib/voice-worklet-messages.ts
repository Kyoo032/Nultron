/**
 * Live voice, what the main thread and the two audio worklets say to each other over their message
 * ports (`voice-worklet.ts` is the worklet side, `voice-audio.ts` the main-thread side). Types only.
 */

/** Names the worklet registers; the main thread builds nodes by these. */
export const CAPTURE_PROCESSOR = "voice-capture";
export const PLAYBACK_PROCESSOR = "voice-playback";

export type CaptureCommand = { readonly type: "flush" } | { readonly type: "reset" };

export type CaptureMessage =
  /** Finished 40 ms frames (each `VOICE_FRAME_BYTES`) and 20 ms loudness windows, in capture order. */
  | { readonly type: "capture"; readonly frames: ArrayBuffer[]; readonly levels: number[] }
  /** Answers `flush`, after the last frame it produced. */
  | { readonly type: "flushed" };

export type PlaybackCommand =
  /** Agent audio as floats at 24 kHz. The buffer is transferred. */
  | { readonly type: "push"; readonly samples: Float32Array }
  | { readonly type: "pause"; readonly id: number }
  | { readonly type: "resume" }
  | { readonly type: "drop"; readonly id: number }
  /** `state: listening`: the agent's turn is over. */
  | { readonly type: "turn" }
  | { readonly type: "clear" }
  | { readonly type: "query"; readonly id: number };

export type PlaybackMessage = {
  readonly type: "stats";
  /** The command this answers, when it answers one; periodic reports carry none. */
  readonly id: number | null;
  readonly playedSamples: number;
  readonly queuedSamples: number;
  readonly paused: boolean;
  /** How many `push` commands the worklet has taken in, so a push still in flight is not mistaken for silence. */
  readonly pushes: number;
};
