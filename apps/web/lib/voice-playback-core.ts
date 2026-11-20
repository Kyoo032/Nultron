/**
 * Live voice, the speaker half, as plain code: the ring buffer the playback worklet drains
 * (`voice-worklet.ts`). The host sends the agent's audio faster than it plays, so it is buffered here,
 * played gaplessly, and can be paused, resumed or emptied between one render quantum and the next.
 *
 * It also keeps the one number the host needs after a cut-in: how many milliseconds of the agent's
 * turn the person has actually heard. Only samples that reached the output count: not the silence
 * written while paused or starved, and not what was dropped unplayed.
 */

import { VOICE_SAMPLE_RATE } from "@agentforge/core/voice";

const INITIAL_CAPACITY = VOICE_SAMPLE_RATE * 4;

export type PlaybackStats = {
  /** Source samples (24 kHz) that have been played since the last turn boundary, with the fraction between two. */
  readonly playedSamples: number;
  /** Source samples waiting. */
  readonly queuedSamples: number;
  readonly paused: boolean;
};

export class PlaybackQueue {
  private buffer = new Float32Array(INITIAL_CAPACITY);
  /** Index of the next sample to play, and how many samples wait after it. A ring: both wrap. */
  private read = 0;
  private length = 0;
  /** Position inside the queue as a fraction of a sample, for an output that does not run at 24 kHz. */
  private position = 0;
  private played = 0;
  private isPaused = false;
  /** `state: listening` came while audio still waited: the count restarts when that audio is gone. */
  private resetWhenIdle = false;
  /** Source samples consumed per output sample. */
  private readonly step: number;

  constructor(readonly outputRate: number = VOICE_SAMPLE_RATE) {
    if (!(outputRate > 0)) {
      throw new RangeError("the output rate must be positive");
    }
    this.step = VOICE_SAMPLE_RATE / outputRate;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Samples waiting to play, in source samples. */
  get queuedSamples(): number {
    return this.length;
  }

  /** Audio is coming out of the speaker now: something is queued and nothing holds it. */
  get playing(): boolean {
    return this.length > 0 && !this.isPaused;
  }

  get playedSamples(): number {
    return this.played + this.position;
  }

  /** Milliseconds of the agent's turn the person has heard. */
  get playedMs(): number {
    return (this.playedSamples / VOICE_SAMPLE_RATE) * 1000;
  }

  get queuedMs(): number {
    return (this.length / VOICE_SAMPLE_RATE) * 1000;
  }

  stats(): PlaybackStats {
    return { playedSamples: this.playedSamples, queuedSamples: this.length, paused: this.isPaused };
  }

  /** Adds audio behind what is queued. Starts a new count when the last turn was ended and has gone quiet. */
  enqueue(samples: Float32Array): void {
    if (samples.length === 0) {
      return;
    }
    if (this.length === 0 && this.resetWhenIdle) {
      this.restartCount();
    }
    this.grow(this.length + samples.length);
    let write = (this.read + this.length) % this.buffer.length;
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[write] = samples[i] as number;
      write += 1;
      if (write === this.buffer.length) {
        write = 0;
      }
    }
    this.length += samples.length;
  }

  /** Holds the audio where it is. Output is silence from the next quantum, and nothing is lost. */
  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  /** Throws every queued sample away. What was played stays counted, so it can still be reported. Returns what was dropped. */
  drop(): number {
    const dropped = this.length;
    this.read = 0;
    this.length = 0;
    this.position = 0;
    return dropped;
  }

  /**
   * `state: listening`: the agent's turn is over, so the next one counts from zero. Right away when
   * nothing waits; otherwise once the audio still queued has played or been dropped and new audio
   * arrives, because a person who cuts in on that tail has still heard the turn it belongs to.
   */
  endTurn(): void {
    if (this.length === 0) {
      this.restartCount();
    } else {
      this.resetWhenIdle = true;
    }
  }

  /** Forget everything, for a new session. */
  clear(): void {
    this.drop();
    this.isPaused = false;
    this.restartCount();
  }

  /**
   * Fills `out` with the next samples at the output rate, in the order they arrived. Silence while
   * paused, and for whatever the queue cannot supply (an underrun). Returns how many output samples
   * carried audio.
   */
  render(out: Float32Array): number {
    out.fill(0);
    if (this.isPaused) {
      return 0;
    }
    let produced = 0;
    for (let i = 0; i < out.length; i += 1) {
      const base = Math.floor(this.position);
      if (base >= this.length) {
        break;
      }
      const first = this.buffer[(this.read + base) % this.buffer.length] as number;
      const second =
        base + 1 < this.length ? (this.buffer[(this.read + base + 1) % this.buffer.length] as number) : first;
      out[i] = first + (second - first) * (this.position - base);
      produced += 1;
      this.position += this.step;
      const consumed = Math.min(Math.floor(this.position), this.length);
      if (consumed > 0) {
        this.read = (this.read + consumed) % this.buffer.length;
        this.length -= consumed;
        this.played += consumed;
        this.position -= consumed;
      }
    }
    if (this.length === 0) {
      this.position = 0;
      if (this.resetWhenIdle) {
        this.restartCount();
      }
    }
    return produced;
  }

  private restartCount(): void {
    this.played = 0;
    this.position = 0;
    this.resetWhenIdle = false;
  }

  private grow(needed: number): void {
    if (needed <= this.buffer.length) {
      return;
    }
    let capacity = this.buffer.length;
    while (capacity < needed) {
      capacity *= 2;
    }
    const next = new Float32Array(capacity);
    for (let i = 0; i < this.length; i += 1) {
      next[i] = this.buffer[(this.read + i) % this.buffer.length] as number;
    }
    this.buffer = next;
    this.read = 0;
  }
}
