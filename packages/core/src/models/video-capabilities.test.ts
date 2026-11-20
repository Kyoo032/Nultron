import { describe, expect, it } from "vitest";
import {
  allowedVideoSeconds,
  snapVideoSeconds,
  clampVideoSeconds,
  usesSeedanceVideoWire,
  videoCapabilities,
} from "./video-capabilities";

describe("videoCapabilities", () => {
  it("reads each model's controls from its spec: Seedance has ratio, resolution, sound", () => {
    expect(usesSeedanceVideoWire("seedance-2.0-fast")).toBe(true);
    expect(videoCapabilities("seedance-2.0-fast")).toEqual({
      ratio: true,
      resolution: true,
      seconds: true,
      still: true,
      imageToVideo: true,
      audio: true,
    });
    expect(videoCapabilities("doubao-seedance-2-0-260128")).toMatchObject({ ratio: true, resolution: true, audio: true });
    // Seedance 1.0 has no generate_audio in the published schema.
    expect(videoCapabilities("seedance-1.0-pro").audio).toBe(false);
  });

  it("no longer hands Kling or Veo the Seedance body", () => {
    expect(usesSeedanceVideoWire("kling-v1")).toBe(false);
    expect(usesSeedanceVideoWire("veo_3_1-fast")).toBe(false);
    expect(usesSeedanceVideoWire("sora-2")).toBe(false);
    expect(videoCapabilities("kling-v1")).toEqual({
      ratio: true,
      resolution: false,
      seconds: true,
      still: true,
      imageToVideo: true,
      audio: false,
    });
    // Kling 3.0 Turbo has resolution and a length but no aspect field.
    expect(videoCapabilities("kling-3.0-turbo")).toMatchObject({ ratio: false, resolution: true, audio: false });
  });

  it("gives Grok a ratio and a resolution, because its docs name both fields", () => {
    expect(usesSeedanceVideoWire("grok-imagine-video")).toBe(false);
    expect(videoCapabilities("grok-imagine-video")).toEqual({
      ratio: true,
      resolution: true,
      seconds: true,
      still: true,
      imageToVideo: true,
      audio: false,
    });
    expect(videoCapabilities("unknown-video-model")).toEqual({
      ratio: false,
      resolution: false,
      seconds: true,
      still: true,
      imageToVideo: false,
      audio: false,
    });
  });

  it("sets imageToVideo fail-closed (G-20)", () => {
    expect(videoCapabilities("dreamina-seedance-2-0-260128").imageToVideo).toBe(true);
    expect(videoCapabilities("veo_3_1").imageToVideo).toBe(true);
    expect(videoCapabilities("grok-imagine-video-1.5-preview").imageToVideo).toBe(true);
    expect(videoCapabilities("omni-fast").imageToVideo).toBe(true);
    expect(videoCapabilities("omni-fast-v2v").imageToVideo).toBe(false);
    expect(videoCapabilities("mj_video").imageToVideo).toBe(false);
    expect(videoCapabilities("totally-unknown").imageToVideo).toBe(false);
    // No documented still shape, so no still is sent (the Kling omni image item is not in the docs).
    expect(videoCapabilities("kling-v3-omni").imageToVideo).toBe(false);
    // A Sora id has no route or body in the gateway docs: refused a still rather than sent a guess.
    expect(videoCapabilities("sora-2").imageToVideo).toBe(false);
  });

  it("keeps the model-less clamp for the direct-Ark path only", () => {
    expect(clampVideoSeconds()).toBe(5);
    expect(clampVideoSeconds(1)).toBe(2);
    expect(clampVideoSeconds(20)).toBe(12);
    expect(clampVideoSeconds(8.4)).toBe(8);
  });
});

describe("allowedVideoSeconds / snapVideoSeconds", () => {
  it("lists each model's own lengths", () => {
    expect(allowedVideoSeconds("veo_3_1-fast")).toEqual([4, 6, 8]);
    expect(allowedVideoSeconds("veo_3_1")).toEqual([4, 6, 8]);
    expect(allowedVideoSeconds("seedance-2.0-fast")).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(allowedVideoSeconds("seedance-2.5")).toContain(30);
    expect(allowedVideoSeconds("grok-imagine-video")).toEqual([6, 10]);
  });

  it("snaps a requested length to the nearest accepted one", () => {
    expect(snapVideoSeconds("veo_3_1-fast", 5)).toBe(4);
    expect(snapVideoSeconds("veo_3_1-fast", 7)).toBe(6);
    expect(snapVideoSeconds("veo_3_1-fast", 10)).toBe(8);
    expect(snapVideoSeconds("veo_3_1-fast", undefined)).toBe(4);
    expect(snapVideoSeconds("seedance-2.0-fast", 5)).toBe(5);
    // 12 s is a real Seedance length; the old picker stopped at 10.
    expect(snapVideoSeconds("seedance-2.0-fast", 12)).toBe(12);
    expect(snapVideoSeconds("seedance-2.0-fast", 40)).toBe(15);
    expect(snapVideoSeconds("seedance-2.5", 40)).toBe(30);
  });
});
