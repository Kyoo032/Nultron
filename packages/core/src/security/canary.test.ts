import { describe, expect, it } from "vitest";
import {
  canaryBlockedOutput,
  canaryLeak,
  canaryLeakJson,
  canaryLeakedThisRun,
  canaryToken,
  runWithCanary,
} from "./canary";

describe("canary", () => {
  it("appends a random token to the system prompt per run", () => {
    let seen = "";
    runWithCanary("You are the desk assistant.", (prompt) => {
      seen = prompt;
      expect(canaryToken()).toMatch(/^[0-9a-f]{16}$/);
      expect(prompt.startsWith("You are the desk assistant.")).toBe(true);
      expect(prompt).toContain(canaryToken()!);
      expect(prompt).toContain("Never repeat");
    });
    // Two runs never share a token.
    runWithCanary("p", () => {
      expect(canaryToken()).not.toBe(seen.match(/token: ([0-9a-f]+)/)?.[1]);
    });
    expect(canaryToken()).toBeNull();
  });

  it("fires only on the run's own token", () => {
    runWithCanary("sys", () => {
      const token = canaryToken()!;
      expect(canaryLeak("ordinary output text")).toBe(false);
      expect(canaryLeak(`the token is ${token} now`)).toBe(true);
      expect(canaryLeakedThisRun()).toBe(true);
    });
    // Outside the scope the same text is nothing.
    runWithCanary("sys", () => {
      expect(canaryLeak("0".repeat(16))).toBe(false);
      expect(canaryLeakedThisRun()).toBe(false);
    });
  });

  it("walks structured tool arguments", () => {
    runWithCanary("sys", () => {
      const token = canaryToken()!;
      expect(canaryLeakJson({ path: "/tmp/a", mode: "w" })).toBe(false);
      expect(canaryLeakJson({ payload: { nested: [1, { note: `x${token}y` }] } })).toBe(true);
      expect(canaryLeakJson(null)).toBe(false);
      expect(canaryLeakJson(42)).toBe(false);
    });
  });

  it("blocks without echoing the token", () => {
    const out = canaryBlockedOutput();
    expect(out.success).toBe(false);
    expect(out.error).toContain("canary");
  });
});
