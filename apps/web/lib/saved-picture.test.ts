import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaReferenceId } from "@agentforge/core/tools/media-reference";
import { describe, expect, it } from "vitest";
import { pickableSavedPictures, savedPictureReference, stillSource } from "./saved-picture";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(join(web, file), "utf8").replace(/\r\n/g, "\n");

const ID = "7f9c2a1e-4b3d-4e8f-9a0b-1c2d3e4f5a6b";

describe("savedPictureReference", () => {
  it("builds the relative media path the host reads as a stored reference", () => {
    expect(savedPictureReference(ID)).toBe(`/api/v1/media/${ID}/file`);
  });

  it("round-trips through the host's own reference parser to the same id", () => {
    expect(mediaReferenceId(savedPictureReference(ID))).toBe(ID);
  });

  it("is never the absolute desktop scheme, which the host would take for a plain URL", () => {
    expect(savedPictureReference(ID).startsWith("agentforge://")).toBe(false);
  });
});

describe("pickableSavedPictures", () => {
  it("drops rows whose file is gone and keeps the rest in order", () => {
    const items = [
      { id: "a", url: "/api/v1/media/a/file", prompt: "one" },
      { id: "b", url: "/api/v1/media/b/file", fileMissing: true },
      { id: "c", url: "/api/v1/media/c/file", fileMissing: false },
    ];
    expect(pickableSavedPictures(items).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("answers an empty list for an empty gallery", () => {
    expect(pickableSavedPictures([])).toEqual([]);
  });
});

describe("stillSource", () => {
  it("sends the picked picture as a stored reference and ignores the typed box", () => {
    expect(stillSource({ id: ID }, "https://example.test/a.png", true)).toBe(savedPictureReference(ID));
  });

  it("sends a typed URL trimmed when nothing is picked", () => {
    expect(stillSource(null, "  https://example.test/a.png  ", true)).toBe("https://example.test/a.png");
  });

  it("sends nothing for an empty box with nothing picked", () => {
    expect(stillSource(null, "   ", true)).toBeUndefined();
  });

  it("sends nothing on a text-to-video model, even with a pick left over", () => {
    expect(stillSource({ id: ID }, "https://example.test/a.png", false)).toBeUndefined();
  });
});

describe("the Videos studio routes its still through the picker", () => {
  const studio = source("components/videos-studio.tsx");

  it("sends the still through stillSource, not a bare trim", () => {
    expect(studio).toContain("imageUrl: stillSource(savedPicture, stillUrl, imageToVideo),");
    expect(studio).not.toContain("imageUrl: imageToVideo ? stillUrl.trim()");
  });

  it("renders the picker only inside the image-to-video branch", () => {
    const branch = studio.indexOf("{imageToVideo ? (");
    const picker = studio.indexOf("<SavedPicturePicker");
    const textToVideo = studio.indexOf(") : model ? (");
    expect(branch).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(branch);
    expect(picker).toBeLessThan(textToVideo);
  });

  it("types the still box as text, so the browser's URL check does not block a stored reference", () => {
    expect(studio).toContain('data-testid="videos-studio-still"');
    expect(studio).not.toMatch(/type="url"/);
    expect(studio).toMatch(/type="text"\s+inputMode="url"/);
  });

  it("clears a pick wherever the still is cleared", () => {
    expect(studio).toMatch(/if \(!imageToVideo\) \{\s*setStillUrl\(""\);\s*setSavedPicture\(null\);\s*\}/);
    expect(studio).toMatch(/setStillUrl\(""\);\s*setSavedPicture\(null\);\s*await load\(\);/);
    expect(studio).toMatch(/setSavedPicture\(picture\);\s*setStillUrl\(""\);/);
    expect(studio).toMatch(/setStillUrl\(event\.target\.value\);\s*setSavedPicture\(null\);/);
  });

  it("explains a stored picture the host cannot read, in its own copy", () => {
    expect(studio).toContain('savedPicture && data.error?.code === "not_found"');
    expect(studio).toContain('t("videos.savedPicture.unusable")');
  });
});

describe("the picker reuses the image gallery list and sends an id, never a desktop URL", () => {
  const picker = source("components/saved-picture-picker.tsx");

  it("lists through GET /api/v1/images, the endpoint the Images gallery already reads", () => {
    expect(picker).toContain('apiFetch("/api/v1/images")');
  });

  it("fetches only when opened, not when the studio mounts", () => {
    expect(picker).toContain("if (open) {");
    expect(picker.indexOf("apiFetch(")).toBeGreaterThan(picker.indexOf("if (open) {"));
  });

  it("filters out rows whose file is gone", () => {
    expect(picker).toContain("pickableSavedPictures(data.items ?? [])");
  });

  it("hands the picked picture up and lets the studio build the reference", () => {
    expect(picker).toContain("onPick(picture);");
    expect(picker).not.toContain("savedPictureReference");
  });
});
