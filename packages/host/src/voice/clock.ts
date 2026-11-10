/** The host clock the relay and its timers read. Tests pass a clock they can move. */
export type VoiceClock = {
  now(): number;
  /** Run `fn` after `ms`. The return value cancels it. */
  after(ms: number, fn: () => void): () => void;
};

export function systemClock(): VoiceClock {
  return {
    now: () => Date.now(),
    after(ms, fn) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };
}

type Pending = { at: number; fn: () => void; dead: boolean };

/** A clock that moves only when `advance` is called. Timers fire in order during the advance. */
export type ManualClock = VoiceClock & { advance(ms: number): void };

export function manualClock(start = 0): ManualClock {
  let now = start;
  const timers: Pending[] = [];
  return {
    now: () => now,
    after(ms, fn) {
      const entry: Pending = { at: now + Math.max(0, ms), fn, dead: false };
      timers.push(entry);
      return () => {
        entry.dead = true;
      };
    },
    advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        let next: Pending | null = null;
        for (const entry of timers) {
          if (entry.dead || entry.at > target) continue;
          if (!next || entry.at < next.at) next = entry;
        }
        if (!next) break;
        now = next.at;
        next.dead = true;
        next.fn();
      }
      now = target;
    },
  };
}
