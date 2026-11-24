import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditGenerateTab } from "@/components/edit-generate-tab";
import { apiFetch } from "./api-client";
import {
  getCatalogVersion,
  isCatalogMutationPath,
  resetCatalogVersionForTests,
  subscribeCatalogVersion,
} from "./catalog-version";
import { applyLocale, resetLocaleForTests } from "./i18n";

/**
 * Key 114 regression tests: switching gateway keys in Settings (or clicking Check again / Reset key)
 * without a full page reload bumps `catalogVersion` so kept-alive Videos and Edit > Generate panes
 * immediately re-fetch `/api/v1/videos` and never retain stale options (like Grok under Key A).
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relative: string) => readFileSync(resolve(root, relative), "utf8");

function stubOkFetch(status = 200): void {
  vi.stubGlobal("fetch", async () => {
    return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
  });
}

beforeEach(() => {
  resetCatalogVersionForTests();
  applyLocale("en");
  (globalThis as { document?: { cookie: string } }).document = { cookie: "agentforge_csrf=tok-key-switch" };
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCatalogVersionForTests();
  resetLocaleForTests();
  (globalThis as { document?: unknown }).document = undefined;
});

describe("Key 114: catalogVersion notifies kept-alive studios after key / catalog writes", () => {
  it("recognizes catalog-mutating endpoints", () => {
    expect(isCatalogMutationPath("/api/v1/settings")).toBe(true);
    expect(isCatalogMutationPath("/api/v1/settings/reset")).toBe(true);
    expect(isCatalogMutationPath("/api/v1/settings/gateway/check")).toBe(true);
    expect(isCatalogMutationPath("/api/v1/models")).toBe(true);
    expect(isCatalogMutationPath("/api/v1/videos")).toBe(false);
    expect(isCatalogMutationPath("/api/v1/threads")).toBe(false);
  });

  it("bumps catalogVersion on successful settings/models writes and ignores reads and errors", async () => {
    const notifications: number[] = [];
    const unsub = subscribeCatalogVersion(() => notifications.push(getCatalogVersion()));

    stubOkFetch(200);
    await apiFetch("/api/v1/videos");
    expect(getCatalogVersion()).toBe(0);

    // Switching Key A -> Key B via Settings save notifies listeners.
    await apiFetch("/api/v1/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openaiApiKey: "sk-key-b" }),
    });
    expect(getCatalogVersion()).toBe(1);

    // Explicit model refresh ("Check again") notifies listeners.
    await apiFetch("/api/v1/models", { method: "POST" });
    expect(getCatalogVersion()).toBe(2);

    // Switching back Key B -> Key A notifies listeners again.
    await apiFetch("/api/v1/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openaiApiKey: "sk-key-a" }),
    });
    expect(getCatalogVersion()).toBe(3);

    // Unrelated writes do not bump catalogVersion.
    await apiFetch("/api/v1/threads", { method: "POST", body: "{}" });
    expect(getCatalogVersion()).toBe(3);

    // Failed settings save (403) does not bump catalogVersion.
    stubOkFetch(403);
    await apiFetch("/api/v1/settings", { method: "POST", body: "{}" });
    expect(getCatalogVersion()).toBe(3);

    expect(notifications).toEqual([1, 2, 3]);
    unsub();
  });

  it("VideosStudio, EditStudio, EditGenerateTab and useJobModel are wired to refresh on key changes", () => {
    const videosStudio = readSource("components/videos-studio.tsx");
    expect(videosStudio).toContain("useCatalogVersion");
    expect(videosStudio).toContain("[load, catalogVersion]");

    const editStudio = readSource("components/edit-studio.tsx");
    expect(editStudio).toContain("useCatalogVersion");
    expect(editStudio).toContain("[catalogVersion]");
    expect(editStudio).toContain('apiFetch("/api/v1/videos")');

    const editGenerate = readSource("components/edit-generate-tab.tsx");
    expect(editGenerate).toContain("liveIds.includes(model)");

    const jobModel = readSource("lib/use-job-model.ts");
    expect(jobModel).toContain("useCatalogVersion");
    expect(jobModel).toContain("[mode, catalogVersion]");
  });

  it("EditGenerateTab renders Key A (no Grok) and Key B (with Grok) options faithfully", () => {
    const keyAModels = [
      { id: "doubao-seedance-2-0-260128", label: "Seedance 2.0", inputModalities: ["text", "image"] },
      { id: "veo_3_1-fast", label: "Veo 3.1 Fast", inputModalities: ["text", "image"] },
    ];
    const keyBModels = [
      { id: "grok-imagine-video", label: "Grok Imagine Video", inputModalities: ["text", "image"] },
      ...keyAModels,
    ];

    const htmlA = renderToStaticMarkup(
      <MemoryRouter>
        <EditGenerateTab
          project={{ id: "proj-1", fps: 24 }}
          models={keyAModels}
          needsKey={false}
          gatewayName="Gateway"
        />
      </MemoryRouter>,
    );
    expect(htmlA).toContain("doubao-seedance-2-0-260128");
    expect(htmlA).toContain("veo_3_1-fast");
    expect(htmlA).not.toContain("grok-imagine-video");

    const htmlB = renderToStaticMarkup(
      <MemoryRouter>
        <EditGenerateTab
          project={{ id: "proj-1", fps: 24 }}
          models={keyBModels}
          needsKey={false}
          gatewayName="Gateway"
        />
      </MemoryRouter>,
    );
    expect(htmlB).toContain("grok-imagine-video");
    expect(htmlB).toContain("doubao-seedance-2-0-260128");
    expect(htmlB).toContain("veo_3_1-fast");
  });
});
