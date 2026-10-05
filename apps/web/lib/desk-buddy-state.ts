import type { MascotState } from "@/lib/mascot-states";

/**
 * The desk buddy's rules, as pure functions so a node test can hold them: which state wins when several
 * parts of the app have something to say, how a flash expires, how much room the character gets, and what
 * the tap does. The store (`lib/desk-buddy-store.ts`) holds the facts; the component only draws the answer.
 */

/** Who may speak, loudest last. A flash (a finished job, a tap) is louder than any standing claim. */
export const BUDDY_PRIORITY = {
  guide: 40,
  job: 60,
  charging: 70,
  flash: 80,
} as const;

export type BuddyClaim = {
  state: MascotState;
  /** The caller knows work is really running, so a working pose may loop (`isMascotBusy` agrees). */
  busy?: boolean;
  priority?: number;
};

export type BuddyClaimRow = BuddyClaim & {
  /** Order the claim was made in: among equals, the newest speaks. */
  seq: number;
};

/** The standing claim that wins: highest priority, newest among equals. `null` when nothing is claimed. */
export function pickClaim(rows: Iterable<BuddyClaimRow>): BuddyClaimRow | null {
  let best: BuddyClaimRow | null = null;
  for (const row of rows) {
    const rank = row.priority ?? BUDDY_PRIORITY.job;
    const bestRank = best ? (best.priority ?? BUDDY_PRIORITY.job) : -1;
    if (!best || rank > bestRank || (rank === bestRank && row.seq > best.seq)) {
      best = row;
    }
  }
  return best;
}

/** How long a one-shot reaction holds its pose after its clip: long enough to be read, short enough to be gone. */
export const FLASH_MS = 2400;
/** The wave on arrival is a clip and nothing more. */
export const WAVE_MS = 1400;

/** What a tap on the buddy does, in turn. Every one is a clip. */
export const TAP_REACTIONS: readonly MascotState[] = ["love", "lets-go", "celebrating"];

export function tapReaction(taps: number): MascotState {
  const count = Math.max(0, Math.floor(taps));
  return TAP_REACTIONS[count % TAP_REACTIONS.length] ?? "love";
}

/**
 * What the buddy can be asked to do next, so those files are in the cache by then: how a run ends (a cheer or a
 * flinch; their clips are fetched only once a run is under way, `NultronMascot`'s `next`) and the nap. The
 * wave and the tap reactions are fetched when they play, and the still holds until the clip is ready.
 */
export const BUDDY_NEXT: readonly MascotState[] = ["celebrating", "error", "sleep"];

/** The idle reasons `lib/ambient-motion.ts` writes. Only an `idle` window sends the buddy to sleep. */
export type BuddyAmbientReason = "idle" | "blurred" | "hidden" | null;

/** The pose with nothing to say: awake and calm, or asleep once the person has been away. */
export function restingState(reason: BuddyAmbientReason): MascotState {
  return reason === "idle" ? "sleep" : "idle";
}

/** Body sizes, in px of the picture box (a square, the body about 77% of its height). A body under 64 px is drawn as a body on purpose (`variant="full"`), not as the head the mascot picks below 64. */
export const BODY_MIN = 56;
export const BODY_MAX = 96;
/** Air between the last row of the rail and the top of the body. */
export const BODY_GAP = 6;
/** The head chip that stands in when there is no room for a body (or the person asked for less). */
export const CHIP_SIZE = 32;

export type BuddyView = "none" | "body" | "chip";

export type BuddyRoom = {
  /** An expanded rail is mounted. A collapsed one, or a screen with no rail, has no buddy. */
  present: boolean;
  /** Another full-body character is on screen (the hero, an empty desk, onboarding): one is enough. */
  suppressed: boolean;
  /** The page is showing the buddy on a stage of its own (a mode header, the composer), so the rail stands down. */
  staged?: boolean;
  /** The person made it small. */
  minimised: boolean;
  /** Free height under the last rail row, px. */
  slackPx: number;
  /** Width of the rail's list, px. */
  widthPx: number;
};

/** The size of the body the room allows, or 0 when it allows none. */
export function bodySize(slackPx: number, widthPx: number): number {
  const box = Math.min(BODY_MAX, Math.floor(slackPx) - BODY_GAP, Math.floor(widthPx) - 16);
  return box >= BODY_MIN ? box : 0;
}

/**
 * What the rail shows. No room is never a reason to squeeze: a body needs its full 64 px, and without
 * it the character becomes a small head in the footer, which has a row of its own.
 */
export function buddyView(room: BuddyRoom): { view: BuddyView; size: number } {
  if (!room.present || room.suppressed || room.staged) {
    return { view: "none", size: 0 };
  }
  const size = room.minimised ? 0 : bodySize(room.slackPx, room.widthPx);
  return size > 0 ? { view: "body", size } : { view: "chip", size: CHIP_SIZE };
}

/** A full-body character must be this much on screen to count as "on screen". */
export const FULL_BODY_VISIBLE_RATIO = 0.25;
/** The buddy waits this long after the last full-body character left before it steps in. */
export const BUDDY_RETURN_DELAY_MS = 350;

export type RunFacts = {
  /** The run is in flight. */
  running: boolean;
  /** It failed, or the pane shows its error. */
  failed: boolean;
  /** It got somewhere. A cancelled run is neither failed nor succeeded, and is not cheered. Default true. */
  succeeded?: boolean;
};

/**
 * What a change in a run's facts calls for: a flinch the moment a failure appears, a cheer when the run
 * stops without one. Anything else (still running, still failed, a cancelled run) says nothing.
 */
export function runReaction(before: RunFacts, after: RunFacts): "error" | "celebrating" | null {
  if (after.failed && !before.failed) {
    return "error";
  }
  if (before.running && !after.running && !after.failed && (after.succeeded ?? true)) {
    return "celebrating";
  }
  return null;
}
