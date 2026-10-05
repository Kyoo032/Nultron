import { describe, expect, it } from "vitest";
import {
  BODY_GAP,
  BODY_MAX,
  BODY_MIN,
  BUDDY_NEXT,
  BUDDY_PRIORITY,
  bodySize,
  buddyView,
  CHIP_SIZE,
  pickClaim,
  restingState,
  runReaction,
  TAP_REACTIONS,
  tapReaction,
} from "./desk-buddy-state";
import { MASCOT_STATES, STATE_MOTION } from "./mascot-states";

const room = { present: true, suppressed: false, minimised: false, slackPx: 200, widthPx: 220 };

describe("pickClaim", () => {
  it("is null with nothing claimed", () => {
    expect(pickClaim([])).toBeNull();
  });

  it("lets the loudest claim speak, and the newest among equals", () => {
    const rows = [
      { state: "thinking", busy: true, priority: BUDDY_PRIORITY.job, seq: 1 },
      { state: "charging", busy: true, priority: BUDDY_PRIORITY.charging, seq: 2 },
      { state: "searching", busy: true, priority: BUDDY_PRIORITY.job, seq: 3 },
    ] as const;
    expect(pickClaim(rows)?.state).toBe("charging");
    expect(pickClaim(rows.filter((row) => row.state !== "charging"))?.state).toBe("searching");
  });

  it("takes a claim with no priority for a job", () => {
    const rows = [
      { state: "writing", seq: 1 },
      { state: "presenting", priority: BUDDY_PRIORITY.guide, seq: 2 },
    ] as const;
    expect(pickClaim(rows)?.state).toBe("writing");
  });
});

describe("restingState", () => {
  it("sleeps only for an idle window, never for a blurred or hidden one", () => {
    expect(restingState("idle")).toBe("sleep");
    expect(restingState("blurred")).toBe("idle");
    expect(restingState("hidden")).toBe("idle");
    expect(restingState(null)).toBe("idle");
  });
});

describe("tapReaction", () => {
  it("rotates love, lets-go and a cheer, and starts over", () => {
    expect([0, 1, 2, 3, 4].map(tapReaction)).toEqual(["love", "lets-go", "celebrating", "love", "lets-go"]);
  });

  it("is always a clip, never a working pose", () => {
    for (const state of TAP_REACTIONS) {
      expect(STATE_MOTION[state]).toBe("once");
    }
  });
});

describe("bodySize and buddyView", () => {
  it("gives a body only when the whole body fits, never a squeezed one", () => {
    expect(bodySize(BODY_MIN + BODY_GAP - 1, 220)).toBe(0);
    expect(bodySize(BODY_MIN + BODY_GAP, 220)).toBe(BODY_MIN);
    expect(bodySize(10_000, 220)).toBe(BODY_MAX);
  });

  it("never lets the body outgrow the list it stands in", () => {
    expect(bodySize(500, 60)).toBe(0);
    expect(bodySize(500, 112)).toBe(96);
    expect(bodySize(500, 80)).toBe(64);
  });

  it("shows a body when there is room, a chip when there is not, and nothing when it may not stand there", () => {
    expect(buddyView(room)).toEqual({ view: "body", size: BODY_MAX });
    expect(buddyView({ ...room, slackPx: 30 })).toEqual({ view: "chip", size: CHIP_SIZE });
    expect(buddyView({ ...room, slackPx: 0 })).toEqual({ view: "chip", size: CHIP_SIZE });
    expect(buddyView({ ...room, present: false }).view).toBe("none");
    expect(buddyView({ ...room, suppressed: true }).view).toBe("none");
  });

  it("goes to a chip when the person made it smaller, whatever room there is", () => {
    expect(buddyView({ ...room, minimised: true })).toEqual({ view: "chip", size: CHIP_SIZE });
  });

  it("keeps the chip at 32 px, where error and sleep can still be told apart", () => {
    expect(CHIP_SIZE).toBeGreaterThanOrEqual(32);
  });
});

describe("what the buddy can reach", () => {
  it("is a short, stable list of real states", () => {
    expect(BUDDY_NEXT.length).toBeLessThanOrEqual(6);
    for (const state of BUDDY_NEXT) {
      expect(MASCOT_STATES).toContain(state);
    }
  });
});

describe("runReaction", () => {
  const running = { running: true, failed: false };
  const idle = { running: false, failed: false };

  it("cheers when a run stops without a failure", () => {
    expect(runReaction(running, idle)).toBe("celebrating");
  });

  it("flinches the moment a failure appears, running or not", () => {
    expect(runReaction(running, { running: false, failed: true })).toBe("error");
    expect(runReaction(idle, { running: false, failed: true })).toBe("error");
    expect(runReaction(running, { running: true, failed: true })).toBe("error");
  });

  it("does not cheer a run that was cancelled or one that failed", () => {
    expect(runReaction(running, { running: false, failed: false, succeeded: false })).toBeNull();
    expect(runReaction({ running: true, failed: true }, { running: false, failed: true })).toBeNull();
  });

  it("says nothing while nothing changes", () => {
    expect(runReaction(idle, idle)).toBeNull();
    expect(runReaction(running, running)).toBeNull();
    expect(runReaction({ running: false, failed: true }, { running: false, failed: true })).toBeNull();
  });
});
