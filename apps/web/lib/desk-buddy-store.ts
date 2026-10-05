import { useSyncExternalStore } from "react";
import {
  BUDDY_RETURN_DELAY_MS,
  type BuddyClaim,
  type BuddyClaimRow,
  BUDDY_PRIORITY,
  FLASH_MS,
  pickClaim,
  tapReaction,
} from "@/lib/desk-buddy-state";
import type { MascotState } from "@/lib/mascot-states";

/**
 * What the desk buddy is told. Parts of the app that have something to say publish into this store and
 * the buddy draws the answer; nothing here knows about React components or the rail.
 *
 *  - a **claim** is a standing fact with an owner ("this chat run is working", "an update is
 *    downloading"): published while it is true and withdrawn when it stops. The loudest claim speaks;
 *    among equals the newest does (`pickClaim`);
 *  - a **flash** is a one-shot reaction (a finished job, a failure, a tap): it speaks over every claim
 *    for `FLASH_MS` and then lets go;
 *  - the **room** is where the buddy may stand: an expanded rail has mounted a dock, the rail's list has
 *    this much free height, the person did or did not make it small, and another full-body character
 *    (the Chat hero, an empty desk, onboarding) may already be on screen (one is enough).
 *
 * It is a module-level store read with `useSyncExternalStore`, so a publisher outside the shell (a job
 * list on a kept-alive page) reaches the buddy without prop drilling. Snapshots are replaced, never
 * mutated, and only when a field really changed.
 */

export type BuddySnapshot = {
  /** An expanded rail has a dock mounted. */
  present: boolean;
  /** Another full-body character is on screen, or one just left and the buddy has not stepped in yet. */
  suppressed: boolean;
  /** A page stage (a mode header, the composer) is on screen and holds the buddy, so the rail stands down. */
  staged: boolean;
  /** The buddy is the status character: it is mounted and no other full body is on screen (or about to leave). */
  takesStatus: boolean;
  minimised: boolean;
  slackPx: number;
  widthPx: number;
  /** The loudest voice, `null` when the app has nothing to say and the buddy rests. */
  state: MascotState | null;
  busy: boolean;
  /** Changes with every flash, so the same reaction twice plays its clip twice. */
  nonce: number;
};

const STORAGE_KEY = "nultron.buddy";

const INITIAL: BuddySnapshot = {
  present: false,
  suppressed: false,
  staged: false,
  takesStatus: false,
  minimised: false,
  slackPx: 0,
  widthPx: 0,
  state: null,
  busy: false,
  nonce: 0,
};

let snapshot: BuddySnapshot = INITIAL;
const listeners = new Set<() => void>();

const claims = new Map<string, BuddyClaimRow>();
let seq = 0;
let flash: { state: MascotState; nonce: number } | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let nonce = 0;
let taps = 0;

let docks = 0;
const fullBodies = new Set<string>();
const stages = new Set<string>();
let returning = false;
let returnTimer: ReturnType<typeof setTimeout> | null = null;
let slackPx = 0;
let widthPx = 0;
let minimised = false;
let minimisedRead = false;

function readMinimised(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "min";
  } catch {
    return false;
  }
}

function writeMinimised(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "min" : "full");
  } catch {
    // Storage can be blocked or full; the choice then lasts until the page closes.
  }
}

function compute(): BuddySnapshot {
  const present = docks > 0;
  const staged = stages.size > 0;
  const suppressed = fullBodies.size > 0 || returning;
  const claim = pickClaim(claims.values());
  const state = flash ? flash.state : (claim?.state ?? null);
  const busy = flash ? false : Boolean(claim?.busy);
  return {
    present,
    suppressed,
    staged,
    // Not `!suppressed`: the short wait before the buddy steps back in must not bring a chip back for a
    // moment beside a job that has just started (the empty desk's character leaves, then the chip would
    // show for the length of the wait). The claim is held; the buddy draws it when it appears.
    takesStatus: (present || staged) && fullBodies.size === 0,
    minimised,
    slackPx,
    widthPx,
    state,
    busy,
    nonce: flash ? flash.nonce : 0,
  };
}

function same(a: BuddySnapshot, b: BuddySnapshot): boolean {
  return (
    a.present === b.present &&
    a.suppressed === b.suppressed &&
    a.staged === b.staged &&
    a.takesStatus === b.takesStatus &&
    a.minimised === b.minimised &&
    a.slackPx === b.slackPx &&
    a.widthPx === b.widthPx &&
    a.state === b.state &&
    a.busy === b.busy &&
    a.nonce === b.nonce
  );
}

function publish(): void {
  const next = compute();
  if (same(snapshot, next)) {
    return;
  }
  snapshot = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getBuddySnapshot(): BuddySnapshot {
  return snapshot;
}

export function subscribeBuddy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish (or, with `null`, withdraw) what `source` has to say. A source speaks once at a time. */
export function setBuddyClaim(source: string, claim: BuddyClaim | null): void {
  if (!claim) {
    if (claims.delete(source)) {
      publish();
    }
    return;
  }
  const current = claims.get(source);
  if (
    current &&
    current.state === claim.state &&
    Boolean(current.busy) === Boolean(claim.busy) &&
    current.priority === claim.priority
  ) {
    return;
  }
  seq += 1;
  claims.set(source, { ...claim, seq });
  publish();
}

/** A one-shot reaction: speaks over every claim for `ms`, then lets go. Use a clip state, never a working one. */
export function flashBuddy(state: MascotState, ms: number = FLASH_MS): void {
  nonce += 1;
  flash = { state, nonce };
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  flashTimer = setTimeout(() => {
    flash = null;
    flashTimer = null;
    publish();
  }, ms);
  publish();
}

/** A tap on the buddy: love, then lets-go, then a cheer, then round again. */
export function tapBuddy(): MascotState {
  const state = tapReaction(taps);
  taps += 1;
  flashBuddy(state);
  return state;
}

/** An expanded rail mounted a dock. Counted, so a remount hands over without a gap. Returns the unmount. */
export function mountBuddyDock(): () => void {
  if (!minimisedRead && typeof window !== "undefined") {
    minimisedRead = true;
    minimised = readMinimised();
  }
  if (docks === 0) {
    // A character may be arriving with the page: give it a moment to announce itself before the buddy
    // steps in, so the two are never on screen together for a frame.
    startReturnDelay();
  }
  docks += 1;
  publish();
  let live = true;
  return () => {
    if (!live) {
      return;
    }
    live = false;
    docks = Math.max(0, docks - 1);
    publish();
  };
}

function startReturnDelay(): void {
  returning = true;
  if (returnTimer) {
    clearTimeout(returnTimer);
  }
  returnTimer = setTimeout(() => {
    returning = false;
    returnTimer = null;
    publish();
  }, BUDDY_RETURN_DELAY_MS);
}

/** A full-body character appeared on (or left) the screen. Any one of them is enough to stand the buddy down. */
export function announceFullBody(id: string, visible: boolean): void {
  if (visible) {
    if (returnTimer) {
      clearTimeout(returnTimer);
      returnTimer = null;
    }
    returning = false;
    if (!fullBodies.has(id)) {
      fullBodies.add(id);
      publish();
    }
    return;
  }
  if (fullBodies.delete(id) && fullBodies.size === 0) {
    startReturnDelay();
  }
  publish();
}

/**
 * A page stage (a mode header's art column, the composer's ledge) is showing the buddy, or stopped. While any
 * stage is on screen the rail draws nothing and the buddy on the stage is the one status character.
 */
export function announceStage(id: string, visible: boolean): void {
  const changed = visible ? !stages.has(id) : stages.has(id);
  if (!changed) {
    return;
  }
  if (visible) {
    stages.add(id);
  } else {
    stages.delete(id);
  }
  publish();
}

/** The rail's list measured how much room it has under its last row. */
export function setBuddyRoom(nextSlackPx: number, nextWidthPx: number): void {
  const nextSlack = Math.max(0, Math.round(nextSlackPx));
  const nextWidth = Math.max(0, Math.round(nextWidthPx));
  if (nextSlack === slackPx && nextWidth === widthPx) {
    return;
  }
  slackPx = nextSlack;
  widthPx = nextWidth;
  publish();
}

export function setBuddyMinimised(value: boolean): void {
  if (value === minimised) {
    return;
  }
  minimised = value;
  writeMinimised(value);
  publish();
}

/** Test seam: forget everything, timers included. */
export function resetBuddyForTests(): void {
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  if (returnTimer) {
    clearTimeout(returnTimer);
  }
  flashTimer = null;
  returnTimer = null;
  claims.clear();
  fullBodies.clear();
  stages.clear();
  flash = null;
  returning = false;
  docks = 0;
  slackPx = 0;
  widthPx = 0;
  minimised = false;
  minimisedRead = false;
  seq = 0;
  nonce = 0;
  taps = 0;
  snapshot = INITIAL;
  listeners.clear();
}

export function useBuddySnapshot(): BuddySnapshot {
  return useSyncExternalStore(subscribeBuddy, getBuddySnapshot, () => INITIAL);
}

/** True while the buddy is the status character, so a chip beside a job stands down for it. */
export function useBuddyTakesStatus(): boolean {
  return useSyncExternalStore(
    subscribeBuddy,
    () => snapshot.takesStatus,
    () => false,
  );
}

/** True while a page stage holds the buddy, so an empty desk does not draw a second character. */
export function useBuddyStaged(): boolean {
  return useSyncExternalStore(
    subscribeBuddy,
    () => snapshot.staged,
    () => false,
  );
}

export { BUDDY_PRIORITY };
