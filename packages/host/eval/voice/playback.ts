/**
 * The listening half of a browser: how much of the agent's audio the person would have heard by now.
 *
 * Audio arrives in binary frames and plays at real time from a queue. The host can send faster than real
 * time (a model streams ahead), so the queue holds audio that has been received and not yet heard. The
 * browser pauses the queue when the person speaks over it (`barge_in`), drops it on `stop_audio`, and
 * carries on after `resume_audio`. `played` in the protocol is how many ms of the current reply were heard, so
 * this model is what the case sends there.
 *
 * Everything takes the time as an argument: the model has no clock of its own and is a pure function of the
 * events it is fed, which is what lets the tests drive it with exact numbers.
 */
import { BYTES_PER_MS } from "./audio";

export type Playback = {
  /** Agent audio arrived: `bytes` of PCM at `at`. */
  onAudio(bytes: number, at: number): void;
  /** The person spoke over the agent and the browser paused locally. */
  pause(at: number): void;
  /** `resume_audio`: playback carries on from where it paused. */
  resume(at: number): void;
  /** `stop_audio`: the queue is dropped. Returns the ms of this reply that were heard; the counter starts over. */
  stop(at: number): number;
  /** Milliseconds of the current reply the person has heard by `at`. */
  playedMs(at: number): number;
  /** Received and not yet heard at `at`. */
  bufferedMs(at: number): number;
  /** Everything received in the current reply, heard or not. */
  readonly receivedMs: number;
  readonly paused: boolean;
};

export function createPlayback(): Playback {
  let played = 0;
  let buffered = 0;
  let received = 0;
  let lastAt: number | null = null;
  let paused = false;

  function advance(at: number): void {
    if (lastAt !== null && !paused) {
      const heard = Math.min(buffered, Math.max(0, at - lastAt));
      played += heard;
      buffered -= heard;
    }
    lastAt = at;
  }

  return {
    onAudio(bytes, at) {
      advance(at);
      const ms = bytes / BYTES_PER_MS;
      buffered += ms;
      received += ms;
    },
    pause(at) {
      advance(at);
      paused = true;
    },
    resume(at) {
      advance(at);
      paused = false;
    },
    stop(at) {
      advance(at);
      const heard = played;
      played = 0;
      buffered = 0;
      received = 0;
      paused = false;
      return heard;
    },
    playedMs(at) {
      advance(at);
      return played;
    },
    bufferedMs(at) {
      advance(at);
      return buffered;
    },
    get receivedMs() {
      return received;
    },
    get paused() {
      return paused;
    },
  };
}
