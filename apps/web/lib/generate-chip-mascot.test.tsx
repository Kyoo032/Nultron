/**
 * The mascot beside a busy generate control is decorative (2026-09-29 sweep). Documents, Images, Music,
 * Videos and Presentations put a `MascotSlot` beside the button that reads "Generating…", and it drew the
 * character with its own name ("Painting", "Filming", ...), so a screen reader announced the character
 * next to the status that already says it. Edit's export chip has the same status line beside it. A
 * decorative mascot is `aria-hidden` with no role, name or tooltip, as job progress and the chat error
 * line already are.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MascotSlot } from "@/components/mascot-slot";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { MASCOT_MODE_HOME, type MascotMode, mascotLabelKey } from "./mascot-states";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(web, "components", file), "utf8").replace(/\r\n/g, "\n");

const CHIPS: [MascotMode, string][] = [
  ["documents", "documents-studio.tsx"],
  ["images", "images-studio.tsx"],
  ["music", "music-studio.tsx"],
  ["videos", "videos-studio.tsx"],
  ["presentations", "presentations-studio.tsx"],
  ["edit", "edit-studio.tsx"],
];

/**
 * Presentations streams its job phases, so its busy chip is the one `JobProgressList` mounts beside the
 * phase list rather than a bare `MascotSlot` in the studio. The studio must mount that list for its mode,
 * and the list's own chip must be decorative.
 */
const VIA_PROGRESS_LIST: MascotMode[] = ["presentations"];

afterEach(() => resetLocaleForTests());

describe("the busy chip beside a generate control", () => {
  it("is mounted decorative in every studio that has one", () => {
    for (const [mode, file] of CHIPS) {
      const source = read(file);
      if (VIA_PROGRESS_LIST.includes(mode)) {
        expect(source, `${file} mounts the job progress list`).toMatch(
          new RegExp(`<JobProgressList\\b[^>]*mode="${mode}"`),
        );
        continue;
      }
      const tags = [...source.matchAll(/<MascotSlot\b[^>]*\/>/g)]
        .map(([tag]) => tag)
        .filter((tag) => tag.includes('placement="beside"'));
      expect(tags.length, `${file} has a busy chip`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${file} (${mode})`).toMatch(/\bdecorative\b/);
      }
    }
  });

  it("is decorative inside the job progress list too", () => {
    const tags = [...read("job-progress.tsx").matchAll(/<MascotSlot\b[\s\S]*?\/>/g)]
      .map(([tag]) => tag)
      .filter((tag) => tag.includes('placement="beside"'));
    expect(tags.length, "job-progress.tsx has a busy chip").toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toMatch(/\bdecorative\b/);
    }
  });

  it("renders with no role, name or tooltip, so a screen reader hears only the status beside it", () => {
    applyLocale("en");
    for (const [mode] of CHIPS) {
      const html = renderToStaticMarkup(<MascotSlot mode={mode} placement="beside" busy decorative />);
      const label = t(mascotLabelKey(MASCOT_MODE_HOME[mode]));
      expect(html, mode).toContain('aria-hidden="true"');
      expect(html, mode).not.toContain('role="img"');
      expect(html, mode).not.toContain("aria-label");
      expect(html, mode).not.toContain("title=");
      expect(html, mode).not.toContain(label);
    }
  });

  it("is what the test would catch: the same chip without `decorative` announces the character", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MascotSlot mode="images" placement="beside" busy />);
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${t("common.mascot.painting")}"`);
  });
});
