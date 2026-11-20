/**
 * Live voice, the microphone half, as plain code: whatever the capture worklet is handed
 * (`voice-worklet.ts`) goes through here. Float samples at the context's rate come in; frames of
 * exactly 40 ms of 24 kHz int16 PCM, and a loudness number every 20 ms, come out.
 *
 * It lives apart from the worklet so a node test can drive it, and so the main thread and the worklet
 * can never disagree about the shape of a frame.
 */

import { VOICE_SAMPLE_RATE } from "@agentforge/core/voice";
import { floatToInt16, PcmFramer, Resampler } from "./voice-pcm";

/** One loudness window. Short, so a cut-in is noticed within a few windows. */
export const VOICE_LEVEL_WINDOW_MS = 20;
const LEVEL_WINDOW_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_LEVEL_WINDOW_MS) / 1000;

export type CaptureOutput = {
  /** Whole frames, each exactly `VOICE_FRAME_BYTES`, in the order they were captured. */
  readonly frames: ArrayBuffer[];
  /** RMS of each finished `VOICE_LEVEL_WINDOW_MS` window (full scale is 1), measured at 24 kHz before int16. */
  readonly levels: number[];
};

export class CaptureCore {
  private readonly resampler: Resampler;
  private readonly framer = new PcmFramer();
  private windowSum = 0;
  private windowCount = 0;

  constructor(contextRate: number) {
    this.resampler = new Resampler(contextRate, VOICE_SAMPLE_RATE);
  }

  /** One render quantum (or any run) of mono float samples at the context's rate. */
  process(input: Float32Array): CaptureOutput {
    const mono = this.resampler.process(input);
    const levels: number[] = [];
    for (let i = 0; i < mono.length; i += 1) {
      const sample = mono[i] as number;
      this.windowSum += sample * sample;
      this.windowCount += 1;
      if (this.windowCount === LEVEL_WINDOW_SAMPLES) {
        levels.push(Math.sqrt(this.windowSum / LEVEL_WINDOW_SAMPLES));
        this.windowSum = 0;
        this.windowCount = 0;
      }
    }
    return { frames: this.framer.push(floatToInt16(mono)), levels };
  }

  /** The samples still waiting for their frame, padded with silence to a whole one, or null. */
  flush(): ArrayBuffer | null {
    return this.framer.flush();
  }

  /** Forget what is held, for a new push-to-talk press. */
  reset(): void {
    this.framer.reset();
    this.resampler.reset();
    this.windowSum = 0;
    this.windowCount = 0;
  }
}
