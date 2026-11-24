/**
 * The studios' media controls: each model shows the controls it has and only the values it takes.
 *
 * Every case renders the real `VideoControls` / `ImageControls` to a string for a model's spec from the
 * built-in table (`@agentforge/core/media-params`), so the page and the server read one table. Picking
 * a model again moves each value to the nearest one the new model takes (`fitVideoPick`,
 * `fitImagePick`) and says so. The clicks, and the request a pick becomes on the wire, are driven live:
 * `.cursor/skills/verify-agentforge/features/models.md`, "Media options".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageSpecFor, videoSpecFor } from "@agentforge/core/media-params";
import { mediaKind } from "@agentforge/core/media-kind";
import { ImageControls, UnverifiedNote, VideoControls } from "@/components/media-controls";
import { MediaControlsNote } from "@/components/media-controls-note";
import { applyLocale, resetLocaleForTests } from "./i18n";
import {
  adjustedNote,
  fitImagePick,
  fitVideoPick,
  imageRequestFields,
  imageSentNote,
  videoRequestFields,
  videoSentNote,
  type ImagePick,
  type VideoPick,
} from "./media-options";

beforeEach(() => applyLocale("en"));
afterEach(() => resetLocaleForTests());

/** The option values of the `<UiSelect>` trigger with this test id, in order; `null` when not drawn. */
function optionsOf(html: string, testId: string): string[] | null {
  const button = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, "s").exec(html)?.[0];
  if (!button) {
    return null;
  }
  const raw = /data-options="([^"]*)"/.exec(button)?.[1];
  if (raw === undefined) {
    return null;
  }
  return raw === "" ? [] : raw.split(",");
}

function videoHtml(model: string, pick?: Partial<VideoPick>): string {
  const spec = videoSpecFor(model);
  const fitted = fitVideoPick(spec, pick).pick;
  return renderToStaticMarkup(<VideoControls spec={spec} pick={fitted} onChange={() => undefined} />);
}

function imageHtml(model: string, pick?: ImagePick): string {
  const spec = imageSpecFor(model);
  const fitted = fitImagePick(spec, pick, "square").pick;
  return renderToStaticMarkup(
    <ImageControls spec={spec} pick={fitted} shape={fitted.shape} onChange={() => undefined} />,
  );
}

describe("video controls", () => {
  it("offers Seedance fast 480p and 720p, never 1080p, with the 4-15 s lengths and a sound toggle", () => {
    const html = videoHtml("seedance-2.0-fast");
    expect(optionsOf(html, "videos-studio-resolution")).toEqual(["480p", "720p"]);
    expect(html).not.toContain("1080p");
    const seconds = optionsOf(html, "videos-studio-seconds") ?? [];
    expect(seconds[0]).toBe("4");
    expect(seconds).toContain("5");
    expect(seconds).toContain("15");
    expect(seconds).not.toContain("2");
    expect(html).toContain('data-testid="videos-studio-audio"');
  });

  it("offers full Seedance 2.0 the higher tiers the fast model lacks", () => {
    expect(optionsOf(videoHtml("seedance-2.0"), "videos-studio-resolution")).toEqual(
      expect.arrayContaining(["480p", "720p", "1080p"]),
    );
  });

  it("offers Seedance 2.5 up to 30 seconds", () => {
    const seconds = optionsOf(videoHtml("seedance-2.5"), "videos-studio-seconds") ?? [];
    expect(Math.max(...seconds.map(Number))).toBe(30);
  });

  it("offers Veo only the lengths it takes, and no sound toggle", () => {
    const html = videoHtml("veo_3_1-fast");
    expect(optionsOf(html, "videos-studio-seconds")).toEqual(["4", "6", "8"]);
    expect(html).not.toContain("videos-studio-audio");
  });

  it("offers Grok two ratios, 6 or 10 seconds, no sound toggle", () => {
    const html = videoHtml("grok-imagine-video");
    expect(optionsOf(html, "videos-studio-aspect")).toEqual(["16:9", "9:16"]);
    expect(optionsOf(html, "videos-studio-seconds")).toEqual(["6", "10"]);
    expect(html).not.toContain("videos-studio-audio");
  });

  it("starts at 720p and sound off", () => {
    const pick = fitVideoPick(videoSpecFor("seedance-2.0-fast")).pick;
    expect(pick).toMatchObject({ resolution: "720p", audio: false, seconds: 5 });
  });

  it("draws no select for a field the model does not read", () => {
    const spec = videoSpecFor("seedance-2.0-fast");
    const html = renderToStaticMarkup(
      <VideoControls
        spec={spec}
        pick={fitVideoPick(spec).pick}
        onChange={() => undefined}
        testIdPrefix="edit-generate"
        showAspect={false}
      />,
    );
    expect(optionsOf(html, "edit-generate-aspect")).toBeNull();
    expect(optionsOf(html, "edit-generate-resolution")).toEqual(["480p", "720p"]);
  });

  it("checks the sound toggle only when sound was picked", () => {
    const off = videoHtml("seedance-2.0-fast", { audio: false });
    const on = videoHtml("seedance-2.0-fast", { audio: true });
    const offTag = /<button[^>]*data-testid="videos-studio-audio"[^>]*>/.exec(off)?.[0] ?? "";
    const onTag = /<button[^>]*data-testid="videos-studio-audio"[^>]*>/.exec(on)?.[0] ?? "";
    expect(offTag).toContain('aria-checked="false"');
    expect(onTag).toContain('aria-checked="true"');
  });
});

describe("moving to another video model", () => {
  it("moves 1080p to 720p for Seedance fast and says what moved", () => {
    const previous: VideoPick = { aspect: "16:9", seconds: 5, resolution: "1080p", audio: false };
    const { pick, moved } = fitVideoPick(videoSpecFor("seedance-2.0-fast"), previous);
    expect(pick.resolution).toBe("720p");
    expect(moved.map((item) => item.field)).toContain("resolution");
    const note = adjustedNote("videos", "seedance-2.0-fast", moved) ?? "";
    expect(note).toContain("seedance-2.0-fast");
    expect(note).toContain("1080p");
    expect(note).toContain("720p");
  });

  it("moves 5 s to the nearest length Veo takes", () => {
    const { pick, moved } = fitVideoPick(videoSpecFor("veo_3_1-fast"), {
      aspect: "16:9",
      seconds: 5,
      resolution: "720p",
      audio: false,
    });
    expect([4, 6]).toContain(pick.seconds);
    expect(moved.map((item) => item.field)).toContain("seconds");
  });

  it("leaves everything alone, and says nothing, when the new model takes every value", () => {
    const previous: VideoPick = { aspect: "16:9", seconds: 5, resolution: "720p", audio: false };
    const { moved } = fitVideoPick(videoSpecFor("seedance-2.0"), previous);
    expect(moved).toEqual([]);
    expect(adjustedNote("videos", "seedance-2.0", moved)).toBeNull();
  });

  it("turns sound off for a model that has no switch", () => {
    const { pick } = fitVideoPick(videoSpecFor("grok-imagine-video"), {
      aspect: "16:9",
      seconds: 6,
      resolution: "720p",
      audio: true,
    });
    expect(pick.audio).toBe(false);
  });
});

describe("what a video pick sends", () => {
  it("sends sound only for a model that has the switch, and ratio and resolution only where offered", () => {
    const seedance = videoSpecFor("seedance-2.0-fast");
    expect(videoRequestFields(seedance, fitVideoPick(seedance, { audio: true }).pick)).toMatchObject({
      audio: true,
      resolution: "720p",
      seconds: 5,
    });
    const grok = videoSpecFor("grok-imagine-video");
    expect(videoRequestFields(grok, fitVideoPick(grok).pick)).not.toHaveProperty("audio");
  });

  it("describes what a clip was made with", () => {
    const text = videoSentNote({ resolution: "480p", seconds: 4, aspect: "3:4", audio: true });
    expect(text).toContain("480p");
    expect(text).toContain("4s");
    expect(text).toContain("3:4");
    expect(text).toContain("with sound");
  });
});

describe("image controls", () => {
  it("lists every size gpt-image-2 takes, a quality menu and the formats", () => {
    const html = imageHtml("gpt-image-2");
    expect((optionsOf(html, "images-studio-aspect") ?? []).length).toBeGreaterThan(3);
    expect(optionsOf(html, "images-studio-quality")).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    expect(optionsOf(html, "images-studio-format")).toEqual(expect.arrayContaining(["png", "jpeg"]));
  });

  it("starts at medium quality where the model has quality", () => {
    expect(fitImagePick(imageSpecFor("gpt-image-2"), undefined, "square").pick.quality).toBe("medium");
  });

  it("draws no quality, tier or format menu for a model with none", () => {
    const html = imageHtml("gpt-image-2.5");
    expect(optionsOf(html, "images-studio-quality")).toBeNull();
    expect(optionsOf(html, "images-studio-tier")).toBeNull();
    expect(optionsOf(html, "images-studio-format")).toBeNull();
  });

  it("offers a resolution tier and ratios for the Nano Banana family", () => {
    const html = imageHtml("nano-banana-2");
    expect(optionsOf(html, "images-studio-tier")).toEqual(expect.arrayContaining(["1k", "2k"]));
    expect(optionsOf(html, "images-studio-aspect")).toEqual(expect.arrayContaining(["1:1", "16:9", "9:16"]));
  });

  it("sends only the fields the model has", () => {
    const spec = imageSpecFor("gpt-image-2");
    const fields = imageRequestFields(spec, fitImagePick(spec, undefined, "landscape").pick, "landscape");
    expect(fields.size).toMatch(/^\d+x\d+$/);
    expect(fields.quality).toBe("medium");
    expect(fields).not.toHaveProperty("aspectRatio");
    const banana = imageSpecFor("nano-banana-2");
    const bananaFields = imageRequestFields(banana, fitImagePick(banana, undefined, "square").pick, "square");
    expect(bananaFields.aspectRatio).toBeDefined();
    expect(bananaFields).not.toHaveProperty("size");
  });

  it("moves a size the next model does not take to the nearest one, with a note", () => {
    const previous: ImagePick = { shape: "3840x2160", shapeTouched: true, quality: "high", tier: "", count: 1, format: "" };
    const { pick, moved } = fitImagePick(imageSpecFor("gpt-image-2.5"), previous, "square");
    expect(pick.shape).toBe("1024x1024");
    expect(moved.map((item) => item.field)).toEqual(expect.arrayContaining(["size"]));
    expect(adjustedNote("images", "gpt-image-2.5", moved)).toContain("gpt-image-2.5");
  });

  it("describes what a picture was made at", () => {
    const text = imageSentNote({ shapeValue: "1536x1024", quality: "low", outputFormat: "png", count: 1 } as never);
    expect(text).toContain("1536");
    expect(text).toContain("Low");
    expect(text).toContain("PNG");
  });
});

describe("kling image models", () => {
  it("are images, so they get the image controls and not the video ones", () => {
    expect(mediaKind("kling_image")).toBe("image");
    expect(mediaKind("kling_omni_image")).toBe("image");
    expect(mediaKind("kling-v3")).toBe("video");
  });
});

describe("notes", () => {
  it("draws the changed-for note and the made-with line, and nothing when there is nothing to say", () => {
    const quiet = renderToStaticMarkup(<MediaControlsNote kind="videos" note={null} made={null} />);
    expect(quiet).toBe("");
    const loud = renderToStaticMarkup(
      <MediaControlsNote kind="videos" note="Changed for X: resolution 1080p → 720p." made="Made with 720p." />,
    );
    expect(loud).toContain('data-testid="videos-studio-note"');
    expect(loud).toContain('data-testid="videos-studio-sent"');
  });

  it("flags a spec with values nobody published, and says nothing for a fully published one", () => {
    expect(renderToStaticMarkup(<UnverifiedNote kind="videos" unverified={[]} />)).toBe("");
    const unknown = videoSpecFor("never-heard-of-it-video");
    expect(unknown.unverified.length).toBeGreaterThan(0);
    expect(renderToStaticMarkup(<UnverifiedNote kind="videos" unverified={unknown.unverified} />)).toContain(
      'data-testid="videos-studio-unverified"',
    );
  });
});

describe("the words for every change", () => {
  /** Each field a settle can move has words in both languages, so a note never shows a bare key. */
  it("has a `change` line for every field in en and id", async () => {
    const en = (await import("../locales/en/videos.json")).default as { change: Record<string, string> };
    const id = (await import("../locales/id/videos.json")).default as { change: Record<string, string> };
    const enImages = (await import("../locales/en/images.json")).default as { change: Record<string, string> };
    const idImages = (await import("../locales/id/images.json")).default as { change: Record<string, string> };
    for (const field of ["aspect", "seconds", "resolution", "audio"]) {
      expect(en.change[field], `videos.change.${field} (en)`).toBeTruthy();
      expect(id.change[field], `videos.change.${field} (id)`).toBeTruthy();
    }
    for (const field of ["size", "quality", "tier", "count", "format"]) {
      expect(enImages.change[field], `images.change.${field} (en)`).toBeTruthy();
      expect(idImages.change[field], `images.change.${field} (id)`).toBeTruthy();
    }
  });

  it("writes the note in Indonesian when the desk speaks it", () => {
    applyLocale("id");
    const { moved } = fitVideoPick(videoSpecFor("seedance-2.0-fast"), {
      aspect: "16:9",
      seconds: 5,
      resolution: "1080p",
      audio: false,
    });
    const note = adjustedNote("videos", "seedance-2.0-fast", moved) ?? "";
    expect(note).toContain("seedance-2.0-fast");
    expect(note).not.toContain("videos.");
  });
});
