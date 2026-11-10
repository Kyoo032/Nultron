/**
 * Live voice, the audio worklet module. Vite bundles this file on its own and emits it as a hashed
 * `.js` next to the app's other assets (`voice-audio.ts` imports its URL with `?worker&url`), so it
 * is loaded from this origin under `script-src 'self'`, never from a `blob:` or `data:` URL.
 *
 * It registers two processors on the audio thread:
 *  - `voice-capture`: the microphone in, 24 kHz int16 frames of exactly 40 ms and 20 ms loudness
 *    windows out (`voice-capture-core.ts`);
 *  - `voice-playback`: the agent's audio, buffered and played gaplessly, pausable and droppable
 *    between one 128-sample quantum and the next (`voice-playback-core.ts`).
 *
 * Everything with logic is in the two core files, which a node test runs; this file is only the
 * glue to the worklet scope's own globals, declared here because the DOM lib does not have them.
 */

import { CaptureCore } from "./voice-capture-core";
import { PlaybackQueue } from "./voice-playback-core";
import {
  CAPTURE_PROCESSOR,
  type CaptureCommand,
  type CaptureMessage,
  PLAYBACK_PROCESSOR,
  type PlaybackCommand,
  type PlaybackMessage,
} from "./voice-worklet-messages";

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(name: string, processor: new (options?: unknown) => AudioWorkletProcessor): void;

/** A stats report every this many render quanta while audio is playing: about 50 ms at 24 kHz. */
const STATS_EVERY_QUANTA = 10;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly core = new CaptureCore(sampleRate);

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (event: MessageEvent<CaptureCommand>) => {
      if (event.data.type === "flush") {
        const last = this.core.flush();
        if (last) {
          this.post({ type: "capture", frames: [last], levels: [] }, [last]);
        }
        this.post({ type: "flushed" }, []);
      } else if (event.data.type === "reset") {
        this.core.reset();
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const { frames, levels } = this.core.process(channel);
      if (frames.length > 0 || levels.length > 0) {
        this.post({ type: "capture", frames, levels }, frames);
      }
    }
    return true;
  }

  private post(message: CaptureMessage, transfer: ArrayBuffer[]): void {
    this.port.postMessage(message, transfer);
  }
}

class VoicePlaybackProcessor extends AudioWorkletProcessor {
  private readonly queue = new PlaybackQueue(sampleRate);
  private pushes = 0;
  private quanta = 0;
  private wasPlaying = false;

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (event: MessageEvent<PlaybackCommand>) => {
      const command = event.data;
      switch (command.type) {
        case "push":
          this.pushes += 1;
          this.queue.enqueue(command.samples);
          break;
        case "pause":
          this.queue.pause();
          this.report(command.id);
          break;
        case "resume":
          this.queue.resume();
          break;
        case "drop":
          this.queue.drop();
          this.report(command.id);
          break;
        case "turn":
          this.queue.endTurn();
          break;
        case "clear":
          this.queue.clear();
          break;
        case "query":
          this.report(command.id);
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const first = outputs[0]?.[0];
    if (first) {
      this.queue.render(first);
      const channels = outputs[0] ?? [];
      for (let c = 1; c < channels.length; c += 1) {
        channels[c]?.set(first);
      }
    }
    this.quanta += 1;
    const playing = this.queue.playing;
    if ((playing && this.quanta % STATS_EVERY_QUANTA === 0) || playing !== this.wasPlaying) {
      this.report(null);
    }
    this.wasPlaying = playing;
    return true;
  }

  private report(id: number | null): void {
    const stats = this.queue.stats();
    const message: PlaybackMessage = {
      type: "stats",
      id,
      playedSamples: stats.playedSamples,
      queuedSamples: stats.queuedSamples,
      paused: stats.paused,
      pushes: this.pushes,
    };
    this.port.postMessage(message);
  }
}

registerProcessor(CAPTURE_PROCESSOR, VoiceCaptureProcessor);
registerProcessor(PLAYBACK_PROCESSOR, VoicePlaybackProcessor);
