import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SavedPicturePicker } from "@/components/saved-picture-picker";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(web, "components", "saved-picture-picker.tsx"), "utf8");

afterEach(() => {
  resetLocaleForTests();
});

describe("SavedPicturePicker before it is opened", () => {
  it("renders only the toggle, with no list and no request", () => {
    const html = renderToStaticMarkup(<SavedPicturePicker disabled={false} onPick={() => {}} />);
    expect(html).toContain('data-testid="videos-studio-saved-open"');
    expect(html).toContain(t("videos.savedPicture.open"));
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("videos-studio-saved-list");
    expect(html).not.toContain("videos-studio-saved-empty");
  });

  it("makes the toggle a plain button, so it never submits the prompt form around it", () => {
    const html = renderToStaticMarkup(<SavedPicturePicker disabled={false} onPick={() => {}} />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-testid="videos-studio-saved-open"/);
  });

  it("disables the toggle while a generate is running", () => {
    const html = renderToStaticMarkup(<SavedPicturePicker disabled onPick={() => {}} />);
    expect(html).toMatch(/data-testid="videos-studio-saved-open"[^>]*disabled=""|disabled=""[^>]*data-testid="videos-studio-saved-open"/);
  });

  it("speaks Indonesian when the desk is in Indonesian", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<SavedPicturePicker disabled={false} onPick={() => {}} />);
    expect(html).toContain("Pakai gambar tersimpan");
    expect(html).not.toContain("Use a saved image");
  });
});

describe("SavedPicturePicker markup", () => {
  it("gives every button type=button, so none of them submits the surrounding form", () => {
    const opens = source.match(/<button/g)?.length ?? 0;
    const typed = source.match(/<button\s+type="button"/g)?.length ?? 0;
    expect(opens).toBeGreaterThan(0);
    expect(typed).toBe(opens);
  });

  it("keeps the picture and not the URL as the thing handed up", () => {
    expect(source).toContain("onPick: (picture: SavedPicture) => void;");
  });
});
