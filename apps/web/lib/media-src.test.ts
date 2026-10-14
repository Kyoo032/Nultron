import { describe, expect, it } from "vitest";
import { desktopMediaSrc, mediaIdFromSrc } from "./media-src";

describe("desktopMediaSrc", () => {
  it("leaves every url alone in the browser", () => {
    expect(desktopMediaSrc("/api/v1/media/abc/file", false)).toBe("/api/v1/media/abc/file");
    expect(desktopMediaSrc("/api/v1/videos/examples/daisy-macro.mp4/file", false)).toBe(
      "/api/v1/videos/examples/daisy-macro.mp4/file",
    );
    expect(desktopMediaSrc("https://cdn.example/a.mp4", false)).toBe("https://cdn.example/a.mp4");
  });

  it("maps gallery media to agentforge://media in the desktop shell", () => {
    expect(desktopMediaSrc("/api/v1/media/abc-123/file", true)).toBe("agentforge://media/abc-123");
  });

  it("maps bundled example clips to agentforge://video-example in the desktop shell", () => {
    expect(desktopMediaSrc("/api/v1/videos/examples/daisy-macro.mp4/file", true)).toBe(
      "agentforge://video-example/daisy-macro.mp4",
    );
  });

  it("passes remote and unknown urls through unchanged in the desktop shell", () => {
    expect(desktopMediaSrc("https://cdn.example/a.mp4", true)).toBe("https://cdn.example/a.mp4");
    expect(desktopMediaSrc("/api/v1/videos", true)).toBe("/api/v1/videos");
  });
});

describe("mediaIdFromSrc", () => {
  const ID = "0b8f1c2e-4a5d-4e6f-8a9b-1c2d3e4f5a6b";

  it("reads the stored id from the host path and from the desktop shell form", () => {
    expect(mediaIdFromSrc(`/api/v1/media/${ID}/file`)).toBe(ID);
    expect(mediaIdFromSrc(`agentforge://media/${ID}`)).toBe(ID);
    expect(mediaIdFromSrc(`https://host.example/api/v1/media/${ID}/file?v=2`)).toBe(ID);
  });

  it("is null for a remote picture, a video example, or anything that is not a stored id", () => {
    expect(mediaIdFromSrc("https://cdn.example/a.png")).toBeNull();
    expect(mediaIdFromSrc("/api/v1/videos/examples/daisy-macro.mp4/file")).toBeNull();
    expect(mediaIdFromSrc("/api/v1/media/not-a-uuid/file")).toBeNull();
    expect(mediaIdFromSrc("")).toBeNull();
    expect(mediaIdFromSrc(undefined)).toBeNull();
  });
});
