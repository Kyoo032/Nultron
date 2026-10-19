import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { studioPickerEmpty } from "./studio-picker-empty";

const components = resolve(dirname(fileURLToPath(import.meta.url)), "../components");

function source(name: string): string {
  return readFileSync(resolve(components, name), "utf8");
}

const listedEmpty = { loading: false, keyMissing: false, listed: true, models: [] as { id: string }[] };

describe("studioPickerEmpty", () => {
  it("is true once the list came back with nothing and the key is in place", () => {
    expect(studioPickerEmpty(listedEmpty)).toBe(true);
  });

  it("is false while the list is still loading", () => {
    expect(studioPickerEmpty({ ...listedEmpty, loading: true })).toBe(false);
  });

  it("is false before a list has loaded, so a failed read never says the key lists nothing", () => {
    expect(studioPickerEmpty({ ...listedEmpty, listed: false })).toBe(false);
  });

  it("is false while the key is missing, because that state has its own note", () => {
    expect(studioPickerEmpty({ ...listedEmpty, keyMissing: true })).toBe(false);
  });

  it("is false as soon as the list has one model", () => {
    expect(studioPickerEmpty({ ...listedEmpty, models: [{ id: "gpt-image-2" }] })).toBe(false);
  });
});

describe("the Images and Videos studios explain an empty model list", () => {
  const STUDIOS: Array<{ file: string; mode: string; submitGuard: string }> = [
    {
      file: "images-studio.tsx",
      mode: "images",
      submitGuard: "disabled={generating || !prompt.trim() || needsKey || noModels}",
    },
    {
      file: "videos-studio.tsx",
      mode: "videos",
      submitGuard: "disabled={generating || !keyReady || !prompt.trim() || noModels}",
    },
  ];

  for (const { file, mode, submitGuard } of STUDIOS) {
    it(`${file} asks the shared decision and renders the card under its own testid`, () => {
      const studio = source(file);
      expect(studio).toContain('import { studioPickerEmpty } from "@/lib/studio-picker-empty";');
      expect(studio).toContain("const noModels = studioPickerEmpty({ listed, loading, keyMissing:");
      expect(studio).toContain(`data-testid="${mode}-studio-no-models"`);
      expect(studio).toContain(submitGuard);
    });

    it(`${file} sets the listed flag only on the successful read`, () => {
      const studio = source(file);
      expect(studio).toMatch(/setModels\(data\.models \?\? \[\]\);\s*setListed\(true\);/);
    });
  }
});
