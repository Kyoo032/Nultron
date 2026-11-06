import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Colour-contrast gate for the warm-desk palette in `app/globals.css` (0.15.0).
 *
 * Every label in the app is painted from a token, so the tokens are the cheapest place to
 * catch a contrast regression. This parses the theme blocks, resolves `var()` and
 * `color-mix(in srgb, …)` the way a browser does (a mix with `transparent` is composited over
 * the surface it sits on), and fails any pair below the WCAG 2.1 threshold.
 *
 * Thresholds (WCAG 2.1):
 *  - 1.4.3 Contrast (Minimum): 4.5:1 for text. Every pair here is held to 4.5:1, including
 *    the 28px headings, so no pair leans on the large-text exemption.
 *  - 1.4.11 Non-text Contrast: 3:1 for affordances a person must see to operate a control:
 *    the focus ring, the composer's focus border, the active rail icon.
 *
 * Pairs come from where the tokens are actually painted (`text-[var(--…)]` on
 * `bg-[var(--…)]` in `components/` and `src/`), plus the two places 0.15.0 fixed bugs in:
 * the rail footer (dark-on-dark icons) and the composer (invisible prompt box).
 *
 * Exempt, with the reason, rather than held to a lower threshold:
 *  - `--line` as a divider or border: decorative, carries no state (1.4.11 exempts it).
 *  - `text-[var(--line)]` in `finance-phase-strip.tsx`: an `aria-hidden` separator glyph.
 *  - The disabled composer send button (`--text-3` on `--line`): 1.4.3 exempts inactive
 *    controls. It is still reported by the last test so a change to it is visible.
 */

// Normalise line endings: the checkout may carry CRLF, and the rule lookups match on LF.
const globalsCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "app", "globals.css"),
  "utf8",
).replace(/\r\n/g, "\n");

// --- CSS parsing ------------------------------------------------------------

/**
 * The body of the first top-level rule whose whole selector list is exactly `selector`.
 * An occurrence that closes a longer list (`.formatted-md p,\n.formatted-md blockquote {`)
 * is skipped: the previous line ending in a comma means it is not the rule we asked for.
 */
function rule(selector: string): string {
  const needle = `\n${selector} {`;
  let start = globalsCss.indexOf(needle);
  while (start > -1 && globalsCss.slice(0, start).trimEnd().endsWith(",")) {
    start = globalsCss.indexOf(needle, start + 1);
  }
  expect(start, `${selector} rule missing from globals.css`).toBeGreaterThan(-1);
  const end = globalsCss.indexOf("\n}", start);
  expect(end, `${selector} rule is unterminated`).toBeGreaterThan(start);
  return globalsCss.slice(start, end);
}

function declarations(body: string, pattern = /(--[\w-]+)\s*:\s*([^;]+);/g): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(pattern)) out.set(match[1], match[2].trim());
  return out;
}

/** A plain property (`color`, `background`) declared in a rule. */
function property(selector: string, name: string): string {
  const value = declarations(rule(selector), /(?:^|\n)\s*([\w-]+)\s*:\s*([^;]+);/g).get(name);
  expect(value, `${selector} has no ${name}`).toBeDefined();
  return value as string;
}

// --- Colour maths -----------------------------------------------------------

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
  if (!match) return null;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function splitMix(value: string): { first: string; percent: number; second: string } | null {
  const match = /^color-mix\(\s*in\s+srgb\s*,\s*(.+)\)$/i.exec(value.trim());
  if (!match) return null;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of match[1]) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  if (parts.length !== 2) return null;
  const withPercent = /^(.*)\s+([\d.]+)%$/.exec(parts[0].trim());
  if (!withPercent) return null;
  return { first: withPercent[1].trim(), percent: Number(withPercent[2]), second: parts[1].trim() };
}

const lerp = (a: Rgb, b: Rgb, weightOfA: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(a[i] * weightOfA + b[i] * (1 - weightOfA))) as unknown as Rgb;

/**
 * Resolve a colour to opaque sRGB. `backdrop` is what a translucent colour is composited over:
 * `color-mix(in srgb, X 62%, transparent)` is X at 62% alpha, which over B paints `lerp(X, B)`.
 */
function resolve(value: string, tokens: ReadonlyMap<string, string>, backdrop?: Rgb, seen = new Set<string>()): Rgb {
  const trimmed = value.trim();

  const hex = parseHex(trimmed);
  if (hex) return hex;

  const varMatch = /^var\(\s*(--[\w-]+)\s*\)$/.exec(trimmed);
  if (varMatch) {
    const name = varMatch[1];
    if (seen.has(name)) throw new Error(`circular token reference at ${name}`);
    const next = tokens.get(name);
    if (next === undefined) throw new Error(`token ${name} is not defined in this theme`);
    return resolve(next, tokens, backdrop, new Set([...seen, name]));
  }

  const mix = splitMix(trimmed);
  if (mix) {
    const w = mix.percent / 100;
    if (mix.second === "transparent") {
      if (!backdrop) throw new Error(`translucent colour needs a backdrop: ${trimmed}`);
      return lerp(resolve(mix.first, tokens, backdrop, seen), backdrop, w);
    }
    if (mix.first === "transparent") throw new Error(`unsupported mix order: ${trimmed}`);
    return lerp(resolve(mix.first, tokens, backdrop, seen), resolve(mix.second, tokens, backdrop, seen), w);
  }

  throw new Error(`unsupported colour syntax: ${trimmed}`);
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (rgb: Rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

// --- Themes -----------------------------------------------------------------

const rootTokens = declarations(rule(":root"));
const lightTokens = new Map([...rootTokens, ...declarations(rule(".light"))]);
// `.dark` overrides a subset; everything else cascades from `:root`.
const darkTokens = new Map([...rootTokens, ...declarations(rule(".dark"))]);

const themes = [
  { name: "light", tokens: lightTokens },
  { name: "dark", tokens: darkTokens },
] as const;

/** A pair is a foreground and the surface it is painted on; either may be any CSS colour. */
type Pair = { readonly fg: string; readonly bg: string; readonly where: string };

const v = (token: string) => `var(${token})`;

function check(pairs: readonly Pair[], tokens: ReadonlyMap<string, string>, min: number): string[] {
  const failures: string[] = [];
  for (const { fg, bg, where } of pairs) {
    const back = resolve(bg, tokens);
    const front = resolve(fg, tokens, back);
    const value = contrast(front, back);
    if (value < min) {
      failures.push(`${where}: ${fg} ${toHex(front)} on ${bg} ${toHex(back)} = ${value.toFixed(2)}:1`);
    }
  }
  return failures;
}

// --- Pairs ------------------------------------------------------------------

/** The desk's four grounds: page, panel/composer, inset fill, accent wash (chips, drag-over). */
const DESK_SURFACES = ["--bg", "--surface", "--surface-2", "--accent-soft"] as const;

const BODY_TEXT: readonly Pair[] = ["--text", "--text-2", "--text-3"].flatMap((text) =>
  DESK_SURFACES.map((surface) => ({ fg: v(text), bg: v(surface), where: "body text" })),
);

const ACCENT_TEXT: readonly Pair[] = [
  // Links (`.formatted-md a`), `.tag-accent`, `text-[var(--accent)]`, the pressed `.seg-opt`.
  ...DESK_SURFACES.map((surface) => ({ fg: v("--accent"), bg: v(surface), where: "accent as text" })),
  // `.kicker` / `.panel-label`.
  ...["--bg", "--surface", "--surface-2"].map((surface) => ({ fg: v("--mark"), bg: v(surface), where: "kicker" })),
];

/** The page's status copy: errors (`composer-error`, upload lines) and the ok line. */
const STATUS_TEXT: readonly Pair[] = [
  ...["--bg", "--surface", "--surface-2"].map((surface) => ({ fg: v("--danger"), bg: v(surface), where: "danger" })),
  // `settings-reset-card` / workspace delete: `bg-[var(--danger)]/5` over the panel.
  { fg: v("--danger"), bg: "color-mix(in srgb, var(--danger) 5%, var(--surface))", where: "danger on its wash" },
  ...["--bg", "--surface"].map((surface) => ({ fg: v("--ok"), bg: v(surface), where: "ok" })),
];

/** Translucent text in globals.css, composited over the panels it sits on. */
const TRANSLUCENT_TEXT: readonly Pair[] = [
  [".tag-neutral", "color"],
  [".field label,\n.field .label", "color"],
  [".formatted-md blockquote", "color"],
].flatMap(([selector, name]) =>
  ["--bg", "--surface"].map((surface) => ({ fg: property(selector, name), bg: v(surface), where: selector })),
);

/** Text on a filled button. The accent fill's on-colour is `--surface` everywhere in TSX. */
const ON_FILL_TEXT: readonly Pair[] = [
  { fg: property(".btn-primary", "color"), bg: property(".btn-primary", "background"), where: ".btn-primary" },
  {
    fg: property(".btn-primary", "color"),
    bg: property(".btn-primary:hover", "background"),
    where: ".btn-primary:hover",
  },
  { fg: v("--surface"), bg: v("--accent"), where: "studio run buttons" },
  // `chat-composer.tsx` send button.
  { fg: v("--bg"), bg: v("--accent"), where: "composer send" },
  // `settings-reset-card.tsx`, `workspaces-page.tsx` destructive confirm.
  { fg: v("--surface"), bg: v("--danger"), where: "danger confirm" },
];

/** The composer: prompt text and placeholder on the panel, and on the drag-over wash. */
const COMPOSER_TEXT: readonly Pair[] = ["--text", "--text-3"].flatMap((text) =>
  ["--surface", "--accent-soft"].map((surface) => ({ fg: v(text), bg: v(surface), where: "composer" })),
);

/** The rail follows the theme (owner ruling 2026-09-23); its text sits on the rail and its states. */
const RAIL_TEXT: readonly Pair[] = [
  ...["--rail-text", "--rail-text-2", "--rail-text-3"].flatMap((text) =>
    ["--rail", "--rail-hover"].map((surface) => ({ fg: v(text), bg: v(surface), where: "rail" })),
  ),
  ...["--rail-active", "--rail-hover"].map((surface) => ({
    fg: v("--rail-active-text"),
    bg: v(surface),
    where: "rail active",
  })),
  // The footer rules that 0.15.0 added so the footer icons stop rendering dark-on-dark.
  {
    fg: property('[data-testid="rail-footer"] .btn-ghost', "color"),
    bg: v("--rail"),
    where: "rail footer",
  },
  {
    fg: property('[data-testid="rail-footer"] .btn-ghost:hover', "color"),
    bg: property('[data-testid="rail-footer"] .btn-ghost:hover', "background"),
    where: "rail footer hover",
  },
];

/** WCAG 1.4.11: affordances a person needs to see to operate the control. */
const UI_AFFORDANCES: readonly Pair[] = [
  // `:focus-visible` outline and `.composer-shell:focus-within` border.
  ...["--bg", "--surface", "--surface-2"].map((surface) => ({ fg: v("--accent"), bg: v(surface), where: "focus" })),
  // Active rail icon and the brand mark.
  ...["--rail", "--rail-active", "--rail-hover"].map((surface) => ({
    fg: v("--rail-accent"),
    bg: v(surface),
    where: "rail icon",
  })),
];

/**
 * Mode icons (`--mode-*`), WCAG 1.4.11. A rail row's glyph sits on a tile that is its own colour at 14%
 * over the rail (`RailItem`), a card's on the same 14% over the surface (`.icon-orb`), and the current
 * row / `.icon-orb-solid` flips to a solid fill that carries `--on-mode`. Held on both desks: the dark
 * audit found Legal, Research, Education and Channels at 1.9-2.7:1 (dark-on-dark), and the light one
 * (2026-10-01) Documents, Presentation, Edit, Finance, Market and Data at 2.3-3.0:1 on the light rail.
 *
 * Grounds: the rail and the card are the two a tile is drawn on; the hover row (`--rail-hover`) and an
 * inset panel (`--surface-2`) are where the same tile lands when a row is hovered or a card sits in a
 * well, so they are held to the 3:1 floor too.
 */
const MODE_TOKENS = [...rootTokens.keys()].filter((name) => /^--mode-[a-z]+$/.test(name));
const tileOn = (mode: string, ground: string, where: string): Pair => ({
  fg: v(mode),
  bg: `color-mix(in srgb, ${v(mode)} 14%, ${v(ground)})`,
  where: `${mode} on its ${where} tile`,
});
/** The two tiles the design tuned the light set to: a rail row's and a card's. */
const MODE_ICONS: readonly Pair[] = MODE_TOKENS.flatMap((mode) => [
  tileOn(mode, "--rail", "rail"),
  tileOn(mode, "--surface", "card"),
]);
/** Where the same tile lands on a hovered rail row and in an inset panel. */
const MODE_ICONS_RAISED: readonly Pair[] = MODE_TOKENS.flatMap((mode) => [
  tileOn(mode, "--rail-hover", "hovered rail"),
  tileOn(mode, "--surface-2", "inset"),
]);
/** The light set is tuned above the WCAG floor so a browser's rounding of `color-mix` cannot take it under. */
const LIGHT_MODE_ICON_FLOOR = 3.5;
const MODE_ON_FILL: readonly Pair[] = MODE_TOKENS.map((mode) => ({
  fg: v("--on-mode"),
  bg: v(mode),
  where: `${mode} solid tile`,
}));

/**
 * The Nultron wordmark (`.wordmark-nultron`, the name beside the rail mark, 15px bold): a gradient from
 * `--nultron-blue-text` to `--nultron-cyan-text`. It is small text, so both stops are held to 4.5:1 on
 * the rail where it is drawn and on the page and panel grounds where a name may land next.
 */
const WORDMARK_STOPS = ["--nultron-blue-text", "--nultron-cyan-text"] as const;
const WORDMARK: readonly Pair[] = WORDMARK_STOPS.flatMap((stop) =>
  ["--rail", "--bg", "--surface"].map((ground) => ({ fg: v(stop), bg: v(ground), where: `wordmark ${stop}` })),
);

/** Hue in degrees (0-360) of an opaque colour; the IP colours are judged by hue, since lightness moves with the theme. */
function hueOf([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const sector = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return sector * 60;
}

// --- Assertions -------------------------------------------------------------

describe("palette contrast (WCAG 2.1)", () => {
  it.each(themes)("$name: body text clears 4.5:1 on every desk surface", ({ tokens }) => {
    const failures = check(BODY_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: accent and kicker text clear 4.5:1", ({ tokens }) => {
    const failures = check(ACCENT_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: status text clears 4.5:1 on the page, panel and its own wash", ({ tokens }) => {
    const failures = check(STATUS_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: translucent labels clear 4.5:1 once composited", ({ tokens }) => {
    const failures = check(TRANSLUCENT_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: text on filled buttons clears 4.5:1 at rest and on hover", ({ tokens }) => {
    const failures = check(ON_FILL_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: the composer's prompt and placeholder clear 4.5:1", ({ tokens }) => {
    const failures = check(COMPOSER_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: rail text, active state and footer clear 4.5:1", ({ tokens }) => {
    const failures = check(RAIL_TEXT, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: focus ring, composer focus border and rail icon clear 3:1", ({ tokens }) => {
    const failures = check(UI_AFFORDANCES, tokens, 3);
    expect(failures, `below 3:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)("$name: every mode icon clears 3:1 on its rail, card, hovered-row and inset tile", ({ tokens }) => {
    expect(MODE_TOKENS.length).toBeGreaterThanOrEqual(19);
    const icons = check([...MODE_ICONS, ...MODE_ICONS_RAISED], tokens, 3);
    expect(icons, `below 3:1:\n  ${icons.join("\n  ")}`).toEqual([]);
  });

  it("light: every mode icon clears 3.5:1 on its rail and card tile", () => {
    const icons = check(MODE_ICONS, lightTokens, LIGHT_MODE_ICON_FLOOR);
    expect(icons, `below ${LIGHT_MODE_ICON_FLOOR}:1:\n  ${icons.join("\n  ")}`).toEqual([]);
  });

  it.each(themes)(
    "$name: the ink on a solid mode tile (the current rail row, `.icon-orb-solid`) clears 4.5:1",
    ({ tokens }) => {
      const ink = check(MODE_ON_FILL, tokens, 4.5);
      expect(ink, `below 4.5:1:\n  ${ink.join("\n  ")}`).toEqual([]);
    },
  );

  it.each(themes)("$name: both stops of the Nultron wordmark clear 4.5:1 on the rail and the page", ({ tokens }) => {
    const failures = check(WORDMARK, tokens, 4.5);
    expect(failures, `below 4.5:1:\n  ${failures.join("\n  ")}`).toEqual([]);
  });
});

describe("Nultron IP colours", () => {
  // Sampled 2026-10-01 from the art: a k-means pass over the opaque pixels of
  // `docs/internal/brand/nultron/reference/app-logo.webp` and of `components/nultron/images/full/*.webp`.
  // Changing one is a change to the brand, so it is made here, in the same commit as the token.
  const SAMPLED = {
    "--nultron-blue": "#1277c8",
    "--nultron-cyan": "#19bddc",
    "--nultron-cream": "#e4d9cd",
    "--nultron-ink": "#131617",
  } as const;

  it("the four fills are the sampled art colours, in both themes (they do not follow the theme)", () => {
    for (const { name, tokens } of themes) {
      for (const [token, hex] of Object.entries(SAMPLED)) {
        expect(tokens.get(token), `${token} in ${name}`).toBe(hex);
      }
    }
  });

  it.each(themes)("$name: each wordmark stop keeps the hue of its IP colour, within 10 degrees", ({ tokens }) => {
    const pairs = [
      ["--nultron-blue-text", "--nultron-blue"],
      ["--nultron-cyan-text", "--nultron-cyan"],
    ] as const;
    for (const [text, fill] of pairs) {
      const drift = Math.abs(hueOf(resolve(v(text), tokens)) - hueOf(resolve(v(fill), tokens)));
      expect(Math.min(drift, 360 - drift), `${text} against ${fill}`).toBeLessThanOrEqual(10);
    }
  });

  it("the wordmark paints only those two stop tokens, and flavors never get the class", () => {
    const body = rule(".wordmark-nultron");
    for (const stop of WORDMARK_STOPS) expect(body).toContain(`var(${stop})`);
    expect(body, "a raw hex in the wordmark would sidestep the contrast check").not.toMatch(/#[0-9a-f]{3,6}\b/i);
    const rail = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "components", "app-rail.tsx"),
      "utf8",
    );
    expect(rail).toMatch(/usesNultronWordmark\(brand\)/);
    expect(rail).toMatch(/nultronWordmark \? "wordmark-nultron"/);
  });
});

describe("palette parser", () => {
  it("resolves color-mix, including a mix with transparent over a backdrop", () => {
    // A silent fallback here would make every assertion above vacuous.
    expect(toHex(resolve("color-mix(in srgb, #ffffff 50%, #000000)", lightTokens))).toBe("#808080");
    expect(toHex(resolve("color-mix(in srgb, #000000 25%, transparent)", lightTokens, [255, 255, 255]))).toBe(
      "#bfbfbf",
    );
    expect(() => resolve("color-mix(in srgb, #000000 25%, transparent)", lightTokens)).toThrow(/backdrop/);
    expect(toHex(resolve("var(--bg)", darkTokens))).not.toBe(toHex(resolve("var(--bg)", lightTokens)));
  });

  it("keeps `.light` palette in step with `:root`, since `applyTheme` toggles one and boot paints the other", () => {
    // Solid palette colours only. The scrollbar thumbs are translucent mixes that `.light`
    // deliberately tunes a few percent softer than `:root`; they carry no text.
    const light = declarations(rule(".light"));
    const drift = [...light].filter(
      ([name, value]) => parseHex(value) !== null && rootTokens.has(name) && rootTokens.get(name) !== value,
    );
    expect(drift, "`.light` and `:root` disagree").toEqual([]);
  });

  it("keeps `.light` to the declarations that differ from `:root`, so a palette change is made once", () => {
    const repeated = [...declarations(rule(".light"))].filter(([name, value]) => rootTokens.get(name) === value);
    expect(repeated, "`.light` repeats `:root`: delete these from `.light`").toEqual([]);
  });

  it("leaves no --color-* alias layer in globals.css", () => {
    expect(globalsCss).not.toMatch(/--color-[\w-]+\s*:/);
    expect(globalsCss).not.toMatch(/var\(--color-/);
  });

  it("every pair resolves to a real colour in both themes", () => {
    const all = [
      ...BODY_TEXT,
      ...ACCENT_TEXT,
      ...STATUS_TEXT,
      ...TRANSLUCENT_TEXT,
      ...ON_FILL_TEXT,
      ...COMPOSER_TEXT,
      ...RAIL_TEXT,
      ...UI_AFFORDANCES,
      ...MODE_ICONS,
      ...MODE_ICONS_RAISED,
      ...MODE_ON_FILL,
      ...WORDMARK,
    ];
    for (const { name, tokens } of themes) {
      for (const { fg, bg } of all) {
        expect(() => resolve(fg, tokens, resolve(bg, tokens)), `${fg} on ${bg} in ${name}`).not.toThrow();
      }
    }
  });

  it("records the exempt disabled send button so a change to it is visible", () => {
    // Inactive control: exempt from 1.4.3. Reported, not asserted against 4.5:1.
    for (const { tokens } of themes) {
      const value = contrast(resolve("var(--text-3)", tokens), resolve("var(--line)", tokens));
      expect(value).toBeGreaterThan(1);
    }
  });
});
