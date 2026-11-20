/**
 * The microphone half of a browser in hands-free: a steady stream of 40 ms frames (1,920 bytes of PCM16
 * mono 24 kHz) at real-time pace, silence included. A clip is queued and goes out in place of silence frames;
 * when nothing is queued, silence goes out. The host never sees a gap in the stream.
 *
 * Pacing is drift-free: frame `i` is due at `start + (i + 1) * 40 ms`, the moment a browser has finished
 * capturing it. A late timer is caught up by sending the next frame at once, so the long-run rate stays real
 * time whatever one tick does. Each frame's real send time is recorded, because the latency numbers are
 * measured from when the host actually got the audio, not from when it was due.
 */
import { FRAME_MS, silencePcm, splitFrames } from "./audio";
import type { Clock } from "./clock";

export type QueuedClip = {
  /** Index of the clip's first frame in the stream. */
  readonly startFrame: number;
  readonly frames: number;
  /** Stream position (ms from the start of the stream) of the clip's first sample. */
  readonly startMs: number;
  /** Resolves when the clip's last frame has been sent. */
  readonly sent: Promise<void>;
};

export type Mic = {
  start(): void;
  stop(): Promise<void>;
  /** Queues a clip behind whatever is queued. It starts on a frame boundary and is padded to whole frames. */
  say(pcm: Buffer): QueuedClip;
  /** Resolves `ms` of stream time after the audio queued so far has gone out. */
  silence(ms: number): Promise<void>;
  /** Resolves when the frame holding stream position `ms` has been sent. */
  whenStreamReaches(ms: number): Promise<void>;
  /**
   * The client-clock instant that stream position `ms` was captured, judged from when the frame holding it
   * was really sent (a frame leaves when its last sample is captured). Null until that frame has gone out.
   */
  clockAt(ms: number): number | null;
  /** Real send time of every frame so far. */
  readonly sentAt: readonly number[];
  /** The most any frame left after its due time, in ms: how far the stream fell behind real time. */
  readonly maxLagMs: number;
  readonly framesSent: number;
  /** Stream position reached by the frames sent, in ms. */
  readonly streamMs: number;
  /** Set when a send threw (the socket closed): the stream stops and this says why. */
  readonly failure: Error | null;
};

export function createMic(options: { send: (frame: Buffer) => void; clock: Clock }): Mic {
  const { clock } = options;
  const queue: Buffer[] = [];
  const sentAt: number[] = [];
  let waiters: Array<{ frame: number; resolve: () => void }> = [];
  let loop: Promise<void> | null = null;
  let stopped = false;
  let failure: Error | null = null;
  let maxLagMs = 0;
  const silenceFrame = silencePcm(FRAME_MS);

  function release(): void {
    const ready = waiters.filter((waiter) => waiter.frame < sentAt.length);
    if (ready.length === 0) {
      return;
    }
    waiters = waiters.filter((waiter) => waiter.frame >= sentAt.length);
    for (const waiter of ready) {
      waiter.resolve();
    }
  }

  /** The pause before the next frame, cut short by `stop()` so ending a session never waits for a tick. */
  let wake: (() => void) | null = null;
  let tick: { cancel(): void } | null = null;

  function pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
      tick = clock.after(ms, resolve);
    }).finally(() => {
      wake = null;
      tick = null;
    });
  }

  async function run(): Promise<void> {
    const startedAt = clock.now();
    while (!stopped) {
      const due = startedAt + (sentAt.length + 1) * FRAME_MS;
      const wait = due - clock.now();
      if (wait > 0) {
        await pause(wait);
      }
      if (stopped) {
        break;
      }
      const frame = queue.shift() ?? silenceFrame;
      const at = clock.now();
      maxLagMs = Math.max(maxLagMs, at - due);
      try {
        options.send(frame);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        stopped = true;
        break;
      }
      sentAt.push(at);
      release();
    }
    // Nobody is left to wait for frames that will not come.
    for (const waiter of waiters) {
      waiter.resolve();
    }
    waiters = [];
  }

  function whenFrameSent(index: number): Promise<void> {
    if (index < sentAt.length || stopped) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push({ frame: index, resolve });
    });
  }

  return {
    start() {
      if (!loop) {
        loop = run();
      }
    },
    async stop() {
      stopped = true;
      tick?.cancel();
      wake?.();
      await loop;
    },
    say(pcm) {
      const frames = splitFrames(pcm);
      const startFrame = sentAt.length + queue.length;
      queue.push(...frames);
      return {
        startFrame,
        frames: frames.length,
        startMs: startFrame * FRAME_MS,
        sent: whenFrameSent(startFrame + frames.length - 1),
      };
    },
    silence(ms) {
      const target = (sentAt.length + queue.length) * FRAME_MS + ms;
      return whenFrameSent(Math.max(0, Math.ceil(target / FRAME_MS) - 1));
    },
    whenStreamReaches(ms) {
      return whenFrameSent(Math.max(0, Math.ceil(ms / FRAME_MS) - 1));
    },
    clockAt(ms) {
      const frame = Math.max(0, Math.ceil(ms / FRAME_MS) - 1);
      const at = sentAt[frame];
      return at === undefined ? null : at - ((frame + 1) * FRAME_MS - ms);
    },
    get sentAt() {
      return sentAt;
    },
    get maxLagMs() {
      return maxLagMs;
    },
    get framesSent() {
      return sentAt.length;
    },
    get streamMs() {
      return sentAt.length * FRAME_MS;
    },
    get failure() {
      return failure;
    },
  };
}

