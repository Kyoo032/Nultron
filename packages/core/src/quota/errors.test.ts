import { describe, expect, it } from "vitest";
import { QUOTA_ERROR_CODES, QUOTA_ERROR_STATUS, isQuotaErrorCode } from "./errors";

describe("quota error codes", () => {
  it("lists exactly the eight refusal codes", () => {
    expect(QUOTA_ERROR_CODES).toEqual([
      "quota_none",
      "quota_exceeded",
      "quota_paused",
      "model_not_allowed",
      "model_not_priced",
      "pricing_unavailable",
      "quota_context_missing",
      "quota_busy",
    ]);
  });

  it("maps each code to its HTTP status", () => {
    expect(QUOTA_ERROR_STATUS).toEqual({
      quota_none: 402,
      quota_exceeded: 402,
      quota_paused: 402,
      model_not_allowed: 403,
      model_not_priced: 409,
      pricing_unavailable: 503,
      quota_context_missing: 500,
      quota_busy: 503,
    });
  });

  it("recognises the two new codes", () => {
    expect(isQuotaErrorCode("quota_context_missing")).toBe(true);
    expect(isQuotaErrorCode("quota_busy")).toBe(true);
  });

  it("has a status for every code and no extra keys", () => {
    expect(Object.keys(QUOTA_ERROR_STATUS).sort()).toEqual([...QUOTA_ERROR_CODES].sort());
  });

  it("recognises only the exact codes", () => {
    expect(isQuotaErrorCode("quota_paused")).toBe(true);
    expect(isQuotaErrorCode("quota_exhausted")).toBe(false);
    expect(isQuotaErrorCode("Quota_None")).toBe(false);
    expect(isQuotaErrorCode(undefined)).toBe(false);
  });
});
