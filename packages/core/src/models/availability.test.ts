import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import {
  GatewayRefusalError,
  STATUS_TTL_MS,
  classifyGatewayRefusal,
  effectiveRecordStatus,
  emptyStore,
  isOfferedStatus,
  parseAvailabilityStore,
  recordsFor,
  refusalOfError,
  withOutcome,
  withoutLessons,
} from "./availability";
import { availabilityKeyId, newAvailabilitySalt } from "./availability-key";

/** The refusals measured on 2026-11-11 with a prepaid agent key, as the gateway worded them. */
describe("classifyGatewayRefusal", () => {
  it("reads a prepaid async refusal as an account matter, not a bad key", () => {
    expect(
      classifyGatewayRefusal({
        status: 403,
        code: "prepaid_async_requires_fixed_price",
        message: "prepaid accounts can only submit fixed-price async jobs",
      }),
    ).toEqual({ status: "account_blocked", reason: "prepaid_async_requires_fixed_price" });
    expect(classifyGatewayRefusal({ status: 403, message: "代理预付账户的异步任务仅支持固定按次价格" })?.status).toBe(
      "account_blocked",
    );
  });

  it("reads a 503 with no channel as no_channel", () => {
    expect(
      classifyGatewayRefusal({ status: 503, message: "no available configurable resource channel for kling-v3" }),
    ).toMatchObject({ status: "no_channel" });
    // NewAPI sends the SAME code for "pool is empty" (503) and "not on this key" (4xx); the status separates them.
    expect(classifyGatewayRefusal({ status: 503, code: "model_not_found", message: "gpt-4o-mini-tts" })).toMatchObject({
      status: "no_channel",
    });
  });

  it("reads model_not_found on a non-503 as not_on_key", () => {
    expect(classifyGatewayRefusal({ status: 400, code: "model_not_found", message: "suno_music" })).toEqual({
      status: "not_on_key",
      reason: "model_not_found",
    });
    expect(classifyGatewayRefusal({ status: 404, message: "This model is not available for this key" })?.status).toBe(
      "not_on_key",
    );
  });

  it("reads an upstream refusal as upstream_rejected", () => {
    expect(
      classifyGatewayRefusal({ status: 403, code: "bad_response_status_code", message: "upstream said no" }),
    ).toMatchObject({
      status: "upstream_rejected",
      reason: "bad_response_status_code",
    });
    expect(classifyGatewayRefusal({ status: 200, message: "上游拒绝了请求" })?.status).toBe("upstream_rejected");
  });

  it("learns nothing from refusals that say nothing about the model", () => {
    for (const refusal of [
      { status: 401, message: "Invalid token" },
      { status: 429, message: "rate limited" },
      { status: 500, message: "not implemented" },
      { status: 400, message: "prompt is required" },
      { status: 504, message: "Gateway video job timed out" },
      { status: 403, message: "content policy" },
    ]) {
      expect(classifyGatewayRefusal(refusal), JSON.stringify(refusal)).toBeNull();
    }
  });

  it("never learns from a job that failed after the gateway accepted it", () => {
    // The measured case: Seedance accepted the submit, then the poll reported "may be related to
    // copyright restrictions". That is the brief, not the model.
    expect(
      classifyGatewayRefusal({
        status: 200,
        message: "may be related to copyright restrictions",
        phase: "poll",
      }),
    ).toBeNull();
    // Even words the submit-time classifier would read teach nothing at poll time: the model was taken.
    expect(
      classifyGatewayRefusal({
        status: 503,
        message: "no available configurable resource channel",
        phase: "poll",
      }),
    ).toBeNull();
    expect(
      classifyGatewayRefusal({
        status: 403,
        code: "prepaid_async_requires_fixed_price",
        message: "prepaid",
        phase: "poll",
      }),
    ).toBeNull();
    // The same refusal at submit time still files a lesson; the phase is what changes the answer.
    expect(
      classifyGatewayRefusal({
        status: 403,
        code: "prepaid_async_requires_fixed_price",
        message: "prepaid",
        phase: "submit",
      }),
    ).toEqual({ status: "account_blocked", reason: "prepaid_async_requires_fixed_price" });
  });

  it("never learns from a 401 or a 429, whatever words came with them", () => {
    // A refused key or a rate limit is an account or transport fact, not a fact about the model.
    expect(classifyGatewayRefusal({ status: 401, code: "model_not_found", message: "model_not_found" })).toBeNull();
    expect(
      classifyGatewayRefusal({ status: 429, message: "no available configurable resource channel" }),
    ).toBeNull();
    expect(
      classifyGatewayRefusal({ status: 429, code: "bad_response_status_code", message: "upstream rejected" }),
    ).toBeNull();
  });

  it("falls back to a short sentence of the gateway's words when it sent no code", () => {
    const learned = classifyGatewayRefusal({ status: 503, message: "No available channel for model x under group y" });
    expect(learned?.reason).toMatch(/^No available channel/);
    expect(learned?.reason.length).toBeLessThanOrEqual(80);
  });
});

describe("refusalOfError", () => {
  it("returns what a refusal error kept", () => {
    const error = new GatewayRefusalError("tool_failed", "sentence for the person", 503, {
      status: 503,
      code: "model_not_found",
      message: "raw",
    });
    expect(refusalOfError(error)).toEqual({ status: 503, code: "model_not_found", message: "raw" });
  });

  it("rebuilds one from a plain ApiError and refuses anything else", () => {
    expect(refusalOfError(new ApiError("tool_failed", "no available channel", 503))).toEqual({
      status: 503,
      message: "no available channel",
    });
    expect(refusalOfError(new Error("boom"))).toBeNull();
    expect(refusalOfError("boom")).toBeNull();
  });
});

describe("lesson lifetimes", () => {
  const seen = Date.parse("2026-11-11T10:00:00.000Z");
  const record = (status: keyof typeof STATUS_TTL_MS) => ({
    status,
    reason: "",
    checkedAt: new Date(seen).toISOString(),
  });

  it("holds each lesson for its own time, then the model is unknown again", () => {
    expect(effectiveRecordStatus(record("upstream_rejected"), seen + 14 * 60_000)).toBe("upstream_rejected");
    expect(effectiveRecordStatus(record("upstream_rejected"), seen + 16 * 60_000)).toBe("unknown");
    expect(effectiveRecordStatus(record("no_channel"), seen + 59 * 60_000)).toBe("no_channel");
    expect(effectiveRecordStatus(record("no_channel"), seen + 61 * 60_000)).toBe("unknown");
    expect(effectiveRecordStatus(record("account_blocked"), seen + 23 * 3_600_000)).toBe("account_blocked");
    expect(effectiveRecordStatus(record("account_blocked"), seen + 25 * 3_600_000)).toBe("unknown");
  });

  it("makes upstream_rejected the shortest lesson", () => {
    const ttls = Object.entries(STATUS_TTL_MS).sort((a, b) => a[1] - b[1]);
    expect(ttls[0]?.[0]).toBe("upstream_rejected");
  });

  it("treats a missing or unreadable record as unknown", () => {
    expect(effectiveRecordStatus(undefined, seen)).toBe("unknown");
    expect(effectiveRecordStatus({ status: "no_channel", reason: "", checkedAt: "not a date" }, seen)).toBe("unknown");
  });

  it("offers a model that worked or that nothing has refused, and no other", () => {
    expect(isOfferedStatus("available")).toBe(true);
    expect(isOfferedStatus("unknown")).toBe(true);
    for (const status of ["not_on_key", "no_channel", "account_blocked", "upstream_rejected"] as const) {
      expect(isOfferedStatus(status)).toBe(false);
    }
  });
});

describe("the per-key store", () => {
  const now = Date.parse("2026-11-11T10:00:00.000Z");

  it("keeps two keys' refusals apart on one desk", () => {
    const salt = newAvailabilitySalt();
    const keyA = availabilityKeyId("sk-key-a", salt) as string;
    const keyB = availabilityKeyId("sk-key-b", salt) as string;
    expect(keyA).not.toBe(keyB);
    let store = emptyStore(salt);
    store = withOutcome(store, keyA, "grok-imagine-video", { status: "account_blocked", reason: "prepaid" }, now);
    expect(recordsFor(store, keyA)["grok-imagine-video"]?.status).toBe("account_blocked");
    expect(recordsFor(store, keyB)).toEqual({});
    store = withOutcome(store, keyB, "grok-imagine-video", { status: "available", reason: "" }, now);
    expect(recordsFor(store, keyA)["grok-imagine-video"]?.status).toBe("account_blocked");
    expect(recordsFor(store, keyB)["grok-imagine-video"]?.status).toBe("available");
  });

  it("never holds the key, however it is serialised", () => {
    const secret = "sk-this-is-a-very-secret-gateway-key-0123456789";
    const salt = newAvailabilitySalt();
    const keyId = availabilityKeyId(secret, salt) as string;
    const store = withOutcome(emptyStore(salt), keyId, "kling-v3", { status: "no_channel", reason: "503" }, now);
    const text = JSON.stringify(store);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(3, 20));
    expect(keyId).toMatch(/^k_[0-9a-f]{16}$/);
  });

  it("files the same key under different ids on two installs", () => {
    expect(availabilityKeyId("sk-same", newAvailabilitySalt())).not.toBe(
      availabilityKeyId("sk-same", newAvailabilitySalt()),
    );
    expect(availabilityKeyId("sk-same", "salt-one-1234")).toBe(availabilityKeyId("  sk-same\n", "salt-one-1234"));
  });

  it("gives a blank key no id, so a stub desk learns nothing", () => {
    expect(availabilityKeyId("", "salt-one-1234")).toBeNull();
    expect(availabilityKeyId("   ", "salt-one-1234")).toBeNull();
    expect(availabilityKeyId(undefined, "salt-one-1234")).toBeNull();
  });

  it("forgets one key's lessons and leaves the rest", () => {
    const salt = newAvailabilitySalt();
    let store = emptyStore(salt);
    store = withOutcome(store, "k_a", "m", { status: "no_channel", reason: "" }, now);
    store = withOutcome(store, "k_b", "m", { status: "no_channel", reason: "" }, now);
    const cleared = withoutLessons(store, "k_a");
    expect(recordsFor(cleared, "k_a")).toEqual({});
    expect(recordsFor(cleared, "k_b")["m"]?.status).toBe("no_channel");
    expect(withoutLessons(store, null)).toBe(store);
  });

  it("holds a few keys and drops the least recently used", () => {
    let store = emptyStore("salt-one-1234");
    for (let index = 0; index < 6; index += 1) {
      store = withOutcome(store, `k_${index}`, "m", { status: "no_channel", reason: "" }, now + index * 1_000);
    }
    expect(Object.keys(store.keys)).toHaveLength(4);
    expect(store.keys["k_5"]).toBeDefined();
    expect(store.keys["k_0"]).toBeUndefined();
  });

  it("normalises the model id's case", () => {
    const store = withOutcome(
      emptyStore("salt-one-1234"),
      "k_a",
      "Seedance-2.0-Fast",
      { status: "available", reason: "" },
      now,
    );
    expect(recordsFor(store, "k_a")["seedance-2.0-fast"]?.status).toBe("available");
  });

  it("drops records that have expired when it writes", () => {
    let store = withOutcome(
      emptyStore("salt-one-1234"),
      "k_a",
      "old",
      { status: "upstream_rejected", reason: "" },
      now,
    );
    store = withOutcome(store, "k_a", "new", { status: "no_channel", reason: "" }, now + 20 * 60_000);
    expect(Object.keys(recordsFor(store, "k_a"))).toEqual(["new"]);
  });
});

describe("parseAvailabilityStore", () => {
  it("reads back what it wrote", () => {
    const store = withOutcome(
      emptyStore("salt-one-1234"),
      "k_a",
      "m",
      { status: "no_channel", reason: "r" },
      Date.now(),
    );
    expect(parseAvailabilityStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
  });

  it("refuses the wrong shape and drops records of an unknown status", () => {
    expect(parseAvailabilityStore(null)).toBeUndefined();
    expect(parseAvailabilityStore({ salt: "x", keys: {} })).toBeUndefined();
    expect(parseAvailabilityStore({ salt: "salt-one-1234", keys: "no" })).toBeUndefined();
    const parsed = parseAvailabilityStore({
      salt: "salt-one-1234",
      keys: {
        k_a: {
          touchedAt: "2026-11-11T10:00:00.000Z",
          models: {
            good: { status: "no_channel", reason: "r", checkedAt: "2026-11-11T10:00:00.000Z" },
            bad: { status: "blocked_forever", reason: "r", checkedAt: "2026-11-11T10:00:00.000Z" },
          },
        },
      },
    });
    expect(Object.keys(parsed?.keys.k_a?.models ?? {})).toEqual(["good"]);
  });
});
