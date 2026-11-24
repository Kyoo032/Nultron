import { useSyncExternalStore } from "react";

/**
 * Monotonic version bumped whenever a successful write can change the active gateway key or the
 * probed model catalog (`POST /api/v1/settings`, `/api/v1/settings/reset`,
 * `/api/v1/settings/gateway/check`, `/api/v1/models`).
 *
 * Work-mode panes stay mounted in `WorkModeKeepAlive`, so a studio that fetched its model list at
 * mount would otherwise keep the old key's models after switching keys in Settings without a full
 * page reload. Subscribing here lets kept-alive studios re-fetch their model lists in place while
 * keeping the user's open work intact.
 */
const CATALOG_MUTATION_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/settings",
  "/api/v1/settings/reset",
  "/api/v1/settings/gateway/check",
  "/api/v1/models",
]);

let version = 0;
const listeners = new Set<() => void>();

export function isCatalogMutationPath(input: string): boolean {
  try {
    const pathname = new URL(input, "http://agentforge.local").pathname.replace(/\/+$/, "");
    return CATALOG_MUTATION_PATHS.has(pathname);
  } catch {
    return false;
  }
}

export function getCatalogVersion(): number {
  return version;
}

export function subscribeCatalogVersion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCatalogChanged(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribeCatalogVersion, getCatalogVersion, getCatalogVersion);
}

/** Test seam. */
export function resetCatalogVersionForTests(): void {
  version = 0;
  listeners.clear();
}
