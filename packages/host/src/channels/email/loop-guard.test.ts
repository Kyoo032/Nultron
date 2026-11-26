import { describe, expect, it } from "vitest";
import { isAutoSubmitted, maxPerSenderHour, SenderCap, senderHash } from "./loop-guard";
import { EMAIL_MAX_PER_SENDER_HOUR_ENV } from "./path";

describe("isAutoSubmitted", () => {
  it("honours Auto-Submitted and Precedence", () => {
    expect(isAutoSubmitted({ "auto-submitted": "auto-replied" })).toBe(true);
    expect(isAutoSubmitted({ "auto-submitted": "auto-generated" })).toBe(true);
    expect(isAutoSubmitted({ "auto-submitted": "no" })).toBe(false);
    expect(isAutoSubmitted({ precedence: "bulk" })).toBe(true);
    expect(isAutoSubmitted({ precedence: "list" })).toBe(true);
    expect(isAutoSubmitted({ precedence: "normal" })).toBe(false);
    expect(isAutoSubmitted({ "x-autoreply": "yes" })).toBe(true);
    expect(isAutoSubmitted({})).toBe(false);
  });
});

describe("SenderCap", () => {
  it("admits up to the limit in a sliding hour, then refuses", () => {
    let now = 1_000_000;
    const cap = new SenderCap(3, () => now);
    expect(cap.admit("c", "h")).toBe(true);
    expect(cap.admit("c", "h")).toBe(true);
    expect(cap.admit("c", "h")).toBe(true);
    expect(cap.admit("c", "h")).toBe(false);
    // A different sender or channel is not capped.
    expect(cap.admit("c", "h2")).toBe(true);
    expect(cap.admit("c2", "h")).toBe(true);
    // An hour later the window slides open again.
    now += 3_600_001;
    expect(cap.admit("c", "h")).toBe(true);
  });
});

describe("maxPerSenderHour / senderHash", () => {
  it("reads the env with a floor default", () => {
    expect(maxPerSenderHour({} as NodeJS.ProcessEnv)).toBe(20);
    expect(maxPerSenderHour({ [EMAIL_MAX_PER_SENDER_HOUR_ENV]: "5" } as NodeJS.ProcessEnv)).toBe(5);
    expect(maxPerSenderHour({ [EMAIL_MAX_PER_SENDER_HOUR_ENV]: "0" } as NodeJS.ProcessEnv)).toBe(20);
  });

  it("hashes the sender case-insensitively so no address reaches a log", () => {
    expect(senderHash("A@X.com")).toBe(senderHash("a@x.com"));
    expect(senderHash("a@x.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(senderHash("a@x.com")).not.toContain("@");
  });
});
