import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyTheme, getStoredTheme, resolveTheme, THEME_STORAGE_KEY } from "./theme";
import { themeBootScript } from "./theme-boot-script";

type Classes = Set<string>;

function fakeDocument(): { classes: Classes; documentElement: { classList: { toggle(name: string, on: boolean): void } } } {
  const classes: Classes = new Set();
  return {
    classes,
    documentElement: {
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
}

function runBoot(stored: string | null, throws = false): Classes {
  const doc = fakeDocument();
  const storage = {
    getItem(key: string) {
      if (throws) throw new Error("denied");
      return key === THEME_STORAGE_KEY ? stored : null;
    },
  };
  new Function("document", "localStorage", themeBootScript(THEME_STORAGE_KEY))(doc, storage);
  return doc.classes;
}

describe("themeBootScript", () => {
  it("applies a stored dark choice before the app loads", () => {
    expect([...runBoot("dark")]).toEqual(["dark"]);
  });

  it("applies a stored light choice", () => {
    expect([...runBoot("light")]).toEqual(["light"]);
  });

  it("stays light-first when nothing, or something unknown, is stored", () => {
    expect([...runBoot(null)]).toEqual(["light"]);
    expect([...runBoot("system")]).toEqual(["light"]);
  });

  it("leaves the page alone when storage is unreadable", () => {
    expect([...runBoot(null, true)]).toEqual([]);
  });

  it("reads the same key theme.ts writes, and never the operating system setting", () => {
    expect(themeBootScript(THEME_STORAGE_KEY)).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(themeBootScript(THEME_STORAGE_KEY)).not.toContain("matchMedia");
    expect(themeBootScript(THEME_STORAGE_KEY)).not.toContain("prefers-color-scheme");
  });

  it("resolves the same way the app does after boot", () => {
    for (const stored of ["dark", "light", null, "system"]) {
      const expected = resolveTheme(stored === "dark" || stored === "light" ? stored : null);
      expect([...runBoot(stored)]).toEqual([expected]);
    }
  });
});

describe("renderer entry", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));

  it("holds no copy of the theme key", () => {
    const main = readFileSync(path.join(dir, "..", "src", "main.tsx"), "utf8");
    expect(main).not.toContain("agentforge-theme");
    expect(main).toContain("applyTheme");
  });

  it("exports the helpers main.tsx calls", () => {
    expect(typeof applyTheme).toBe("function");
    expect(typeof getStoredTheme).toBe("function");
  });
});
