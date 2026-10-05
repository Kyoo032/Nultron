import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDDY_PRIORITY, BUDDY_RETURN_DELAY_MS, buddyView, FLASH_MS } from "./desk-buddy-state";
import {
  announceFullBody,
  announceStage,
  flashBuddy,
  getBuddySnapshot,
  mountBuddyDock,
  resetBuddyForTests,
  setBuddyClaim,
  setBuddyMinimised,
  setBuddyRoom,
  subscribeBuddy,
  tapBuddy,
} from "./desk-buddy-store";

beforeEach(() => {
  vi.useFakeTimers();
  resetBuddyForTests();
});

afterEach(() => {
  resetBuddyForTests();
  vi.useRealTimers();
});

describe("claims", () => {
  it("speaks the claim while it is made and goes quiet when it is withdrawn", () => {
    setBuddyClaim("chat", { state: "thinking", busy: true });
    expect(getBuddySnapshot()).toMatchObject({ state: "thinking", busy: true });
    setBuddyClaim("chat", null);
    expect(getBuddySnapshot()).toMatchObject({ state: null, busy: false });
  });

  it("lets a louder claim win and gives way again when it leaves", () => {
    setBuddyClaim("job", { state: "writing", busy: true, priority: BUDDY_PRIORITY.job });
    setBuddyClaim("update", { state: "charging", busy: true, priority: BUDDY_PRIORITY.charging });
    expect(getBuddySnapshot().state).toBe("charging");
    setBuddyClaim("update", null);
    expect(getBuddySnapshot().state).toBe("writing");
  });

  it("does not wake a listener for a claim that changed nothing", () => {
    const listener = vi.fn();
    subscribeBuddy(listener);
    setBuddyClaim("job", { state: "writing", busy: true });
    setBuddyClaim("job", { state: "writing", busy: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("flashes", () => {
  it("speak over a claim for their length and then let go", () => {
    setBuddyClaim("job", { state: "writing", busy: true });
    flashBuddy("celebrating");
    expect(getBuddySnapshot()).toMatchObject({ state: "celebrating", busy: false });
    vi.advanceTimersByTime(FLASH_MS);
    expect(getBuddySnapshot()).toMatchObject({ state: "writing", busy: true });
  });

  it("a second flash restarts the clock instead of being cut short by the first", () => {
    flashBuddy("error", 1000);
    vi.advanceTimersByTime(800);
    flashBuddy("surprised", 1000);
    vi.advanceTimersByTime(800);
    expect(getBuddySnapshot().state).toBe("surprised");
    vi.advanceTimersByTime(300);
    expect(getBuddySnapshot().state).toBeNull();
  });

  it("turns a tap into love, then lets-go, then a cheer", () => {
    expect(tapBuddy()).toBe("love");
    expect(tapBuddy()).toBe("lets-go");
    expect(tapBuddy()).toBe("celebrating");
    expect(getBuddySnapshot().state).toBe("celebrating");
  });
});

describe("where the buddy may stand", () => {
  it("is present only while a dock is mounted, and counts docks so a remount hands over without a gap", () => {
    expect(getBuddySnapshot().present).toBe(false);
    const first = mountBuddyDock();
    const second = mountBuddyDock();
    first();
    expect(getBuddySnapshot().present).toBe(true);
    second();
    expect(getBuddySnapshot().present).toBe(false);
    second();
    expect(getBuddySnapshot().present).toBe(false);
  });

  it("waits a moment for a character arriving with the page before it steps in", () => {
    mountBuddyDock();
    expect(getBuddySnapshot().suppressed).toBe(true);
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    expect(getBuddySnapshot().suppressed).toBe(false);
  });

  it("stands down at once for another full body and returns after a short wait when it leaves", () => {
    mountBuddyDock();
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    announceFullBody("hero", true);
    expect(getBuddySnapshot()).toMatchObject({ suppressed: true, takesStatus: false });
    announceFullBody("hero", false);
    expect(getBuddySnapshot().suppressed).toBe(true);
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    expect(getBuddySnapshot()).toMatchObject({ suppressed: false, takesStatus: true });
  });

  it("stays down while any one of several full bodies is on screen", () => {
    mountBuddyDock();
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    announceFullBody("a", true);
    announceFullBody("b", true);
    announceFullBody("a", false);
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS * 2);
    expect(getBuddySnapshot().suppressed).toBe(true);
    announceFullBody("b", false);
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    expect(getBuddySnapshot().suppressed).toBe(false);
  });

  it("takes the status from a chip beside a job the moment the other character leaves, with no wait", () => {
    mountBuddyDock();
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    announceFullBody("desk", true);
    expect(getBuddySnapshot().takesStatus).toBe(false);
    announceFullBody("desk", false);
    // the buddy itself is still on its way back, but no chip should flash up for that long
    expect(getBuddySnapshot()).toMatchObject({ suppressed: true, takesStatus: true });
  });

  it("is never the status character with no rail to stand in", () => {
    expect(getBuddySnapshot().takesStatus).toBe(false);
  });

  it("keeps the room it was told about and rounds it", () => {
    setBuddyRoom(66.6, 215.2);
    expect(getBuddySnapshot()).toMatchObject({ slackPx: 67, widthPx: 215 });
  });

  it("remembers that the person made it smaller", () => {
    setBuddyMinimised(true);
    expect(getBuddySnapshot().minimised).toBe(true);
    setBuddyMinimised(false);
    expect(getBuddySnapshot().minimised).toBe(false);
  });
});

describe("page stages", () => {
  it("moves the buddy off the rail while a page stage is on screen, and back when it leaves", () => {
    mountBuddyDock();
    vi.advanceTimersByTime(BUDDY_RETURN_DELAY_MS);
    setBuddyRoom(200, 200);
    expect(buddyView(getBuddySnapshot()).view).toBe("body");
    announceStage("header", true);
    expect(getBuddySnapshot()).toMatchObject({ staged: true, takesStatus: true });
    expect(buddyView(getBuddySnapshot()).view).toBe("none");
    announceStage("header", false);
    expect(getBuddySnapshot().staged).toBe(false);
    expect(buddyView(getBuddySnapshot()).view).toBe("body");
  });

  it("makes a stage the status character even with no rail mounted (a collapsed rail, a phone)", () => {
    expect(getBuddySnapshot().takesStatus).toBe(false);
    announceStage("composer", true);
    expect(getBuddySnapshot().takesStatus).toBe(true);
  });

  it("counts each stage once and publishes only on a real change", () => {
    const listener = vi.fn();
    subscribeBuddy(listener);
    announceStage("a", true);
    announceStage("a", true);
    expect(listener).toHaveBeenCalledTimes(1);
    announceStage("b", true);
    announceStage("a", false);
    expect(getBuddySnapshot().staged).toBe(true);
    announceStage("b", false);
    expect(getBuddySnapshot().staged).toBe(false);
  });
});
