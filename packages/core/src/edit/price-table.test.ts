import { describe, expect, it } from "vitest";
import { estimateJobUsd } from "./price-table";

describe("estimateJobUsd", () => {
  const now = new Date("2026-09-06T00:00:00.000Z");

  it("estimates known rows", () => {
    expect(estimateJobUsd("grok-imagine-video", { seconds: 5 }, now)).toBeCloseTo(0.3);
    expect(estimateJobUsd("seedance-2.0-fast", { seconds: 2, resolution: "720p" }, now)).toBeCloseTo(0.6);
    expect(estimateJobUsd("seedance-2.0-fast", { seconds: 2, resolution: "1080p" }, now)).toBeCloseTo(1.2);
    expect(estimateJobUsd("gpt-image-2", { count: 2 }, now)).toBeCloseTo(0.08);
  });

  it("prices a gpt-image-2.5 image from the tokens the prepaid key was billed (2026-11-12, medium, 1024x1024)", () => {
    const measured = new Date("2026-11-12T00:00:00.000Z");
    // 22 text tokens in at about $5 per million, 439 image tokens out at about $30 per million.
    expect(estimateJobUsd("gpt-image-2.5-flare", {}, measured)).toBeCloseTo(0.0133, 4);
    expect(estimateJobUsd("gpt-image-2.5-sunburst", { count: 3 }, measured)).toBeCloseTo(0.0399, 4);
    // Cheaper than a gpt-image-2 image, which the same table keeps at its own row.
    expect(estimateJobUsd("gpt-image-2.5-flare", {}, measured)).toBeLessThan(estimateJobUsd("gpt-image-2", {}, measured) ?? 0);
    // Only the two ids that were driven: a -token or -count spelling has no row here.
    expect(estimateJobUsd("gpt-image-2.5-flare-token", {}, measured)).toBeNull();
  });

  it("returns null for unknown models", () => {
    expect(estimateJobUsd("not-a-model", { seconds: 5 }, now)).toBeNull();
  });

  it("returns null when asOf is older than 90 days", () => {
    const staleNow = new Date("2027-01-01T00:00:00.000Z");
    expect(estimateJobUsd("grok-imagine-video", { seconds: 5 }, staleNow)).toBeNull();
  });
});
