import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobFallbackChain } from "@agentforge/core";
import { MODEL_TIERS } from "@agentforge/core/tiers";
import { listSelectableModels, resetCatalogMemo } from "./selectable-models";
import { resolveTierForCatalog } from "./tier-resolve";

/** A desk with no cached gateway list runs on the static fill-in catalogue alone. */
describe("tiers on the offline catalogue", () => {
  let previousCache: string | undefined;
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "af-models-offline-"));
    previousCache = process.env.AGENTFORGE_MODELS_CACHE_PATH;
    process.env.AGENTFORGE_MODELS_CACHE_PATH = join(cacheDir, "missing.json");
    resetCatalogMemo();
  });

  afterEach(() => {
    if (previousCache === undefined) {
      delete process.env.AGENTFORGE_MODELS_CACHE_PATH;
    } else {
      process.env.AGENTFORGE_MODELS_CACHE_PATH = previousCache;
    }
    resetCatalogMemo();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it.each(MODEL_TIERS)("resolves %s from the fill-in catalogue", (tier) => {
    const resolved = resolveTierForCatalog(tier, listSelectableModels());
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
  });

  it("keeps a non-empty job fallback chain", () => {
    const ids = listSelectableModels().map((model) => model.id);
    expect(jobFallbackChain(undefined, ids).length).toBeGreaterThan(0);
  });
});
