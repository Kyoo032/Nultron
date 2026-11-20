/**
 * Shared pieces of the eval's own tests: a clock the test steps by hand, and a way to run cases against a fake
 * host at several times real speed. Not a test file itself.
 */
import { loadFixtures } from "./audio";
import { createVoiceClient } from "./client";
import { type Clock, scaledClock } from "./clock";
import { type FakeBehavior, type FakeHost, startFakeHost } from "./fake-host";
import type { CaseRow, VoiceRunFile } from "./report";
import { runCases } from "./runner";
import type { TextPolicy } from "./text";

/**
 * How much faster than real time the fake-host tests run. The microphone stream and the fake share one scaled
 * clock, so every duration still agrees; only the network is real, and it reads `TEST_SCALE` times larger.
 * Windows timers tick every 15 ms or so, which at this scale is about 60 ms of jitter: every limit a test
 * leans on has more room than that.
 */
export const TEST_SCALE = 4;

/** The pace limit the fake-host tests use: the real one is 150 ms, and a busy test machine slips past it. */
export const TEST_PACE_LAG_MS = 1_500;

/**
 * A clock that only moves when the test says so. `advance` runs every timer that falls due, in order, each at
 * its own time. `jump` is a stall: the clock moves at once and every timer that fell due runs at the new time,
 * the way a blocked event loop delivers them.
 */
export function manualClock(): { clock: Clock; advance(ms: number): Promise<void>; jump(ms: number): Promise<void> } {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    after(ms, fn) {
      const timer = { at: now + Math.max(0, ms), fn };
      timers.add(timer);
      return { cancel: () => void timers.delete(timer) };
    },
    sleep: (ms) => new Promise((resolve) => clock.after(ms, resolve)),
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    clock,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        now = Math.max(now, due.at);
        timers.delete(due);
        due.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    async jump(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        timers.delete(due);
        due.fn();
        await flush();
      }
      await flush();
    },
  };
}

export type CaseRun = {
  rows: CaseRow[];
  cleanup: VoiceRunFile["cleanup"];
  host: FakeHost;
  /** What the run would have written to its result file. */
  file: VoiceRunFile;
};

/** Starts a fake host with `behavior`, runs `caseIds` against it over the real protocol, and stops the host. */
export async function runAgainst(
  behavior: Partial<FakeBehavior>,
  caseIds: readonly string[],
  options: { repeat?: number; policy?: TextPolicy; cleanup?: boolean; scale?: number; paceLagMs?: number } = {},
): Promise<CaseRun> {
  const clock = scaledClock(options.scale ?? TEST_SCALE);
  const host = await startFakeHost({ clock, behavior });
  try {
    const client = createVoiceClient({ base: host.base, clock, locale: "id" });
    const settings = await client.settings();
    const policy = options.policy ?? { showText: false };
    const { rows, cleanup } = await runCases({
      client,
      clock,
      fixtures: loadFixtures(),
      settings,
      caseIds,
      repeat: options.repeat ?? 1,
      policy,
      cleanup: options.cleanup ?? true,
      // Twelve test files share this machine, so a stream can fall further behind than it would on a quiet one.
      paceLagMs: options.paceLagMs ?? TEST_PACE_LAG_MS,
    });
    const file: VoiceRunFile = {
      format: 1,
      runId: "test",
      startedAt: "2026-11-10T00:00:00.000Z",
      finishedAt: "2026-11-10T00:00:01.000Z",
      base: host.base,
      locale: "id",
      repeat: options.repeat ?? 1,
      showText: policy.showText,
      desk: { model: settings.voice?.model ?? null, runtime: settings.runtime, locale: settings.locale },
      rows,
      cleanup,
      summary: { cases: rows.length, pass: 0, fail: 0, skipped: 0, blocked: 0, error: 0, wallMs: 0 },
    };
    return { rows, cleanup, host, file };
  } finally {
    await host.close();
  }
}

/** The failed checks of a row, as `name (detail)`, for readable test failures. */
export function failedChecks(row: CaseRow | undefined): string[] {
  return (row?.checks ?? []).filter((check) => check.failed > 0).map((check) => `${check.name} (${check.detail ?? ""})`);
}
