import type { VoiceBrowserFrame } from "@agentforge/core/voice";
import { describe, expect, it } from "vitest";
import { BARGE_RESUME_TIMEOUT_MS, BargeCoordinator, type BargeEffects } from "./voice-barge";
import { BargeDetector } from "./voice-barge-detector";

const WINDOW_MS = 20;

type Timer = { run: () => void; ms: number; cleared: boolean };

function setup(options: { playing?: boolean; pauseMs?: number; dropMs?: number } = {}) {
  const log: string[] = [];
  const sent: VoiceBrowserFrame[] = [];
  const timers: Timer[] = [];
  const state = { playing: options.playing ?? true };
  const effects: BargeEffects = {
    pausePlayback: () => {
      log.push("pause");
      return options.pauseMs ?? 1234;
    },
    resumePlayback: () => log.push("resume"),
    dropPlayback: () => {
      log.push("drop");
      return options.dropMs ?? 1100;
    },
    send: (frame) => {
      sent.push(frame);
      log.push(frame.type === "played" ? `send:played:${frame.ms}` : `send:${frame.type}`);
    },
    agentAudioPlaying: () => state.playing,
    setTimer: (run, ms) => {
      const timer: Timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).cleared = true;
    },
  };
  const detector = new BargeDetector();
  const coordinator = new BargeCoordinator(effects, detector);
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  };
  /** A quiet room, learned, then `loudWindows` windows of speech. */
  const speak = (loudWindows = 10) => {
    for (let i = 0; i < 40; i += 1) {
      coordinator.onLevel(0.002, WINDOW_MS);
    }
    for (let i = 0; i < loudWindows; i += 1) {
      coordinator.onLevel(0.1, WINDOW_MS);
    }
  };
  return { coordinator, detector, log, sent, timers, state, settle, speak };
}

describe("cutting in: speech over the agent", () => {
  it("pauses playback at once, sends barge_in, then played with what was heard", async () => {
    const { speak, settle, log } = setup();
    speak();
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234"]);
  });

  it("waits for the host: a timer of 3 s is set, and the coordinator says a pause is pending", async () => {
    const { speak, settle, timers, coordinator } = setup();
    speak();
    await settle();
    expect(BARGE_RESUME_TIMEOUT_MS).toBe(3000);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(3000);
    expect(coordinator.pending).toBe(true);
  });

  it("does nothing while the agent is not speaking", async () => {
    const { speak, settle, log, state } = setup({ playing: false });
    state.playing = false;
    speak();
    await settle();
    expect(log).toEqual([]);
  });

  it("pauses only once for one burst of speech", async () => {
    const { speak, settle, log, coordinator } = setup();
    speak(10);
    await settle();
    for (let i = 0; i < 50; i += 1) {
      coordinator.onLevel(0.1, WINDOW_MS);
    }
    await settle();
    expect(log.filter((entry) => entry === "pause")).toHaveLength(1);
  });

  it("is not tripped by a click or by steady noise", async () => {
    const { coordinator, settle, log } = setup();
    for (let i = 0; i < 40; i += 1) {
      coordinator.onLevel(0.002, WINDOW_MS);
    }
    coordinator.onLevel(0.7, WINDOW_MS);
    for (let i = 0; i < 40; i += 1) {
      coordinator.onLevel(0.002, WINDOW_MS);
    }
    await settle();
    expect(log).toEqual([]);
  });

  it("pauses when the agent starts speaking while the person already is", async () => {
    const { coordinator, speak, settle, log, state } = setup();
    state.playing = false;
    speak(10);
    await settle();
    expect(log).toEqual([]);
    state.playing = true;
    coordinator.onLevel(0.1, WINDOW_MS);
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234"]);
  });
});

describe("the host's answer", () => {
  it("resume_audio resumes playback and ends the wait", async () => {
    const { speak, settle, log, coordinator, timers } = setup();
    speak();
    await settle();
    coordinator.onHostFrame({ type: "resume_audio" });
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234", "resume"]);
    expect(coordinator.pending).toBe(false);
    expect(timers[0]?.cleared).toBe(true);
  });

  it("stop_audio drops the queue and sends played again", async () => {
    const { speak, settle, log, coordinator, timers } = setup({ dropMs: 1180 });
    speak();
    await settle();
    coordinator.onHostFrame({ type: "stop_audio" });
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234", "drop", "send:played:1180"]);
    expect(coordinator.pending).toBe(false);
    expect(timers[0]?.cleared).toBe(true);
    expect(log).not.toContain("resume");
  });

  it("neither within 3 s: resumes by itself, and sends nothing more", async () => {
    const { speak, settle, log, timers, coordinator } = setup();
    speak();
    await settle();
    timers[0]?.run();
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234", "resume"]);
    expect(coordinator.pending).toBe(false);
  });

  it("a late timer after the host answered does nothing", async () => {
    const { speak, settle, log, timers, coordinator } = setup();
    speak();
    await settle();
    coordinator.onHostFrame({ type: "stop_audio" });
    await settle();
    timers[0]?.run();
    await settle();
    expect(log.filter((entry) => entry === "resume")).toEqual([]);
  });

  it("obeys a stop_audio the browser did not ask for: the host heard an interruption first", async () => {
    const { settle, log, coordinator } = setup({ dropMs: 800 });
    coordinator.onHostFrame({ type: "stop_audio" });
    await settle();
    expect(log).toEqual(["drop", "send:played:800"]);
  });

  it("ignores frames that are not for it", async () => {
    const { settle, log, coordinator } = setup();
    coordinator.onHostFrame({ type: "saved" });
    coordinator.onHostFrame({ type: "state", value: "speaking" });
    await settle();
    expect(log).toEqual([]);
  });

  it("does not let a host frame overtake the pause it answers", async () => {
    const { speak, coordinator, log, settle } = setup();
    speak();
    // The answer arrives in the same breath as the pause, before the played report was sent.
    coordinator.onHostFrame({ type: "resume_audio" });
    await settle();
    expect(log.indexOf("send:played:1234")).toBeLessThan(log.indexOf("resume"));
  });

  it("a second burst after the host said to resume pauses again", async () => {
    const { speak, settle, log, coordinator } = setup();
    speak(10);
    await settle();
    coordinator.onHostFrame({ type: "resume_audio" });
    await settle();
    for (let i = 0; i < 20; i += 1) {
      coordinator.onLevel(0.002, WINDOW_MS); // quiet long enough to end the burst
    }
    for (let i = 0; i < 10; i += 1) {
      coordinator.onLevel(0.1, WINDOW_MS);
    }
    await settle();
    expect(log.filter((entry) => entry === "pause")).toHaveLength(2);
  });
});

describe("push-to-talk pressed over the agent", () => {
  it("is the same pause without a loudness guess", async () => {
    const { coordinator, settle, log } = setup();
    coordinator.onHoldStart();
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "send:played:1234"]);
  });

  it("does nothing when the agent is quiet", async () => {
    const { coordinator, settle, log, state } = setup();
    state.playing = false;
    coordinator.onHoldStart();
    await settle();
    expect(log).toEqual([]);
  });
});

describe("after dispose", () => {
  it("sends nothing and clears the timer", async () => {
    const { speak, settle, log, coordinator, timers } = setup();
    speak();
    coordinator.dispose();
    await settle();
    expect(timers[0]?.cleared).toBe(true);
    coordinator.onHostFrame({ type: "stop_audio" });
    await settle();
    expect(log).not.toContain("drop");
  });
});

describe("explicit interruptNow", () => {
  it("pauses, sends immediate barge_in, drops playback, and reports played ms", async () => {
    const { coordinator, settle, log } = setup({ pauseMs: 420 });
    coordinator.interruptNow();
    await settle();
    expect(log).toEqual(["pause", "send:barge_in", "drop", "send:played:420"]);
    expect(coordinator.pending).toBe(false);
  });
});
