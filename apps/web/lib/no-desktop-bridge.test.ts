import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["src", "components", "lib", "server"];

function productionSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__fixtures__" ||
        entry.name === "images" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const sub of SOURCE_DIRS) {
    walk(join(WEB_ROOT, sub));
  }
  return files;
}

describe("hosted web renderer has no Electron desktop bridge imports", () => {
  it("has no production file importing desktop-bridge, desktop-save, or isElectron", () => {
    const offenders: string[] = [];
    for (const file of productionSourceFiles()) {
      const text = readFileSync(file, "utf8");
      if (/\b(?:desktop-bridge|desktop-save|isElectron)\b|window\.agentforge\b/.test(text)) {
        offenders.push(relative(WEB_ROOT, file).replaceAll("\\", "/"));
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);
});
