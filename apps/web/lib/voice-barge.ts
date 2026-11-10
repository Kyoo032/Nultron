/**
 * Live voice, cutting in, the sequence: when the person speaks over the agent the browser acts first
 * and the host decides.
 *
 *   speech heard over playback -> pause playback now, send `barge_in`, then `played { ms }`
 *   host: `resume_audio` (a backchannel, not a real interruption) -> resume playback
 *   host: `stop_audio` (a real interruption)                       -> drop the queue, send `played { ms }`
 *   neither within 3 s                                             -> resume, so a lost frame cannot leave the agent mute
 *
 * Microphone audio keeps flowing to the host throughout (the client does that), so nothing the person
 * says is lost whichever way the host decides. This file holds only the order of those steps, against
 * a small set of effects, so the order is a test and not a hope.
 */

import type { VoiceBrowserFrame, VoiceHostFrame } from "@agentforge/core/voice";
import type { BargeDetector } from "./voice-barge-detector";

/** How long the browser waits for the host's word before it takes the pause back. */
export const BARGE_RESUME_TIMEOUT_MS = 3_000;

export type BargeEffects = {
  /** Pauses playback now. Resolves with the ms of the agent's turn heard, read at the moment of the pause. */
  pausePlayback(): Promise<number> | number;
  resumePlayback(): void;
  /** Empties the queue. Resolves with the ms heard, read at the moment of the drop. */
  dropPlayback(): Promise<number> | number;
  send(frame: VoiceBrowserFrame): void;
  /** Agent audio is coming out of the speaker now. */
  agentAudioPlaying(): boolean;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
};

export class BargeCoordinator {
  private waiting = false;
  private timer: unknown = null;
  /** Speech that was already going on when it was handled, so one burst pauses playback once. */
  private handled = false;
  /** Steps run one after another, so a host frame cannot overtake the pause it answers. */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly effects: BargeEffects,
    private readonly detector: BargeDetector,
  ) {}

  /** A browser pause is waiting for the host's word. */
  get pending(): boolean {
    return this.waiting;
  }

  /**
   * One microphone window. The detector always learns from it; playback is paused only if agent audio
   * is playing, speech has been sustained, and a pause is not already waiting on the host.
   */
  onLevel(rms: number, windowMs: number): void {
    const onset = this.detector.push(rms, windowMs);
    if (!this.detector.speaking) {
      this.handled = false;
      return;
    }
    if ((onset || !this.handled) && !this.waiting && this.effects.agentAudioPlaying()) {
      this.handled = true;
      this.bargeIn();
    }
  }

  /** The person pressed push-to-talk over the agent: the same pause, without a loudness guess. */
  onHoldStart(): void {
    if (!this.waiting && this.effects.agentAudioPlaying()) {
      this.bargeIn();
    }
  }

  /** A host frame. Only `resume_audio` and `stop_audio` are for this; the rest are ignored. */
  onHostFrame(frame: VoiceHostFrame): void {
    if (frame.type === "resume_audio") {
      this.enqueue(() => {
        this.settle();
        this.effects.resumePlayback();
      });
    } else if (frame.type === "stop_audio") {
      this.enqueue(async () => {
        this.settle();
        const ms = await this.effects.dropPlayback();
        this.effects.send({ type: "played", ms });
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearWait();
  }

  private bargeIn(): void {
    this.waiting = true;
    this.clearWait();
    this.timer = this.effects.setTimer(() => {
      this.timer = null;
      this.enqueue(() => {
        if (this.waiting) {
          this.waiting = false;
          this.effects.resumePlayback();
        }
      });
    }, BARGE_RESUME_TIMEOUT_MS);
    // Playback is told to pause before anything else, and `barge_in` goes out before the pause has
    // answered; `played` follows with what the pause measured.
    const paused = this.effects.pausePlayback();
    this.effects.send({ type: "barge_in" });
    this.enqueue(async () => {
      const ms = await paused;
      this.effects.send({ type: "played", ms });
    });
  }

  /** The host has answered: no waiting, no timer. */
  private settle(): void {
    this.waiting = false;
    this.clearWait();
  }

  private clearWait(): void {
    if (this.timer !== null) {
      this.effects.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private enqueue(step: () => void | Promise<void>): void {
    this.chain = this.chain
      .then(() => {
        if (!this.disposed) {
          return step();
        }
        return undefined;
      })
      .catch(() => undefined);
  }
}
