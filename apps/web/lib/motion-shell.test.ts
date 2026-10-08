import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyDeskShell, deskShell, SHELL_ATTR } from "./shell-motion";

/**
 * Two shells, two timings (owner, 2026-10-05: "smooth the Nultron animation").
 *
 * The packaged Personal app runs Chromium without the GPU, so its ambient loops (the shapes' bob and turn,
 * the dot grid's drift) and its busy indicators are stepped, a few frames a second. A browser (webdev, the
 * hosted Enterprise app) has the GPU and runs them smooth. `main.tsx` writes `data-shell` on <html> once,
 * and `html[data-shell="desktop"]` in `app/globals.css` hands the stepped values back as tokens.
 *
 * None of it shows in a screenshot. What has to hold:
 *  - a browser's defaults are smooth and a little quicker than the stepped cycles;
 *  - the desktop shell resolves to EXACTLY what the stepped desk shipped with (Personal is unchanged);
 *  - the frame strips (a clip, a four-frame loop) are pictures and step in both shells;
 *  - the attribute is written before the first render, from `isElectron()`, never from `window.agentforge`.
 */

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(webRoot, ...parts), "utf8").replace(/\r\n/g, "\n");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");

function blockAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `${marker} missing`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${marker} is unterminated`);
}

const globals = stripComments(read("app", "globals.css"));
const mascot = stripComments(read("components", "nultron", "nultron.css"));

const rootBlock = blockAfter(globals, ":root");
const desktopBlock = blockAfter(globals, 'html[data-shell="desktop"]');

type Scope = Record<string, string>;

/** The custom properties a block declares, whitespace collapsed. */
function properties(block: string): Scope {
  const out: Scope = {};
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

/** What the browser computes: `:root` alone. The desktop shell is `html[data-shell="desktop"]` laid over it. */
const browserScope = properties(rootBlock);
const desktopScope: Scope = { ...browserScope, ...properties(desktopBlock) };

function resolve(value: string, scope: Scope): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
    const next = scope[name];
    expect(next, `${name} is not defined`).toBeDefined();
    return resolve(next as string, scope);
  });
}

/** `4000ms`, `calc(400ms * 16)` or `calc(4000ms * 2)`, in ms. */
function milliseconds(value: string): number {
  const plain = /^(\d+)ms$/.exec(value);
  if (plain) return Number(plain[1]);
  const product = /^calc\(\s*(\d+)ms\s*\*\s*(\d+)\s*\)$/.exec(value);
  expect(product, `cannot read "${value}" as a duration`).not.toBeNull();
  return Number(product?.[1]) * Number(product?.[2]);
}

const timeIn = (scope: Scope, token: string) => milliseconds(resolve(`var(${token})`, scope));
const easeIn = (scope: Scope, token: string) => resolve(`var(${token})`, scope);
const isStepped = (easing: string) => /^steps\(/.test(easing);

/** What the stepped desk shipped with on 2026-10-01 (0.15.x): the desktop shell must resolve to these. */
const STEPPED_DESK = {
  "--ease-ambient": "steps(8)",
  "--ease-ambient-steady": "steps(8)",
  "--ease-busy-move": "steps(4)",
  "--ease-busy": "steps(4)",
  bobMs: 6400,
  turnMs: 12800,
  driftMs: 19200,
} as const;

describe("the browser shell (the default): smooth, a little quicker", () => {
  it("eases the bob and keeps the turn and the drift at a constant speed", () => {
    expect(easeIn(browserScope, "--ease-ambient")).toBe("ease-in-out");
    expect(easeIn(browserScope, "--ease-ambient-steady")).toBe("linear");
    expect(easeIn(browserScope, "--ease-busy-move")).toBe("ease-in-out");
  });

  it("has no step function in a token a browser reads, except the frame strips' own", () => {
    for (const token of ["--ease-ambient", "--ease-ambient-steady", "--ease-busy-move"]) {
      expect(isStepped(easeIn(browserScope, token)), `${token} must be smooth in a browser`).toBe(false);
    }
    expect(easeIn(browserScope, "--ease-busy")).toBe("steps(4)");
  });

  it("shortens the sluggish ambient cycles, moderately", () => {
    const bob = timeIn(browserScope, "--motion-ambient");
    const drift = timeIn(browserScope, "--motion-drift");
    // Quicker than the stepped cycles, and still gentle (not a fidget).
    expect(bob).toBeLessThan(STEPPED_DESK.bobMs);
    expect(bob).toBeGreaterThanOrEqual(3000);
    expect(bob * 2, "the turn is two bob cycles").toBeLessThan(STEPPED_DESK.turnMs);
    expect(drift).toBeLessThan(STEPPED_DESK.driftMs);
    expect(drift).toBeGreaterThanOrEqual(8000);
  });

  it("keeps the amplitudes the stepped desk had (subtle)", () => {
    const bob = blockAfter(globals, "@keyframes nx-bob {");
    expect(bob).toMatch(/50%\s*\{[^}]*translate:\s*0 -7px;[^}]*rotate:\s*8deg/);
    const drift = blockAfter(globals, "@keyframes nx-grid-drift {");
    expect(drift).toMatch(/100%\s*\{[^}]*translate:\s*24px 24px/);
  });
});

describe("the packaged desktop shell: exactly the stepped desk it shipped", () => {
  it("hands the stepped easings and the 400 ms-grid cycles back", () => {
    expect(easeIn(desktopScope, "--ease-ambient")).toBe(STEPPED_DESK["--ease-ambient"]);
    expect(easeIn(desktopScope, "--ease-ambient-steady")).toBe(STEPPED_DESK["--ease-ambient-steady"]);
    expect(easeIn(desktopScope, "--ease-busy-move")).toBe(STEPPED_DESK["--ease-busy-move"]);
    expect(easeIn(desktopScope, "--ease-busy")).toBe(STEPPED_DESK["--ease-busy"]);
    expect(timeIn(desktopScope, "--motion-ambient")).toBe(STEPPED_DESK.bobMs);
    expect(timeIn(desktopScope, "--motion-ambient") * 2, "the turn").toBe(STEPPED_DESK.turnMs);
    expect(timeIn(desktopScope, "--motion-drift")).toBe(STEPPED_DESK.driftMs);
  });

  it("declares custom properties only: the loops are written once and read the tokens", () => {
    const lines = desktopBlock
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line, "a rule in the shell block would fork the loops").toMatch(/^--[\w-]+\s*:[^;]+;$/);
    }
    // It outranks :root on specificity, not on order, so a later :root edit cannot undo it.
    expect(globals.indexOf('html[data-shell="desktop"]')).toBeGreaterThan(globals.indexOf(":root"));
  });

  it("changes only the tokens that were stepped (nothing else moves with the shell)", () => {
    expect(Object.keys(properties(desktopBlock)).sort()).toEqual([
      "--ease-ambient",
      "--ease-ambient-steady",
      "--ease-busy-move",
      "--motion-ambient",
      "--motion-drift",
    ]);
  });
});

/** Every `selector { body }` with no nested braces. */
function flatRules(source: string): { selectors: string[]; body: string }[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && !s.startsWith("@")),
    body: m[2],
  }));
}

/** The easing token a loop's `animation` shorthand or `animation-timing-function` reads. */
function loopEasingToken(body: string): string | null {
  return /animation(?:-timing-function)?\s*:[^;]*var\((--ease-[\w-]+)\)/.exec(body)?.[1] ?? null;
}

describe("every loop in both shells", () => {
  const loops = [...flatRules(globals), ...flatRules(mascot)].filter(({ body }) =>
    /animation[\w-]*\s*:[^;]*\binfinite\b/.test(body),
  );
  const named = loops.flatMap(({ selectors, body }) =>
    selectors.map((selector) => ({ selector, token: loopEasingToken(body) })),
  );

  it("finds the loops it audits (guards the checks below)", () => {
    const selectors = named.map(({ selector }) => selector);
    expect(selectors).toContain(".float-shape-body");
    expect(selectors).toContain(".desk-grid::before");
    expect(selectors).toContain(".pulse-dots > span");
    expect(selectors.some((selector) => selector.includes(".nx-loop"))).toBe(true);
    expect(selectors.some((selector) => selector.includes('[data-state="thinking"]'))).toBe(true);
  });

  it("steps every loop in the desktop shell, whatever token it reads", () => {
    for (const { selector, token } of named) {
      expect(token, `${selector} must read an --ease token`).not.toBeNull();
      expect(isStepped(easeIn(desktopScope, token as string)), `${selector} (${token}) in the desktop shell`).toBe(
        true,
      );
    }
  });

  it("smooths every transform loop in a browser, and never the frame strips", () => {
    for (const { selector, token } of named) {
      const smooth = !isStepped(easeIn(browserScope, token as string));
      if (selector.includes(".nx-loop")) {
        expect(token, `${selector} is a picture, one frame per step`).toBe("--ease-busy");
        expect(smooth, `${selector} must step in a browser too`).toBe(false);
      } else {
        expect(smooth, `${selector} (${token}) must be smooth in a browser`).toBe(true);
      }
    }
  });

  it("gives the spinner and the grid the steady curve, and leaves the clip stepping on its own token", () => {
    const spin = flatRules(globals).find(({ selectors }) =>
      selectors.includes(".float-shape-spin > .float-shape-body"),
    );
    expect(loopEasingToken(spin?.body ?? "")).toBe("--ease-ambient-steady");
    const grid = named.find(({ selector }) => selector === ".desk-grid::before");
    expect(grid?.token).toBe("--ease-ambient-steady");
    // A clip steps with the frame count of its own strip, in both shells.
    expect(mascot).toMatch(/--nx-clip-ease:\s*steps\(var\(--nx-clip-frames,\s*1\),\s*jump-none\)/);
  });

  it("declares the shell-aware tokens in exactly two places: the browser's in :root, the desktop's in its block", () => {
    const declared = (text: string) =>
      [...text.matchAll(/--(?:ease-ambient(?:-steady)?|ease-busy-move|motion-ambient|motion-drift)\s*:/g)].length;
    expect(declared(rootBlock)).toBe(5);
    expect(declared(desktopBlock)).toBe(5);
    expect(declared(globals), "a theme block or a rule that redefines a shell token would fork the shells").toBe(10);
  });
});

describe("the shell attribute", () => {
  it("says desktop only for the packaged shell", () => {
    expect(deskShell(true)).toBe("desktop");
    expect(deskShell(false)).toBe("browser");
  });

  it("writes data-shell on the root and reports what it wrote", () => {
    const written: Record<string, string> = {};
    const root = {
      setAttribute: (name: string, value: string) => {
        written[name] = value;
      },
    };
    expect(applyDeskShell(root, true)).toBe("desktop");
    expect(written).toEqual({ [SHELL_ATTR]: "desktop" });
    expect(applyDeskShell(root, false)).toBe("browser");
    expect(written).toEqual({ [SHELL_ATTR]: "browser" });
    expect(SHELL_ATTR).toBe("data-shell");
  });

  it("is written once at boot, from isElectron(), before the first render", () => {
    const main = read("src", "main.tsx");
    const call = main.indexOf("applyDeskShell(document.documentElement, isElectron())");
    expect(call, "main.tsx must mark the shell").toBeGreaterThan(-1);
    expect(call, "before createRoot, so no loop starts under the wrong timing").toBeLessThan(
      main.indexOf("createRoot("),
    );
  });

  it("never reads the desktop bridge itself: only lib/desktop-bridge.ts may", () => {
    const source = stripComments(read("lib", "shell-motion.ts")).replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/window\.agentforge/);
  });
});
