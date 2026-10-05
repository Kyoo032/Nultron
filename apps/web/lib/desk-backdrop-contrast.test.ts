import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RIPPLE_PEAK_OPACITY } from "./desk-ripple";

/**
 * The desk's backdrop tints the ground text is read on: the wash at the top of the canvas, the soft light
 * that trails the pointer and, for 560 ms, the fill of a click's ring. They are all in the page's mode colour
 * and they stack, so the worst ground a line of text can land on is the surface with all three over it.
 * Text on a bare desk (headers, section titles, hints) is held to 4.5:1 there, in both themes and in every
 * mode's colour. Cards and panels paint their own surface over the backdrop and are not in question.
 *
 * The percentages are read from the stylesheet, so raising one fails here before it reaches a screen.
 */

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "app", "globals.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule missing from globals.css`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

function tokens(selector: string): Map<string, string> {
  return new Map([...block(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

type Rgb = readonly [number, number, number];

function hex(value: string | undefined): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec((value ?? "").trim());
  expect(match, `not a hex colour: ${value}`).not.toBeNull();
  const raw = (match as RegExpExecArray)[1];
  return [0, 2, 4].map((at) => Number.parseInt(raw.slice(at, at + 2), 16)) as unknown as Rgb;
}

/** `top` painted over `ground` at `alpha`, the way a translucent layer composites. */
const over = (top: Rgb, ground: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => (top[i] as number) * alpha + (ground[i] as number) * (1 - alpha)) as unknown as Rgb;

function luminance([r, g, b]: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The percentage of the first `color-mix(in srgb, <page-mode> N%, ...)` in a rule's declarations. */
function modePercent(declarations: string, label: string): number {
  const match = /color-mix\(in srgb,\s*var\(--page-mode,\s*var\(--accent\)\)\s*([\d.]+)%/.exec(declarations);
  expect(match, `${label}: no page-mode colour mix found`).not.toBeNull();
  return Number((match as RegExpExecArray)[1]) / 100;
}

const wash = modePercent(block(".desk-canvas"), ".desk-canvas wash");
const spot = modePercent(block(".desk-spot"), ".desk-spot");
const ripple = (() => {
  // The ring's fill is the last mix in the rule; its border is a line, not a ground.
  const mixes = [
    ...block(".desk-ripple").matchAll(/color-mix\(in srgb,\s*var\(--page-mode,\s*var\(--accent\)\)\s*([\d.]+)%/g),
  ];
  expect(mixes.length, ".desk-ripple fill missing").toBeGreaterThan(0);
  // The ring is at most this opaque, and only for its first frame: the fill is scaled by it.
  return (Number((mixes[mixes.length - 1] as RegExpExecArray)[1]) / 100) * RIPPLE_PEAK_OPACITY;
})();

const themes = [
  { name: "light", tokens: new Map([...tokens(":root"), ...tokens(".light")]) },
  { name: "dark", tokens: new Map([...tokens(":root"), ...tokens(".dark")]) },
] as const;

describe("the desk backdrop keeps text readable", () => {
  it("reads sensible strengths from the stylesheet (guards the checks below)", () => {
    expect(wash).toBeGreaterThan(0);
    expect(wash).toBeLessThan(0.3);
    expect(spot).toBeGreaterThan(0);
    expect(spot).toBeLessThan(0.3);
    expect(ripple).toBeGreaterThan(0);
  });

  for (const { name, tokens: theme } of themes) {
    const modes = [...theme.keys()].filter((token) => /^--mode-[a-z]+$/.test(token));

    it(`holds 4.5:1 for body text on the worst backdrop in the ${name} theme, in every mode's colour`, () => {
      expect(modes.length, "no --mode-* tokens found").toBeGreaterThan(10);
      const surface = hex(theme.get("--surface"));
      const failures: string[] = [];
      for (const mode of [...modes, "--accent"]) {
        const colour = hex(theme.get(mode));
        const ground = over(colour, over(colour, over(colour, surface, wash), spot), ripple);
        for (const text of ["--text", "--text-2", "--text-3"]) {
          const ratio = contrast(hex(theme.get(text)), ground);
          if (ratio < 4.5) {
            failures.push(`${text} on ${mode} wash+spot+ring: ${ratio.toFixed(2)}:1`);
          }
        }
      }
      expect(failures, `text falls under 4.5:1 on the stacked backdrop:\n  ${failures.join("\n  ")}`).toEqual([]);
    });
  }
});
