import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from a module URL until it finds `apps/portal` (`package.json` + `locales`).
 * Works both when run directly from `src/**` via `tsx`/Vitest and when bundled into `dist/*.mjs`
 * or `dist/scripts/*.mjs`.
 */
export function findPortalRoot(fromUrl: string): string {
  let current = dirname(fileURLToPath(fromUrl));
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "locales"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      throw new Error(`Could not locate apps/portal root from ${fromUrl}`);
    }
    current = parent;
  }
}

export const PORTAL_ROOT = findPortalRoot(import.meta.url);
export const REPO_ROOT = resolve(PORTAL_ROOT, "..", "..");
