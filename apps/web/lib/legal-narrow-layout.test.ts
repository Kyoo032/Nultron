/**
 * The Legal matter form on a narrow pane (2026-10-01 UI pass), held by the shape of its markup.
 *
 * Node has no layout engine, so this cannot measure a width; it holds the rules the widths depend on.
 * The widths themselves were driven live on webdev at 390, 768, 1024 and 1440 px, in both locales
 * (`docs/internal/unreleased.md`, 2026-10-01 "Narrow-pane layouts"): at 390 px the card is 224 px wide.
 *
 * The traps this guards:
 * - `.seg`, `.seg-opt` and `.input` are unlayered, so they beat any Tailwind utility that sets the same
 *   property (display, padding, width, font-size). Only wrap, width and flex can be set from a class.
 * - `legal-work-type` was 279 px in a 224 px card and ran 14 px past the pane; "Pemberi pinjaman" and
 *   "Penyusunan" are wider than their English labels.
 * - The model selects were `.input w-auto px-2 py-1 text-[12px]`, every utility of which `.input`
 *   discarded, so the selects were 173 to 179 px and cut "GPT 6 Sol — Everyday chat".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../locales/en/legal.json";
import id from "../locales/id/legal.json";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");

/** The string a top-level `const NAME = "..."` holds. */
function constant(source: string, name: string): string {
  const found = new RegExp(`const ${name} = "([^"]*)";`).exec(source);
  expect(found, `${name} is missing; the form's markup changed, update this test with it`).not.toBeNull();
  return found?.[1] ?? "";
}

describe("the matter form's segmented controls", () => {
  const panel = read("components", "legal-matter-panel.tsx");

  it("wrap instead of clipping, and never rely on a utility `.seg` would override", () => {
    const side = constant(panel, "SIDE_SEG");
    expect(side.split(" ")).toEqual(expect.arrayContaining(["seg", "max-w-full", "flex-wrap"]));
    const work = constant(panel, "WORK_SEG");
    expect(work.split(" ")).toEqual(expect.arrayContaining(["seg", "w-full", "flex-wrap"]));
    // `.seg { display: inline-flex }` and `.seg-opt { padding }` win over `flex` / `px-*`, so none is set.
    for (const className of [side, work, constant(panel, "SIDE_OPT"), constant(panel, "WORK_OPT")]) {
      expect(className).not.toMatch(/(^|\s)(flex|grid|block|px-\S+|py-\S+|p-\S+)(\s|$)/);
    }
  });

  it("lets the options grow into a row and splits Work two and two in a card of 24rem or less", () => {
    expect(constant(panel, "SIDE_OPT").split(" ")).toEqual(expect.arrayContaining(["seg-opt", "flex-auto"]));
    const option = constant(panel, "WORK_OPT");
    expect(option.split(" ")).toEqual(expect.arrayContaining(["seg-opt", "flex-auto"]));
    expect(option).toContain("[@container(max-width:24rem)]:basis-1/2");
    // The query reads the wrapper's width, so the wrapper is the size container.
    expect(constant(panel, "WORK_BOX")).toContain("[container-type:inline-size]");
  });

  it("keeps every testid the recipe and the e2e spec read", () => {
    expect(panel).toContain('data-testid="legal-work-type"');
    expect(panel).toMatch(/data-testid=\{`legal-work-type-\$\{workType\}`\}/);
    expect(panel).toContain('data-testid="legal-side"');
    expect(panel).toMatch(/data-testid=\{`legal-side-\$\{role\}`\}/);
    expect(panel).toContain("className={SIDE_SEG}");
    expect(panel).toContain("className={WORK_SEG}");
    expect(panel).toContain("className={WORK_BOX}");
    expect(panel).not.toMatch(/className="seg[ "]/);
  });

  it("keeps the counterparty row inside a card narrower than its 16rem column", () => {
    // `minmax(16rem, 1fr)` made the column 256 px in a 224 px card: the input stuck 32 px out of it.
    expect(panel).toContain("grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),1fr))]");
    expect(panel).not.toContain("minmax(16rem,1fr)");
  });
});

describe("the model and verifier selects", () => {
  const map = read("components", "legal-matter-map.tsx");

  it("use `select-field`, which utilities can resize, and take the rest of a full-width label", () => {
    const select = constant(map, "MODEL_SELECT");
    expect(select.split(" ")).toEqual(
      expect.arrayContaining(["select-field", "min-w-[12rem]", "flex-1", "px-2", "text-[12px]"]),
    );
    // `.input` is unlayered: `w-auto px-2 py-1 text-[12px]` beside it did nothing.
    expect(map).not.toMatch(/className="input w-auto/);
    expect(map.match(/className=\{MODEL_SELECT\}/g)?.length).toBe(2);
    const labels = [...map.matchAll(/<label className=\{`([^`]*)`\}>/g)].map((m) => m[1] ?? "");
    expect(labels.length).toBe(2);
    for (const label of labels) {
      expect(label).toContain("w-full");
      expect(label).toContain("flex-wrap");
    }
  });
});

describe("the one-line Legal placeholders", () => {
  // About 200 px at the form's 14 px font, which is what an input in the 390 px card has to spare. A
  // placeholder longer than that was cut ("Matter title, e.g. Meridian credit agreement, turn 3" was
  // 367 px of 298 at 1024 px). The instructions textarea wraps, so it is not held to this.
  const BUDGET = 27;

  for (const [locale, catalog] of [
    ["en", en],
    ["id", id],
  ] as const) {
    it(`fits ${BUDGET} characters in ${locale}`, () => {
      const placeholders = Object.entries(catalog.matter).filter(
        ([key]) => key.endsWith("Placeholder") && key !== "instructionsPlaceholder",
      );
      expect(placeholders.length).toBeGreaterThanOrEqual(7);
      for (const [key, text] of placeholders) {
        expect(String(text).length, `legal.matter.${key}: "${text}"`).toBeLessThanOrEqual(BUDGET);
      }
    });
  }
});
