/**
 * Live voice, the browser end of one session: it opens the microphone, makes the session with the
 * host (H1), opens the socket (H2), and then moves audio and JSON frames between them and the view.
 *
 * It holds no React and no DOM type of its own. The parts that need a browser (the audio, the
 * socket, the page's visibility, H1) arrive as `VoiceClientDeps`, so a node test runs the whole
 * lifecycle against fakes, including the part that matters most: after `stop()` nothing is left
 * open, so no microphone indicator stays lit.
 *
 * What it tells the view is a stream of `VoiceViewAction`s; what it tells the host is the frames in
 * the contract (`packages/core/src/voice/protocol.ts`). Nothing here runs work: a card's prompt goes
 * to Chat through the composer, never from here.
 */

import {
  parseVoiceHostFrame,
  type VoiceBrowserFrame,
  type VoiceHostFrame,
  type VoiceMode,
  type VoiceSessionCreated,
} from "@agentforge/core/voice";
import { BargeDetector } from "./voice-barge-detector";
import { BargeCoordinator } from "./voice-barge";
import { VOICE_LEVEL_WINDOW_MS } from "./voice-capture-core";
import { mapVoiceMicError } from "./voice-errors";
import type { VoiceAudioLike } from "./voice-audio";
import type { OpenVoiceSessionResult } from "./voice-session-api";
import type { VoiceErrorCode, VoiceViewAction } from "./voice-view-state";

/** `WebSocket.OPEN`, spelled out so this file needs no DOM global. */
const SOCKET_OPEN = 1;

/** How long the socket gets to open before the start is called a failure to connect. */
export const SOCKET_OPEN_TIMEOUT_MS = 10_000;

/** The slice of `WebSocket` this file uses. */
export interface VoiceSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
}

export type VoiceClientDeps = {
  readonly secureContext: boolean;
  readonly supported: { readonly webSocket: boolean; readonly getUserMedia: boolean; readonly audioWorklet: boolean };
  /** Called inside the tap, before anything is awaited. */
  createAudio(): VoiceAudioLike;
  openSession(threadId: string, mode: VoiceMode): Promise<OpenVoiceSessionResult>;
  createSocket(streamPath: string): VoiceSocketLike;
  /** Tells `run` when the screen locks or the app is left. Returns how to stop listening. */
  watchBackground(run: () => void): () => void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Dev-only look at the host's latency numbers. */
  debug?(label: string, value: unknown): void;
};

export type VoiceClientOptions = {
  readonly deps: VoiceClientDeps;
  /** The Chat thread the turns are saved to, made if the chat does not have one yet. */
  readonly ensureThread: () => Promise<string>;
  readonly mode: VoiceMode;
  /** Everything the view needs to hear. */
  readonly emit: (action: VoiceViewAction) => void;
};

export class VoiceClient {
  private readonly deps: VoiceClientDeps;
  private mode: VoiceMode;
  private audio: VoiceAudioLike | null = null;
  private socket: VoiceSocketLike | null = null;
  private barge: BargeCoordinator | null = null;
  private stopWatching: (() => void) | null = null;
  private ready = false;
  private holding = false;
  private everRan = false;
  /** Gives up on a socket that is still opening, so a stop during setup does not leave `connect` waiting. */
  private abortConnect: (() => void) | null = null;
  /** Over: nothing more is sent, heard or kept open. Set once, by `finish`. */
  private finished = false;

  constructor(private readonly options: VoiceClientOptions) {
    this.deps = options.deps;
    this.mode = options.mode;
  }

  /**
   * Begins. Call it straight from the tap: the audio is made before the first `await`, which is what
   * Safari needs. Resolves when the session is up or has failed; failure is told to `emit`, not thrown.
   */
  start(): Promise<void> {
    const { deps } = this;
    if (!deps.secureContext) {
      return this.fail("insecure");
    }
    if (!deps.supported.webSocket || !deps.supported.getUserMedia || !deps.supported.audioWorklet) {
      return this.fail("unsupported");
    }
    try {
      this.audio = deps.createAudio();
    } catch {
      return this.fail("unsupported");
    }
    return this.run(this.audio);
  }

  private async run(audio: VoiceAudioLike): Promise<void> {
    let threadId: string;
    try {
      threadId = await this.options.ensureThread();
    } catch {
      return this.fail("thread");
    }
    if (this.finished) {
      return;
    }
    // The microphone before H1: the host drops a session nobody connects to within 30 s, and a
    // permission prompt can take longer than that.
    try {
      await audio.start();
    } catch (error) {
      return this.fail(mapVoiceMicError(error));
    }
    if (this.finished) {
      return;
    }
    const opened = await this.deps.openSession(threadId, this.mode);
    if (this.finished) {
      return;
    }
    if (!opened.ok) {
      return this.fail(opened.code);
    }
    try {
      await this.connect(audio, opened.session);
    } catch {
      return this.fail("connect");
    }
  }

  private async connect(audio: VoiceAudioLike, session: VoiceSessionCreated): Promise<void> {
    const socket = this.deps.createSocket(session.streamPath);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = this.deps.setTimer(() => reject(new Error("socket timeout")), SOCKET_OPEN_TIMEOUT_MS);
      const settled = () => {
        this.deps.clearTimer(timer);
        this.abortConnect = null;
      };
      this.abortConnect = () => {
        settled();
        reject(new Error("stopped"));
      };
      socket.onopen = () => {
        settled();
        resolve();
      };
      socket.onerror = () => {
        settled();
        reject(new Error("socket error"));
      };
      socket.onclose = () => {
        settled();
        reject(new Error("socket closed"));
      };
    });
    if (this.finished) {
      return;
    }
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (!this.finished) {
        this.options.emit({ type: "dropped" });
        this.finish(false);
      }
    };

    const detector = new BargeDetector();
    this.barge = new BargeCoordinator(
      {
        pausePlayback: () => audio.pausePlayback(),
        resumePlayback: () => audio.resumePlayback(),
        dropPlayback: () => audio.dropPlayback(),
        send: (frame) => this.sendFrame(frame),
        agentAudioPlaying: () => audio.agentAudioPlaying(),
        setTimer: (run, ms) => this.deps.setTimer(run, ms),
        clearTimer: (handle) => this.deps.clearTimer(handle),
      },
      detector,
    );
    audio.onCapture = (frames, levels) => this.onCapture(frames, levels);
    audio.onState = (state) => this.onAudioState(state);
    audio.onMicLost = () => {
      if (!this.finished) {
        this.fail("micBusy");
      }
    };
    this.stopWatching = this.deps.watchBackground(() => this.background());
    // A context that is not running by now never heard the tap (a phone that locked, a browser that
    // wants a fresh gesture): the way back is to tap again.
    if (audio.state === "running") {
      this.everRan = true;
    } else {
      this.background();
    }
  }

  /** The host's JSON frames and the agent's audio. */
  private onMessage(data: unknown): void {
    if (this.finished) {
      return;
    }
    if (typeof data === "string") {
      const frame = parseVoiceHostFrame(data);
      if (frame) {
        this.onFrame(frame);
      }
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.audio?.pushAgentAudio(data);
    }
  }

  private onFrame(frame: VoiceHostFrame): void {
    switch (frame.type) {
      case "ready":
        this.ready = true;
        if (this.mode !== "hands_free") {
          this.sendFrame({ type: "mode", value: this.mode });
        }
        this.options.emit({ type: "frame", frame });
        return;
      case "state":
        if (frame.value === "listening") {
          this.audio?.endAgentTurn();
        }
        this.options.emit({ type: "frame", frame });
        return;
      case "stop_audio":
      case "resume_audio":
        this.barge?.onHostFrame(frame);
        return;
      case "metrics":
        this.deps.debug?.("voice metrics", frame);
        return;
      case "ended":
        this.options.emit({ type: "frame", frame });
        this.finish(false);
        return;
      default:
        this.options.emit({ type: "frame", frame });
    }
  }

  private onCapture(frames: ArrayBuffer[], levels: number[]): void {
    if (this.finished || !this.ready) {
      return;
    }
    // Hands-free: the microphone is open the whole time, and the host finds the end of a turn. A
    // cut-in is guessed from its loudness. Push-to-talk: only what is held is sent, and pressing the
    // button over the agent is the cut-in.
    if (this.mode === "hands_free") {
      for (const level of levels) {
        this.barge?.onLevel(level, VOICE_LEVEL_WINDOW_MS);
      }
    }
    if (this.mode === "hands_free" || this.holding) {
      for (const frame of frames) {
        this.sendBinary(frame);
      }
    }
  }

  private onAudioState(state: string): void {
    if (this.finished) {
      return;
    }
    if (state === "running") {
      this.everRan = true;
    } else if (this.everRan && (state === "suspended" || state === "interrupted")) {
      this.background();
    }
  }

  /** The screen locked, the tab went to the background on a phone, or the context was suspended. */
  private background(): void {
    if (this.finished) {
      return;
    }
    this.options.emit({ type: "backgrounded" });
    this.finish(true);
  }

  /** Switches how turns end, for the rest of the session. */
  setMode(mode: VoiceMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.holding = false;
    this.options.emit({ type: "mode", value: mode });
    if (this.ready) {
      this.sendFrame({ type: "mode", value: mode });
    }
  }

  /** Push-to-talk pressed: frames go to the host until `holdEnd`. */
  holdStart(): void {
    if (this.finished || !this.ready || this.mode !== "push_to_talk" || this.holding) {
      return;
    }
    this.audio?.resetCapture();
    this.holding = true;
    this.barge?.onHoldStart();
  }

  /** Push-to-talk released: what is still held in the last frame goes out, then `commit`. */
  async holdEnd(): Promise<void> {
    if (this.finished || !this.holding) {
      return;
    }
    await this.audio?.flushCapture();
    // The flush was the last thing sent for this press: later frames are not part of it.
    this.holding = false;
    if (!this.finished) {
      this.sendFrame({ type: "commit" });
    }
  }

  /** The person ended voice, or the view is going away. Tells the host, then lets everything go. */
  stop(): void {
    if (this.finished) {
      return;
    }
    this.finish(true);
  }

  private fail(code: VoiceErrorCode): Promise<void> {
    if (!this.finished) {
      this.options.emit({ type: "failed", code });
      this.finish(false);
    }
    return Promise.resolve();
  }

  /**
   * Over. Sends `stop` when asked to and the socket is open, closes the socket, stops every
   * microphone track and closes the audio. Safe to call twice, and the only way anything is released.
   */
  private finish(tellHost: boolean): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.holding = false;
    this.ready = false;
    if (tellHost) {
      this.sendFrame({ type: "stop" });
    }
    this.abortConnect?.();
    this.barge?.dispose();
    this.stopWatching?.();
    this.stopWatching = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000);
      } catch {
        // already closed
      }
    }
    const audio = this.audio;
    this.audio = null;
    if (audio) {
      audio.onCapture = null;
      audio.onState = null;
      audio.onMicLost = null;
      void audio.close();
    }
  }

  private sendFrame(frame: VoiceBrowserFrame): void {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private sendBinary(frame: ArrayBuffer): void {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(frame);
    }
  }
}
