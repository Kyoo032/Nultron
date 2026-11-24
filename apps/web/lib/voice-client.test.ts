import type { VoiceBrowserFrame, VoiceHostFrame, VoiceMode } from "@agentforge/core/voice";
import { describe, expect, it } from "vitest";
import type { VoiceAudioLike } from "./voice-audio";
import { SOCKET_OPEN_TIMEOUT_MS, type VoiceClientDeps, VoiceClient, type VoiceSocketLike } from "./voice-client";
import { PlaybackQueue } from "./voice-playback-core";
import type { OpenVoiceSessionResult } from "./voice-session-api";
import type { VoiceViewAction } from "./voice-view-state";

class FakeAudio implements VoiceAudioLike {
  onCapture: ((frames: ArrayBuffer[], levels: number[]) => void) | null = null;
  onState: ((state: string) => void) | null = null;
  onMicLost: (() => void) | null = null;
  state = "running";
  startError: unknown = null;
  /** Holds `start` open, like a permission prompt nobody has answered yet. */
  startGate: Promise<void> | null = null;
  /** Holds `flushCapture` open until the worklet acknowledges the final frame. */
  flushGate: Promise<void> | null = null;
  started = false;
  /** Everything a closed `AudioContext` and stopped tracks add up to: nothing left running. */
  closed = false;
  pushed: ArrayBuffer[] = [];
  endTurns = 0;
  flushes = 0;
  resets = 0;
  pauses = 0;
  resumes = 0;
  drops = 0;
  playing = false;

  async start() {
    await this.startGate;
    if (this.startError) {
      throw this.startError;
    }
    this.started = true;
  }
  pushAgentAudio(pcm: ArrayBuffer) {
    this.pushed.push(pcm);
  }
  agentAudioPlaying() {
    return this.playing;
  }
  async pausePlayback() {
    this.pauses += 1;
    return 500;
  }
  resumePlayback() {
    this.resumes += 1;
  }
  async dropPlayback() {
    this.drops += 1;
    return 400;
  }
  endAgentTurn() {
    this.endTurns += 1;
  }
  async flushCapture() {
    this.flushes += 1;
    if (this.flushGate) await this.flushGate;
    // What the worklet does: the padded remainder goes out through the capture path before it answers.
    this.onCapture?.([new ArrayBuffer(1920)], []);
  }
  resetCapture() {
    this.resets += 1;
  }
  async close() {
    this.closed = true;
  }
}

class FakeSocket implements VoiceSocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  closedWith: number | null = null;

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  serverCloses() {
    this.readyState = 3;
    this.onclose?.();
  }
  /** The JSON frames sent, in order. */
  frames(): VoiceBrowserFrame[] {
    return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
  }
  binary(): ArrayBuffer[] {
    return this.sent.filter((item): item is ArrayBuffer => typeof item !== "string");
  }
}

type Timer = { run: () => void; ms: number; cleared: boolean };

const SESSION = {
  sessionId: "sess-abcdef12",
  threadId: "thread-1",
  model: "m",
  streamPath: "/api/v1/voice/sessions/sess-abcdef12/stream",
  endsAt: 1,
};

function harness(
  options: {
    mode?: VoiceMode;
    secureContext?: boolean;
    supported?: Partial<VoiceClientDeps["supported"]>;
    open?: OpenVoiceSessionResult;
    ensureThread?: () => Promise<string>;
    createAudioThrows?: boolean;
  } = {},
) {
  const audio = new FakeAudio();
  const socket = new FakeSocket();
  const actions: VoiceViewAction[] = [];
  const timers: Timer[] = [];
  const log = { audioCreated: 0, sessionRequests: [] as Array<{ threadId: string; mode: VoiceMode }>, path: "" };
  const levelsSeen: number[] = [];
  const watch = { run: null as (() => void) | null, stopped: false };
  const deps: VoiceClientDeps = {
    secureContext: options.secureContext ?? true,
    supported: { webSocket: true, getUserMedia: true, audioWorklet: true, ...options.supported },
    createAudio: () => {
      log.audioCreated += 1;
      if (options.createAudioThrows) {
        throw new Error("no AudioContext");
      }
      return audio;
    },
    openSession: async (threadId, mode) => {
      log.sessionRequests.push({ threadId, mode });
      return options.open ?? { ok: true, session: SESSION };
    },
    createSocket: (streamPath) => {
      log.path = streamPath;
      return socket;
    },
    watchBackground: (run) => {
      watch.run = run;
      return () => {
        watch.stopped = true;
      };
    },
    setTimer: (run, ms) => {
      const timer: Timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
  };
  const client = new VoiceClient({
    deps,
    mode: options.mode ?? "hands_free",
    ensureThread: options.ensureThread ?? (async () => "thread-1"),
    emit: (action) => actions.push(action),
    onLevel: (level) => levelsSeen.push(level),
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  };
  /** Starts, lets the socket open, and has the host say `ready`. */
  const goLive = async () => {
    const started = client.start();
    await settle();
    socket.open();
    await started;
    host({ type: "ready", sessionId: SESSION.sessionId, threadId: SESSION.threadId, endsAt: 1 });
  };
  const host = (frame: VoiceHostFrame) => socket.receive(JSON.stringify(frame));
  return { client, audio, socket, actions, timers, log, levelsSeen, watch, deps, settle, goLive, host };
}

const failed = (actions: VoiceViewAction[]) => actions.filter((action) => action.type === "failed");

describe("starting", () => {
  it("fails on a page that is not secure, and opens nothing", async () => {
    const { client, actions, log } = harness({ secureContext: false });
    await client.start();
    expect(actions).toEqual([{ type: "failed", code: "insecure" }]);
    expect(log.audioCreated).toBe(0);
  });

  it.each(["webSocket", "getUserMedia", "audioWorklet"] as const)(
    "fails when the browser has no %s",
    async (missing) => {
      const { client, actions, log } = harness({ supported: { [missing]: false } });
      await client.start();
      expect(actions).toEqual([{ type: "failed", code: "unsupported" }]);
      expect(log.audioCreated).toBe(0);
    },
  );

  it("fails as unsupported when the audio cannot be made at all", async () => {
    const { client, actions } = harness({ createAudioThrows: true });
    await client.start();
    expect(actions).toEqual([{ type: "failed", code: "unsupported" }]);
  });

  it("makes the audio before it awaits anything, which is what Safari needs from a tap", () => {
    const { client, log } = harness();
    void client.start();
    expect(log.audioCreated).toBe(1);
  });

  it("fails with `thread` when there is no thread to save to, and lets the audio go", async () => {
    const { client, actions, audio, log } = harness({
      ensureThread: async () => {
        throw new Error("could not create");
      },
    });
    await client.start();
    expect(actions).toEqual([{ type: "failed", code: "thread" }]);
    expect(audio.closed).toBe(true);
    expect(log.sessionRequests).toEqual([]);
  });

  it.each([
    ["NotAllowedError", "micDenied"],
    ["NotFoundError", "micMissing"],
    ["NotReadableError", "micBusy"],
  ])("fails with the right line when the microphone throws %s, and asks the host for nothing", async (name, code) => {
    const { client, actions, audio, log } = harness();
    audio.startError = Object.assign(new Error(name), { name });
    await client.start();
    expect(actions).toEqual([{ type: "failed", code }]);
    expect(audio.closed).toBe(true);
    expect(log.sessionRequests).toEqual([]);
  });

  it("asks for the microphone before it asks the host, so a slow permission prompt cannot outlast the session", async () => {
    const { client, audio, log, settle } = harness();
    let answer!: () => void;
    audio.startGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const started = client.start();
    await settle();
    // The permission prompt is still open: the host has not been asked for a session yet.
    expect(log.sessionRequests).toEqual([]);
    answer();
    await settle();
    expect(log.sessionRequests).toHaveLength(1);
    client.stop();
    await started;
  });

  it.each([
    ["voice_disabled"],
    ["gateway_blocked"],
    ["voice_session_limit"],
    ["voice_model_unavailable"],
    ["connect"],
  ] as const)("fails with the host's refusal %s, and releases the microphone it just opened", async (code) => {
    const { client, actions, audio, log } = harness({ open: { ok: false, code } });
    await client.start();
    expect(actions).toEqual([{ type: "failed", code }]);
    expect(audio.closed).toBe(true);
    expect(log.path).toBe("");
  });

  it("passes the thread and the mode to H1, and opens the stream path it was given", async () => {
    const { goLive, log } = harness({ mode: "push_to_talk" });
    await goLive();
    expect(log.sessionRequests).toEqual([{ threadId: "thread-1", mode: "push_to_talk" }]);
    expect(log.path).toBe(SESSION.streamPath);
  });

  it("asks for binary frames as an ArrayBuffer", async () => {
    const { goLive, socket } = harness();
    await goLive();
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("fails with `connect` when the socket never opens, and lets everything go", async () => {
    const { client, actions, audio, socket, timers, settle } = harness();
    const started = client.start();
    await settle();
    const timeout = timers.find((timer) => timer.ms === SOCKET_OPEN_TIMEOUT_MS);
    expect(timeout).toBeDefined();
    timeout?.run();
    await started;
    expect(actions).toEqual([{ type: "failed", code: "connect" }]);
    expect(audio.closed).toBe(true);
    expect(socket.closedWith).toBe(1000);
  });

  it("fails with `connect` when the socket errors while opening", async () => {
    const { client, actions, socket, settle } = harness();
    const started = client.start();
    await settle();
    socket.onerror?.();
    await started;
    expect(actions).toEqual([{ type: "failed", code: "connect" }]);
  });

  it("a stop while the socket is still opening ends cleanly and says nothing to the view", async () => {
    const { client, actions, audio, socket, settle } = harness();
    const started = client.start();
    await settle();
    client.stop();
    await started;
    expect(actions).toEqual([]);
    expect(audio.closed).toBe(true);
    expect(socket.closedWith).toBe(1000);
  });

  it("a stop while the microphone prompt is open lets the audio go", async () => {
    const { client, audio, log, settle } = harness();
    const started = client.start();
    client.stop();
    await settle();
    await started;
    expect(audio.closed).toBe(true);
    expect(log.sessionRequests).toEqual([]);
  });
});

describe("a live session", () => {
  it("passes the host's frames to the view, and ignores `metrics`", async () => {
    const { goLive, host, actions } = harness();
    await goLive();
    host({ type: "state", value: "listening" });
    host({ type: "caption", role: "user", id: "u1", text: "hi", final: true });
    host({ type: "saved" });
    host({ type: "metrics", speechEndToFirstAudioMs: 1000, talkerFirstAudioMs: 800, transcribeMs: 100 });
    expect(actions.map((action) => (action.type === "frame" ? action.frame.type : action.type))).toEqual([
      "ready",
      "state",
      "caption",
      "saved",
    ]);
  });

  it("drops a text frame it cannot parse, and one with a shape it does not know", async () => {
    const { goLive, socket, actions } = harness();
    await goLive();
    const before = actions.length;
    socket.receive("not json");
    socket.receive(JSON.stringify({ type: "teapot" }));
    socket.receive(JSON.stringify({ type: "state", value: "dancing" }));
    expect(actions).toHaveLength(before);
  });

  it("plays the agent's binary frames, and starts a new turn's count at `listening`", async () => {
    const { goLive, socket, audio, host } = harness();
    await goLive();
    const pcm = new ArrayBuffer(4800);
    socket.receive(pcm);
    expect(audio.pushed).toEqual([pcm]);
    host({ type: "state", value: "speaking" });
    expect(audio.endTurns).toBe(0);
    host({ type: "state", value: "listening" });
    expect(audio.endTurns).toBe(1);
  });

  it("sends no microphone audio until the host says `ready`", async () => {
    const { client, audio, socket, settle } = harness();
    const started = client.start();
    await settle();
    socket.open();
    await started;
    audio.onCapture?.([new ArrayBuffer(1920)], [0.1]);
    expect(socket.binary()).toHaveLength(0);
    socket.receive(JSON.stringify({ type: "ready", sessionId: "sess-abcdef12", threadId: "t", endsAt: 1 }));
    audio.onCapture?.([new ArrayBuffer(1920)], [0.1]);
    expect(socket.binary()).toHaveLength(1);
  });

  it("in hands-free, sends every frame, the whole time, whatever state the agent is in", async () => {
    const { goLive, audio, socket, host } = harness();
    await goLive();
    for (const value of ["listening", "hearing", "thinking", "speaking"] as const) {
      host({ type: "state", value });
      audio.onCapture?.([new ArrayBuffer(1920)], []);
    }
    expect(socket.binary()).toHaveLength(4);
    expect(socket.binary().every((frame) => frame.byteLength === 1920)).toBe(true);
  });

  it("sends the frames in the order they were captured", async () => {
    const { goLive, audio, socket } = harness();
    await goLive();
    const a = new Uint8Array(1920).fill(1).buffer;
    const b = new Uint8Array(1920).fill(2).buffer;
    audio.onCapture?.([a, b], []);
    expect(socket.binary()).toEqual([a, b]);
  });

  it("stop() tells the host, closes the socket, stops listening for the screen, and lets the audio go", async () => {
    const { client, goLive, socket, audio, watch } = harness();
    await goLive();
    client.stop();
    expect(socket.frames()).toEqual([{ type: "stop" }]);
    expect(socket.closedWith).toBe(1000);
    expect(audio.closed).toBe(true);
    expect(watch.stopped).toBe(true);
  });

  it("sends nothing after stop(), and stop() twice is one stop", async () => {
    const { client, goLive, socket, audio } = harness();
    await goLive();
    client.stop();
    client.stop();
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    socket.receive(JSON.stringify({ type: "state", value: "speaking" }));
    expect(socket.frames()).toEqual([{ type: "stop" }]);
    expect(socket.binary()).toHaveLength(0);
  });

  it("an `ended` frame is shown and ends the session: nothing is left open, and no stop is sent back", async () => {
    const { goLive, host, actions, socket, audio } = harness();
    await goLive();
    host({ type: "ended", reason: "idle" });
    expect(actions.at(-1)).toEqual({ type: "frame", frame: { type: "ended", reason: "idle" } });
    expect(audio.closed).toBe(true);
    expect(socket.closedWith).toBe(1000);
    expect(socket.frames()).toEqual([]);
  });

  it("a socket that closes with no word is `dropped`, and the audio is let go", async () => {
    const { goLive, socket, actions, audio } = harness();
    await goLive();
    socket.serverCloses();
    expect(actions.at(-1)).toEqual({ type: "dropped" });
    expect(audio.closed).toBe(true);
  });

  it("a socket that closes after `ended` does not also say `dropped`", async () => {
    const { goLive, host, socket, actions } = harness();
    await goLive();
    host({ type: "ended", reason: "replaced" });
    socket.serverCloses();
    expect(actions.filter((action) => action.type === "dropped")).toEqual([]);
  });

  it("a microphone that is taken away is `micBusy`, and everything is let go", async () => {
    const { goLive, audio, actions } = harness();
    await goLive();
    audio.onMicLost?.();
    expect(failed(actions)).toEqual([{ type: "failed", code: "micBusy" }]);
    expect(audio.closed).toBe(true);
  });
});

describe("the screen going away", () => {
  it("a locked screen or a hidden tab on a phone: stop is sent, the microphone is released, the view is told", async () => {
    const { goLive, watch, actions, socket, audio } = harness();
    await goLive();
    watch.run?.();
    expect(actions.at(-1)).toEqual({ type: "backgrounded" });
    expect(socket.frames()).toEqual([{ type: "stop" }]);
    expect(audio.closed).toBe(true);
    expect(socket.closedWith).toBe(1000);
  });

  it("an AudioContext that goes suspended after it was running does the same", async () => {
    const { goLive, audio, actions, socket } = harness();
    await goLive();
    audio.onState?.("suspended");
    expect(actions.at(-1)).toEqual({ type: "backgrounded" });
    expect(socket.frames()).toEqual([{ type: "stop" }]);
    expect(audio.closed).toBe(true);
  });

  it("so does `interrupted`, which is what Safari says", async () => {
    const { goLive, audio, actions } = harness();
    await goLive();
    audio.onState?.("interrupted");
    expect(actions.at(-1)).toEqual({ type: "backgrounded" });
  });

  it("a context that never ran (a browser that wants a fresh tap) is the same notice, not a silent session", async () => {
    const { client, audio, actions, settle, socket } = harness();
    audio.state = "suspended";
    const started = client.start();
    await settle();
    socket.open();
    await started;
    expect(actions.at(-1)).toEqual({ type: "backgrounded" });
    expect(audio.closed).toBe(true);
  });

  it("a context that is still running tells nobody anything", async () => {
    const { goLive, audio, actions } = harness();
    await goLive();
    const before = actions.length;
    audio.onState?.("running");
    expect(actions).toHaveLength(before);
  });
});

describe("push-to-talk", () => {
  it.each<[VoiceMode, VoiceMode]>([
    ["push_to_talk", "hands_free"],
    ["hands_free", "push_to_talk"],
  ])("switches from %s to %s on the host if the choice changes while connecting", async (initialMode, nextMode) => {
    const { client, audio, socket, log, host, settle } = harness({ mode: initialMode });
    const started = client.start();
    await settle();
    expect(log.sessionRequests).toEqual([{ threadId: "thread-1", mode: initialMode }]);
    client.setMode(nextMode);
    socket.open();
    await started;
    expect(socket.sent).toEqual([]);

    host({ type: "ready", sessionId: SESSION.sessionId, threadId: SESSION.threadId, endsAt: 1 });
    const pcm = new ArrayBuffer(1920);
    audio.onCapture?.([pcm], []);

    expect(socket.frames()).toEqual([{ type: "mode", value: nextMode }]);
    expect(socket.binary()).toEqual(nextMode === "hands_free" ? [pcm] : []);
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "mode", value: nextMode }));
  });

  it("does not resend the starting mode if it has not changed", async () => {
    const { goLive, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    expect(socket.frames()).toEqual([]);
  });

  it("sends no audio unless the button is held", async () => {
    const { goLive, audio, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    expect(socket.binary()).toHaveLength(0);
  });

  it("sends frames while held, then the last partial frame, then commit", async () => {
    const { client, goLive, audio, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    client.holdStart();
    expect(audio.resets).toBe(1);
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    await client.holdEnd();
    expect(audio.flushes).toBe(1);
    // Two held frames and the flushed remainder, and only then the commit.
    expect(socket.binary()).toHaveLength(3);
    expect(socket.frames().at(-1)).toEqual({ type: "commit" });
    // After release, nothing more goes out.
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    expect(socket.binary()).toHaveLength(3);
  });

  it("sends just one commit if release is reported twice before the worklet answers", async () => {
    const { client, goLive, audio, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    const flush = Promise.withResolvers<void>();
    audio.flushGate = flush.promise;
    client.holdStart();
    const firstRelease = client.holdEnd();
    const secondRelease = client.holdEnd();
    flush.resolve();
    await Promise.all([firstRelease, secondRelease]);

    expect(socket.binary()).toHaveLength(1);
    expect(socket.frames()).toEqual([{ type: "commit" }]);
  });

  it("does not commit a push-to-talk turn after switching to hands-free during release", async () => {
    const { client, goLive, audio, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    const flush = Promise.withResolvers<void>();
    audio.flushGate = flush.promise;
    client.holdStart();
    const released = client.holdEnd();
    client.setMode("hands_free");
    flush.resolve();
    await released;

    expect(socket.frames()).toEqual([{ type: "mode", value: "hands_free" }]);
  });

  it("commits on every release, not just the first", async () => {
    const { client, goLive, socket } = harness({ mode: "push_to_talk" });
    await goLive();
    for (let turn = 0; turn < 3; turn += 1) {
      client.holdStart();
      await client.holdEnd();
    }
    expect(socket.frames().filter((frame) => frame.type === "commit")).toHaveLength(3);
  });

  it("a release with no press does nothing, and a press in hands-free does nothing", async () => {
    const hands = harness();
    await hands.goLive();
    hands.client.holdStart();
    await hands.client.holdEnd();
    expect(hands.socket.frames()).toEqual([]);

    const ptt = harness({ mode: "push_to_talk" });
    await ptt.goLive();
    await ptt.client.holdEnd();
    expect(ptt.socket.frames().filter((frame) => frame.type === "commit")).toEqual([]);
  });

  it("switching the mode live tells the host and the view, and changes what is sent", async () => {
    const { client, goLive, audio, socket, actions } = harness();
    await goLive();
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    expect(socket.binary()).toHaveLength(1);
    client.setMode("push_to_talk");
    expect(socket.frames().at(-1)).toEqual({ type: "mode", value: "push_to_talk" });
    expect(actions.at(-1)).toEqual({ type: "mode", value: "push_to_talk" });
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    expect(socket.binary()).toHaveLength(1);
    client.setMode("hands_free");
    audio.onCapture?.([new ArrayBuffer(1920)], []);
    expect(socket.binary()).toHaveLength(2);
  });

  it("pressing the button over the agent is a cut-in", async () => {
    const { client, goLive, audio, socket, settle } = harness({ mode: "push_to_talk" });
    await goLive();
    audio.playing = true;
    client.holdStart();
    await settle();
    expect(audio.pauses).toBe(1);
    expect(socket.frames().map((frame) => frame.type)).toEqual(["barge_in", "played"]);
  });

  it("does not guess a cut-in from loudness: the button is the signal", async () => {
    const { goLive, audio, settle } = harness({ mode: "push_to_talk" });
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([], [0.2]);
    }
    await settle();
    expect(audio.pauses).toBe(0);
  });
});

describe("cutting in, hands-free", () => {
  it("speech over the agent pauses playback, sends barge_in, then played", async () => {
    const { goLive, audio, socket, settle } = harness();
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([], [0.2]);
    }
    await settle();
    expect(audio.pauses).toBe(1);
    expect(socket.frames()).toEqual([{ type: "barge_in" }, { type: "played", ms: 500 }]);
  });

  it("then obeys the host: stop_audio drops the queue and reports again", async () => {
    const { goLive, audio, socket, host, settle } = harness();
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([], [0.2]);
    }
    await settle();
    host({ type: "stop_audio" });
    await settle();
    expect(audio.drops).toBe(1);
    expect(socket.frames().at(-1)).toEqual({ type: "played", ms: 400 });
  });

  it("or resume_audio resumes it", async () => {
    const { goLive, audio, host, settle } = harness();
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([], [0.2]);
    }
    await settle();
    host({ type: "resume_audio" });
    await settle();
    expect(audio.resumes).toBe(1);
  });

  it("keeps sending the microphone's audio through all of it, so nothing said is lost", async () => {
    const { goLive, audio, socket, settle } = harness();
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([new ArrayBuffer(1920)], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([new ArrayBuffer(1920)], [0.2]);
    }
    await settle();
    expect(socket.binary()).toHaveLength(50);
  });

  it("resumes by itself when the host never answers, after 3 s", async () => {
    const { goLive, audio, timers, settle } = harness();
    await goLive();
    audio.playing = true;
    for (let i = 0; i < 40; i += 1) {
      audio.onCapture?.([], [0.002]);
    }
    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([], [0.2]);
    }
    await settle();
    const wait = timers.find((timer) => timer.ms === 3000);
    expect(wait).toBeDefined();
    wait?.run();
    await settle();
    expect(audio.resumes).toBe(1);
  });

  it("multi-turn barge-in with PlaybackQueue unpauses on drop() and renders subsequent agent audio", async () => {
    const queue = new PlaybackQueue();
    const h = harness();
    h.audio.pushAgentAudio = (pcm) => {
      const i16 = new Int16Array(pcm);
      const f32 = Float32Array.from(i16, (v) => v / 32768);
      queue.enqueue(f32);
    };
    h.audio.agentAudioPlaying = () => queue.playing;
    h.audio.pausePlayback = async () => {
      h.audio.pauses += 1;
      queue.pause();
      return Math.round(queue.playedMs);
    };
    h.audio.resumePlayback = () => {
      h.audio.resumes += 1;
      queue.resume();
    };
    h.audio.dropPlayback = async () => {
      h.audio.drops += 1;
      queue.drop();
      return Math.round(queue.playedMs);
    };
    h.audio.endAgentTurn = () => {
      h.audio.endTurns += 1;
      queue.endTurn();
    };

    await h.goLive();
    const tone1 = new Int16Array(2400).fill(5000).buffer;
    h.socket.receive(tone1);
    expect(queue.playing).toBe(true);
    queue.render(new Float32Array(240));

    // User barges in -> pause() -> host stop_audio -> drop().
    for (let i = 0; i < 40; i += 1) h.audio.onCapture?.([], [0.002]);
    for (let i = 0; i < 10; i += 1) h.audio.onCapture?.([], [0.2]);
    await h.settle();
    h.host({ type: "stop_audio" });
    await h.settle();
    h.host({ type: "state", value: "listening" });
    expect(queue.paused).toBe(false);

    // Turn 2: agent sends audio again -> must play and NOT stay muted!
    const tone2 = new Int16Array(1200).fill(7000).buffer;
    h.socket.receive(tone2);
    expect(h.audio.agentAudioPlaying()).toBe(true);
    const out = new Float32Array(128);
    expect(queue.render(out)).toBe(128);
    expect(out[0]).toBeGreaterThan(0);
  });
});

describe("interactive controls and visualizer levels", () => {
  it("forwards smoothed 20 ms mic levels in both hands-free and push-to-talk", async () => {
    const hf = harness({ mode: "hands_free" });
    await hf.goLive();
    hf.audio.onCapture?.([new ArrayBuffer(1920)], [0.1]);
    expect(hf.levelsSeen.at(-1)).toBeGreaterThan(0);

    const ptt = harness({ mode: "push_to_talk" });
    await ptt.goLive();
    ptt.audio.onCapture?.([new ArrayBuffer(1920)], [0.1]);
    expect(ptt.levelsSeen.at(-1)).toBeGreaterThan(0);
    // Still does not send binary frames unless holding.
    expect(ptt.socket.binary()).toHaveLength(0);
  });

  it("suppresses outgoing mic PCM and barge detection locally when muted without dropping the socket", async () => {
    const { client, goLive, audio, socket, actions, levelsSeen, settle } = harness();
    await goLive();
    audio.playing = true;
    client.setMuted(true);
    expect(actions.at(-1)).toEqual({ type: "muted", value: true });

    for (let i = 0; i < 10; i += 1) {
      audio.onCapture?.([new ArrayBuffer(1920)], [0.2]);
    }
    await settle();
    expect(socket.binary()).toHaveLength(0);
    expect(audio.pauses).toBe(0);
    expect(levelsSeen.at(-1)).toBe(0);

    client.setMuted(false);
    audio.onCapture?.([new ArrayBuffer(1920)], [0.1]);
    expect(socket.binary()).toHaveLength(1);
    expect(socket.closedWith).toBeNull();
  });

  it("interrupt() drops playback and sends immediate barge_in + played, and commit() sends commit", async () => {
    const { client, goLive, audio, socket, settle } = harness();
    await goLive();
    audio.playing = true;
    client.interrupt();
    await settle();
    expect(audio.pauses).toBe(1);
    expect(audio.drops).toBe(1);
    expect(socket.frames()).toEqual([
      { type: "barge_in", immediate: true },
      { type: "played", ms: 500 },
    ]);

    client.commit();
    expect(socket.frames().at(-1)).toEqual({ type: "commit" });
  });
});
