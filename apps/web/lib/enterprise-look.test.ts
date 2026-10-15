import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const libDir = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(libDir, "..");
const repoRoot = resolve(webDir, "..", "..");
const cssRepoPath = "apps/web/app/globals.css";
const SCOPE_ATTR = "data-product-shell";
const LIGHT = 'html[data-product-shell="enterprise"]';
const DARK = 'html.dark[data-product-shell="enterprise"]';
const HIDDEN_CLASSES = [
  ".desk-backdrop",
  ".float-shapes",
  ".chat-mascot.nx-root",
  ".buddy-stage",
  ".desk-buddy",
  ".desk-buddy-dock",
  ".desk-buddy-chip",
  ".agent-rail-buddy-dock",
  ".mode-header-art",
  ".chat-hero-orb",
];
const MODE_NEUTRAL = "var(--text-3)";
const CONTRAST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--text", "--bg"],
  ["--text", "--surface"],
  ["--text", "--surface-2"],
  ["--text-2", "--bg"],
  ["--text-2", "--surface"],
  ["--text-3", "--bg"],
  ["--text-3", "--surface"],
  ["--text-3", "--surface-2"],
  ["--accent", "--bg"],
  ["--accent", "--surface"],
  ["--accent", "--accent-soft"],
  ["--rail-text", "--rail"],
  ["--rail-text-2", "--rail"],
  ["--rail-text-3", "--rail"],
  ["--rail-text-3", "--rail-hover"],
  ["--rail-text", "--rail-active"],
  ["--rail-accent", "--rail"],
];

type Chunk = { prelude: string; text: string };

function normalise(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function preludeOf(text: string): string {
  const cleaned = withoutComments(text);
  const cut = cleaned.search(/[{;]/);
  return (cut === -1 ? cleaned : cleaned.slice(0, cut)).trim();
}

function topLevelChunks(source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const close = (end: number) => {
    const text = source.slice(start, end);
    chunks.push({ prelude: preludeOf(text), text });
    start = end;
  };
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        close(i + 1);
      }
    } else if (ch === ";" && depth === 0) {
      close(i + 1);
    }
    i += 1;
  }
  return chunks.filter((chunk) => chunk.text.trim() !== "");
}

function selectorsOf(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of prelude) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

function ruleFor(chunks: Chunk[], prelude: string): Chunk {
  const found = chunks.find((chunk) => chunk.prelude === prelude);
  if (!found) throw new Error(`no top-level rule with the selector ${prelude}`);
  return found;
}

function declarationsIn(chunk: Chunk): Map<string, string> {
  const body = withoutComments(chunk.text);
  const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
  const out = new Map<string, string>();
  for (const match of inner.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

function hexOf(declarations: Map<string, string>, token: string): string {
  const value = declarations.get(token);
  if (value === undefined) throw new Error(`${token} is not declared`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference) return hexOf(declarations, reference[1]);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${token} is ${value}, not a hex colour`);
  return value.toLowerCase();
}

function hueOf(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function outsideScope(source: string): string {
  return topLevelChunks(source)
    .filter((chunk) => !chunk.prelude.includes(SCOPE_ATTR))
    .map((chunk) => withoutComments(chunk.text).trim())
    .join("\n\n");
}

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });
}

const css = normalise(readFileSync(join(repoRoot, cssRepoPath), "utf8"));
const chunks = topLevelChunks(css);
const scoped = chunks.filter((chunk) => chunk.prelude.includes(SCOPE_ATTR));
const scopedText = scoped.map((chunk) => chunk.text).join("\n");
const light = declarationsIn(ruleFor(chunks, LIGHT));
const dark = declarationsIn(ruleFor(chunks, DARK));

describe("enterprise look: token block, scope and neutral modes", () => {
  it("the scope attribute is written on <html> by the brand provider", () => {
    const brand = normalise(readFileSync(join(webDir, "lib", "product-brand.tsx"), "utf8"));
    expect(brand).toContain('root.dataset.productShell = "enterprise";');
    expect(brand).toContain("const root = document.documentElement;");
  });

  it("every top-level rule that names the attribute is scoped to html, and none sits in an at-rule", () => {
    expect(scoped.length).toBeGreaterThan(0);
    for (const chunk of scoped) {
      const scopedSelectors = selectorsOf(chunk.prelude).every(
        (selector) => selector.startsWith(LIGHT) || selector.startsWith(DARK),
      );
      expect(scopedSelectors, chunk.prelude).toBe(true);
    }
    const atRuleNames = chunks.filter((chunk) => chunk.prelude.startsWith("@") && chunk.text.includes(SCOPE_ATTR));
    expect(atRuleNames).toEqual([]);
  });

  it("the default shell CSS is unchanged from HEAD outside the enterprise scope", () => {
    const headCss = normalise(
      execFileSync("git", ["show", `HEAD:${cssRepoPath}`], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    expect(outsideScope(css)).toBe(outsideScope(headCss));
  });

  it("the light block carries the spec's values, system sans and 6px radii", () => {
    expect(light.get("--bg")).toBe("#fafaf8");
    expect(light.get("--surface")).toBe("#ffffff");
    expect(light.get("--rail")).toBe("#f1f0ec");
    expect(light.get("--accent")).toBe("#0f5c7a");
    for (const radius of ["--r-nav", "--r-card", "--r-hero"]) {
      expect(light.get(radius), radius).toBe("6px");
    }
    expect(light.get("--font")).toMatch(/^ui-sans-serif, system-ui/);
    expect(light.get("--font")).not.toMatch(/DM Sans|Source Serif/);
  });

  it("the dark block keeps the mock's dark surfaces and rail, and redeclares every token the light block sets", () => {
    expect(dark.get("--bg")).toBe("#0e1513");
    expect(dark.get("--rail")).toBe("#0f1e1b");
    expect(dark.get("--rail-active-text")).toBe("#ffffff");
    for (const token of light.keys()) {
      expect(dark.has(token), token).toBe(true);
    }
  });

  it("the accent is one hue in both themes: the dark accent is the light accent lifted, not the mock's teal", () => {
    expect(light.get("--accent")).toBe("#0f5c7a");
    expect(dark.get("--accent")).toBe("#5eabc9");
    const hue = hueOf(hexOf(light, "--accent"));
    for (const token of ["--accent", "--mark", "--rail-accent", "--accent-soft"]) {
      expect(Math.abs(hueOf(hexOf(dark, token)) - hue), token).toBeLessThan(2);
    }
  });

  it("every mode colour and the page mode map to neutral in both themes", () => {
    const modeTokens = [...declarationsIn(ruleFor(chunks, ":root")).keys()].filter((token) =>
      token.startsWith("--mode-"),
    );
    expect(modeTokens).toHaveLength(19);
    for (const token of [...modeTokens, "--page-mode"]) {
      expect(light.get(token), `light ${token}`).toBe(MODE_NEUTRAL);
      expect(dark.get(token), `dark ${token}`).toBe(MODE_NEUTRAL);
    }
  });

  it("the sky, dot grid, ambient loops, mascot and desk buddy are off in the scope, on their existing classes", () => {
    const hide = ruleFor(chunks, `${LIGHT} :is(${HIDDEN_CLASSES.join(", ")})`);
    expect(hide.text).toContain("display: none;");
    const sky = chunks.find((chunk) => chunk.prelude.includes('.desk-canvas:has([data-testid="chat-home"]'));
    expect(sky?.text).toContain("background-image: none;");
    expect(sky?.prelude.startsWith(LIGHT)).toBe(true);
    expect(scopedText).not.toMatch(/infinite|animation:\s*nx-/);
  });

  it("every class the scope hides is rendered by a component, so the selectors are not dead", () => {
    const sources = [
      ...sourceFilesUnder(join(webDir, "components")),
      ...sourceFilesUnder(join(webDir, "src")),
    ].join("\n");
    for (const selector of [...HIDDEN_CLASSES, ".chat-hero-panel"]) {
      const name = selector.split(".")[1];
      expect(sources, selector).toContain(name);
    }
  });

  it("text and accent pairs clear 4.5:1 in both themes", () => {
    for (const [theme, declarations] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [foreground, background] of CONTRAST_PAIRS) {
        const ratio = contrast(hexOf(declarations, foreground), hexOf(declarations, background));
        expect(ratio, `${theme} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the scoped rules carry no comments", () => {
    expect(scopedText).not.toContain("/*");
  });
});
