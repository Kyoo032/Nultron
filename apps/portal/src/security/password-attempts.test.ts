/**
 * The in-process record of which source addresses have attempted which account in the window, and the
 * per-account order the attempts are charged in. No database: the durable half is
 * `store/postgres/credentials.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { fixedClock } from "../testing/pg";
import { createPasswordAttempts, PASSWORD_ATTEMPT_WINDOW_MS } from "./password-attempts";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

describe("the window", () => {
  it("is the length of the lock", () => {
    expect(PASSWORD_ATTEMPT_WINDOW_MS).toBe(FIFTEEN_MINUTES);
  });
});

describe("enter", () => {
  it("calls a source clean the first time it attempts an account, and not clean after", () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(true);
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(false);
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(false);
  });

  it("keeps sources apart, and accounts apart", () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    attempts.enter("acct-1", "198.51.100.1");
    expect(attempts.enter("acct-1", "198.51.100.2").clean).toBe(true);
    expect(attempts.enter("acct-2", "198.51.100.1").clean).toBe(true);
    expect(attempts.enter("acct-2", "198.51.100.1").clean).toBe(false);
  });

  it("forgets a source fifteen minutes after its first attempt, and does not extend it by trying again", () => {
    const clock = fixedClock();
    const attempts = createPasswordAttempts({ clock });
    attempts.enter("acct-1", "198.51.100.1");
    clock.advance(FIFTEEN_MINUTES - 1000);
    // A further attempt a second before the end is not clean, and does not move the end.
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(false);
    clock.advance(1000);
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(true);
  });

  it("is a record of attempts, not of failures, so a burst cannot make every request in it clean", () => {
    // Twelve parallel requests from one source reach `enter` in one tick, before any of them has
    // been compared: only the first is clean.
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    const answers = Array.from({ length: 12 }, () => attempts.enter("acct-1", "198.51.100.1").clean);
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(answers[0]).toBe(true);
  });
});

describe("forget", () => {
  it("makes the source clean again for that account only", () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    attempts.enter("acct-1", "198.51.100.1");
    attempts.enter("acct-2", "198.51.100.1");
    attempts.forget("acct-1", "198.51.100.1");
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(true);
    expect(attempts.enter("acct-2", "198.51.100.1").clean).toBe(false);
    // Forgetting what is not there is nothing.
    expect(() => attempts.forget("acct-9", "203.0.113.9")).not.toThrow();
  });
});

describe("its size is bounded", () => {
  it("holds at most the stated number of sources for one account, oldest first", () => {
    const attempts = createPasswordAttempts({ clock: fixedClock(), maxSourcesPerAccount: 4 });
    for (let index = 1; index <= 10; index += 1) {
      attempts.enter("acct-1", `198.51.100.${index}`);
    }
    expect(attempts.size).toBe(4);
    // The newest four are held; the oldest were let go, which only makes them clean again.
    expect(attempts.enter("acct-1", "198.51.100.10").clean).toBe(false);
    expect(attempts.enter("acct-1", "198.51.100.1").clean).toBe(true);
  });

  it("holds at most the stated number of accounts, and drops expired ones before live ones", () => {
    const clock = fixedClock();
    const attempts = createPasswordAttempts({ clock, maxAccounts: 5 });
    for (let index = 1; index <= 3; index += 1) {
      attempts.enter(`old-${index}`, "198.51.100.1");
    }
    clock.advance(FIFTEEN_MINUTES + 1);
    for (let index = 1; index <= 5; index += 1) {
      attempts.enter(`new-${index}`, "198.51.100.1");
    }
    // The three expired accounts made room; the five live ones are all still there.
    for (let index = 1; index <= 5; index += 1) {
      expect(attempts.enter(`new-${index}`, "198.51.100.1").clean, `new-${index}`).toBe(false);
    }
    for (let index = 6; index <= 40; index += 1) {
      attempts.enter(`flood-${index}`, "198.51.100.1");
    }
    expect(attempts.size).toBeLessThanOrEqual(5);
  });
});

describe("ordered", () => {
  it("runs the work for one account one at a time, in the order it was asked for", async () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([
      attempts.ordered("acct-1", slow("a", 30)),
      attempts.ordered("acct-1", slow("b", 1)),
      attempts.ordered("acct-1", slow("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("lets different accounts run side by side", async () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = attempts.ordered("acct-1", async () => {
      started.push("one");
      await gate;
    });
    const second = attempts.ordered("acct-2", async () => {
      started.push("two");
    });
    await second;
    expect(started).toEqual(["one", "two"]);
    release();
    await first;
  });

  it("goes on after work that threw, and hands the error to the caller that asked for that work", async () => {
    const attempts = createPasswordAttempts({ clock: fixedClock() });
    const failing = attempts.ordered("acct-1", async () => {
      throw new Error("the database went away");
    });
    const after = attempts.ordered("acct-1", async () => "still runs");
    await expect(failing).rejects.toThrow("the database went away");
    await expect(after).resolves.toBe("still runs");
  });
});
