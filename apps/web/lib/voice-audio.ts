/**
 * Live voice, the browser's audio: one `AudioContext` that holds the microphone going in (to the
 * capture worklet) and the agent's voice coming out (from the playback worklet).
 *
 * The context is made synchronously in the tap that starts voice, because Safari lets audio start
 * only inside a user gesture; the microphone and the worklets follow once the tap's own work is done.
 * The context asks for 24 kHz so the browser does the sample-rate conversion where it can, and the
 * worklets convert themselves where it cannot (`voice-capture-core.ts`, `voice-playback-core.ts`).
 *
 * Everything that must outlive a view is released here: `close()` stops every microphone track (no
 * indicator may stay lit), disconnects the graph and closes the context. It is safe to call twice.
 */

import { VOICE_SAMPLE_RATE } from "@agentforge/core/voice";
import { stopTracks } from "./meeting-recorder-media";
import { bytesToInt16, int16ToFloat } from "./voice-pcm";
import {
  CAPTURE_PROCESSOR,
  type CaptureCommand,
  type CaptureMessage,
  PLAYBACK_PROCESSOR,
  type PlaybackCommand,
  type PlaybackMessage,
} from "./voice-worklet-messages";
import { VOICE_WORKLET_URL } from "./voice-worklet-url";

/** What the voice client needs from the audio, so it can be driven by a fake in a test. */
export interface VoiceAudioLike {
  /** Whole 40 ms frames (1,920 bytes each) and 20 ms loudness windows from the microphone. */
  onCapture: ((frames: ArrayBuffer[], levels: number[]) => void) | null;
  /** The context's state changed (`running`, `suspended`, `interrupted`, `closed`). */
  onState: ((state: string) => void) | null;
  /** The microphone was taken away (unplugged, or permission withdrawn). */
  onMicLost: (() => void) | null;
  readonly state: string;
  /** Asks for the microphone, loads the worklets and joins the graph. Throws what `getUserMedia` or the worklet load threw. */
  start(): Promise<void>;
  pushAgentAudio(pcm: ArrayBuffer): void;
  /** Agent audio is coming out of the speaker now. */
  agentAudioPlaying(): boolean;
  /** Pauses on the next audio quantum. Resolves with the ms of the agent's turn heard, read at that moment. */
  pausePlayback(): Promise<number>;
  resumePlayback(): void;
  /** Empties the queue. Resolves with the ms heard. */
  dropPlayback(): Promise<number>;
  /** `state: listening`. */
  endAgentTurn(): void;
  /** Sends the held remainder of a frame, padded, through `onCapture`, then resolves. */
  flushCapture(): Promise<void>;
  resetCapture(): void;
  close(): Promise<void>;
}

/** The longest the context is given to start running once the graph is built. */
const RESUME_WAIT_MS = 1_500;

/** The longest a worklet is waited on, in ms, before the last report it sent is used instead. */
const ACK_TIMEOUT_MS = 250;

/** Output latency is how far behind the worklet's count the speaker is; more than this is a bad report. */
const MAX_LATENCY_MS = 250;

type ContextConstructor = typeof AudioContext;

function contextConstructor(): ContextConstructor {
  const scope = globalThis as unknown as { AudioContext?: ContextConstructor; webkitAudioContext?: ContextConstructor };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) {
    throw new Error("AudioContext is not available");
  }
  return Ctor;
}

/** A context at 24 kHz when the browser allows it, and at its own rate otherwise. */
function makeContext(preferVoiceRate: boolean): AudioContext {
  const Context = contextConstructor();
  if (preferVoiceRate) {
    try {
      return new Context({ sampleRate: VOICE_SAMPLE_RATE, latencyHint: "interactive" });
    } catch {
      // Not every browser takes a sample rate; fall through to its own.
    }
  }
  return new Context({ latencyHint: "interactive" });
}

export class VoiceAudio implements VoiceAudioLike {
  onCapture: ((frames: ArrayBuffer[], levels: number[]) => void) | null = null;
  onState: ((state: string) => void) | null = null;
  onMicLost: (() => void) | null = null;

  private context: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private mute: GainNode | null = null;
  private closed = false;

  private nextAck = 1;
  private readonly waiting = new Map<number, (stats: PlaybackMessage) => void>();
  private stats: PlaybackMessage = {
    type: "stats",
    id: null,
    playedSamples: 0,
    queuedSamples: 0,
    paused: false,
    pushes: 0,
  };
  private pushes = 0;
  private pausedHere = false;
  private flushWaiters: Array<() => void> = [];

  /** Call inside the tap. Creates the context and asks it to run. */
  constructor() {
    this.context = makeContext(true);
    this.listen(this.context);
    void this.context.resume().catch(() => undefined);
  }

  get state(): string {
    return this.context.state as string;
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.stream = stream;
    if (this.closed) {
      stopTracks(stream);
      return;
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => this.onMicLost?.());
    }
    try {
      await this.context.audioWorklet.addModule(VOICE_WORKLET_URL);
      try {
        this.source = this.context.createMediaStreamSource(stream);
      } catch {
        // A browser that will not join a 24 kHz context to a microphone at another rate (Firefox):
        // start over on a context at the microphone's own rate, and let the worklets convert.
        await this.replaceContext();
        this.source = this.context.createMediaStreamSource(stream);
      }
      this.buildGraph(this.source);
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.closed) {
      await this.close();
      return;
    }
    // Chrome leaves `resume()` pending, not rejected, when it wants a gesture it has not had; the
    // client reads `state` afterwards, so a wait that never ends would help nobody.
    await Promise.race([
      this.context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
    ]);
  }

  private async replaceContext(): Promise<void> {
    const old = this.context;
    old.onstatechange = null;
    this.context = makeContext(false);
    this.listen(this.context);
    await old.close().catch(() => undefined);
    void this.context.resume().catch(() => undefined);
    await this.context.audioWorklet.addModule(VOICE_WORKLET_URL);
  }

  private listen(context: AudioContext): void {
    context.onstatechange = () => this.onState?.(context.state as string);
  }

  private buildGraph(source: MediaStreamAudioSourceNode): void {
    const context = this.context;
    const capture = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    capture.port.onmessage = (event: MessageEvent<CaptureMessage>) => {
      const message = event.data;
      if (message.type === "capture") {
        this.onCapture?.(message.frames, message.levels);
      } else {
        const waiters = this.flushWaiters;
        this.flushWaiters = [];
        for (const done of waiters) {
          done();
        }
      }
    };
    // A node that is not connected to the destination is not pulled, so the capture worklet's silent
    // output goes there through a gain of zero.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(capture);
    capture.connect(mute);
    mute.connect(context.destination);

    const playback = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    playback.port.onmessage = (event: MessageEvent<PlaybackMessage>) => {
      const stats = event.data;
      this.stats = stats;
      if (stats.id !== null) {
        const answer = this.waiting.get(stats.id);
        this.waiting.delete(stats.id);
        answer?.(stats);
      }
    };
    playback.connect(context.destination);
    this.capture = capture;
    this.playback = playback;
    this.mute = mute;
  }

  pushAgentAudio(pcm: ArrayBuffer): void {
    if (!this.playback || this.closed) {
      return;
    }
    const samples = int16ToFloat(bytesToInt16(pcm));
    if (samples.length === 0) {
      return;
    }
    this.pushes += 1;
    this.command(this.playback, { type: "push", samples }, [samples.buffer]);
  }

  agentAudioPlaying(): boolean {
    if (this.pausedHere || this.stats.paused) {
      return false;
    }
    return this.stats.queuedSamples > 0 || this.pushes > this.stats.pushes;
  }

  pausePlayback(): Promise<number> {
    this.pausedHere = true;
    return this.ask((id) => ({ type: "pause", id }));
  }

  resumePlayback(): void {
    this.pausedHere = false;
    if (this.playback) {
      this.command(this.playback, { type: "resume" });
    }
  }

  dropPlayback(): Promise<number> {
    this.pausedHere = false;
    return this.ask((id) => ({ type: "drop", id }));
  }

  endAgentTurn(): void {
    this.pausedHere = false;
    if (this.playback) {
      this.command(this.playback, { type: "turn" });
    }
  }

  flushCapture(): Promise<void> {
    const capture = this.capture;
    if (!capture || this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ACK_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.flushWaiters.push(done);
      const command: CaptureCommand = { type: "flush" };
      capture.port.postMessage(command);
    });
  }

  resetCapture(): void {
    if (this.capture) {
      const command: CaptureCommand = { type: "reset" };
      this.capture.port.postMessage(command);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.stream) {
      stopTracks(this.stream);
      this.stream = null;
    }
    for (const node of [this.source, this.capture, this.playback, this.mute]) {
      try {
        node?.disconnect();
      } catch {
        // already disconnected
      }
    }
    if (this.capture) {
      this.capture.port.onmessage = null;
    }
    if (this.playback) {
      this.playback.port.onmessage = null;
    }
    this.source = null;
    this.capture = null;
    this.playback = null;
    this.mute = null;
    for (const answer of this.waiting.values()) {
      answer(this.stats);
    }
    this.waiting.clear();
    for (const done of this.flushWaiters) {
      done();
    }
    this.flushWaiters = [];
    this.context.onstatechange = null;
    if (this.context.state !== "closed") {
      await this.context.close().catch(() => undefined);
    }
  }

  private command(node: AudioWorkletNode, command: PlaybackCommand, transfer: Transferable[] = []): void {
    node.port.postMessage(command, transfer);
  }

  /** Sends a command that the worklet answers with a stats report, and resolves with the ms heard in it. */
  private ask(make: (id: number) => PlaybackCommand): Promise<number> {
    const playback = this.playback;
    if (!playback || this.closed) {
      return Promise.resolve(this.heardMs(this.stats));
    }
    return new Promise((resolve) => {
      const id = this.nextAck;
      this.nextAck += 1;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(this.heardMs(this.stats));
      }, ACK_TIMEOUT_MS);
      this.waiting.set(id, (stats) => {
        clearTimeout(timer);
        resolve(this.heardMs(stats));
      });
      this.command(playback, make(id));
    });
  }

  /**
   * What the person has heard, in ms: what the worklet has played, less the time the sound is still
   * on its way to the speaker. Never negative.
   */
  private heardMs(stats: PlaybackMessage): number {
    const playedMs = (stats.playedSamples / VOICE_SAMPLE_RATE) * 1000;
    const context = this.context as AudioContext & { outputLatency?: number };
    const latencySeconds = context.outputLatency ?? context.baseLatency ?? 0;
    const latencyMs = Math.min(MAX_LATENCY_MS, Math.max(0, latencySeconds * 1000));
    return Math.max(0, Math.round(playedMs - (playedMs > 0 ? latencyMs : 0)));
  }
}
