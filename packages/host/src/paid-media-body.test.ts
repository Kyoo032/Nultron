import { describe, expect, it } from "vitest";
import { PAID_MEDIA_GRANTS_MAX, readMediaPermission } from "./paid-media-body";

describe("readMediaPermission", () => {
  it("always asks, and holds no grant when the body names none", () => {
    expect(readMediaPermission({ content: "hi" })).toEqual({ ask: true, grants: [] });
    expect(readMediaPermission(null)).toEqual({ ask: true, grants: [] });
    expect(readMediaPermission({ paidMedia: "yes" })).toEqual({ ask: true, grants: [] });
    expect(readMediaPermission({ paidMedia: { ask: false } })).toEqual({ ask: true, grants: [] });
  });

  it("reads the requests the person pressed Run on, down to the fields that name them", () => {
    const policy = readMediaPermission({
      paidMedia: {
        grants: [
          { tool: "image_generate", args: { prompt: "  a red\nfox ", style: "", extra: "x" } },
          { tool: "video_generate", args: { prompt: "a fox runs", seconds: 5 } },
        ],
      },
    });
    expect(policy.grants).toEqual([
      { tool: "image_generate", args: { prompt: "a red fox" } },
      { tool: "video_generate", args: { prompt: "a fox runs", seconds: 5 } },
    ]);
  });

  it("drops a grant for another tool, one with no prompt, and one that is not an object", () => {
    const policy = readMediaPermission({
      paidMedia: {
        grants: [
          { tool: "web_search", args: { prompt: "x" } },
          { tool: "image_generate", args: { aspect_ratio: "square" } },
          { tool: "image_generate" },
          "image_generate",
          null,
        ],
      },
    });
    expect(policy.grants).toEqual([]);
  });

  it("keeps no more than the card list can hold", () => {
    const grants = Array.from({ length: PAID_MEDIA_GRANTS_MAX + 5 }, (_, index) => ({
      tool: "image_generate",
      args: { prompt: `fox ${index}` },
    }));
    expect(readMediaPermission({ paidMedia: { grants } }).grants).toHaveLength(PAID_MEDIA_GRANTS_MAX);
  });
});
