import { describe, expect, it } from "vitest";
import type { ContentPart } from "@agentforge/core";
import { historyMediaPart } from "./chat-history-note";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("historyMediaPart", () => {
  it("names the stored reference of each picture and video the assistant made, for later turns", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "Here you go." },
      { type: "image_url", image_url: { url: `/api/v1/media/${ID_A}/file` } },
      { type: "video_url", video_url: { url: `/api/v1/media/${ID_B}/file` } },
    ];
    const part = historyMediaPart(parts);
    expect(part?.type).toBe("text");
    const text = part?.type === "text" ? part.text : "";
    expect(text).toContain(`reference: /api/v1/media/${ID_A}/file`);
    expect(text).toContain(`reference: /api/v1/media/${ID_B}/file`);
    expect(text).toContain("image_generate or video_generate");
  });

  it("is null when the reply has no stored media", () => {
    expect(historyMediaPart([{ type: "text", text: "hello" }])).toBeNull();
  });

  it("never names a remote link or a data URL: only what the host stored is a reference", () => {
    const parts: ContentPart[] = [
      { type: "image_url", image_url: { url: "https://cdn.example.test/cat.png" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ];
    expect(historyMediaPart(parts)).toBeNull();
  });
});
