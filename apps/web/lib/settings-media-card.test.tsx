import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlwaysAllowToggles, SettingsMediaCard } from "@/components/settings-media-card";
import { applyLocale, resetLocaleForTests, t } from "@/lib/i18n";
import { BrandContext, DEFAULT_PRODUCT_BRAND, type ProductBrand } from "@/lib/product-brand";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const ENTERPRISE_BRAND: ProductBrand = { ...DEFAULT_PRODUCT_BRAND, productName: "Acme Desk", shell: "enterprise" };

const NOOP = () => undefined;

function enterprise(node: ReactNode, brand: ProductBrand = ENTERPRISE_BRAND): string {
  return renderToStaticMarkup(<BrandContext.Provider value={brand}>{node}</BrandContext.Provider>);
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the Media group in Settings", () => {
  it("is not drawn in the default shell, so that shell's Settings does not change", () => {
    expect(renderToStaticMarkup(<SettingsMediaCard />)).toBe("");
    expect(enterprise(<SettingsMediaCard />, { ...DEFAULT_PRODUCT_BRAND, shell: "opc" })).toBe("");
  });

  it("is drawn in the enterprise shell, with both toggles", () => {
    const html = enterprise(<SettingsMediaCard />);
    expect(html).toContain('data-testid="settings-media"');
    expect(html).toContain("Media");
    expect(html).toContain("Always allow images");
    expect(html).toContain("Always allow videos");
    expect(html).toContain('data-testid="settings-media-image"');
    expect(html).toContain('data-testid="settings-media-video"');
  });

  it("holds the toggles until the saved choices are read", () => {
    const html = enterprise(<SettingsMediaCard />);
    expect(count(html, ' disabled=""')).toBe(2);
  });

  it("is in the Settings page, once, before the storage card", () => {
    const page = source("../components/settings-page.tsx");
    expect(page).toContain('import { SettingsMediaCard } from "./settings-media-card";');
    expect(count(page, "<SettingsMediaCard />")).toBe(1);
    expect(page.indexOf("<SettingsMediaCard />")).toBeLessThan(page.indexOf("<SettingsStorageCard />"));
  });
});

describe("the always-allow toggles", () => {
  it("shows each kind's saved choice", () => {
    const html = renderToStaticMarkup(
      <AlwaysAllowToggles allow={{ image: true, video: false }} busy={null} failure={null} onToggle={NOOP} />,
    );
    expect(html).toMatch(/data-testid="settings-media-image"[^>]*checked=""/);
    expect(html).not.toMatch(/data-testid="settings-media-video"[^>]*checked=""/);
    expect(count(html, ' disabled=""')).toBe(0);
  });

  it("holds both toggles while one is being saved", () => {
    const html = renderToStaticMarkup(
      <AlwaysAllowToggles allow={{ image: false, video: false }} busy="video" failure={null} onToggle={NOOP} />,
    );
    expect(count(html, ' disabled=""')).toBe(2);
  });

  it("says a choice that could not be saved, as an alert", () => {
    const html = renderToStaticMarkup(
      <AlwaysAllowToggles allow={{ image: false, video: false }} busy={null} failure="save" onToggle={NOOP} />,
    );
    expect(html).toContain('data-testid="settings-media-error"');
    expect(html).toContain(t("settings.media.failed"));
    expect(html).toContain('role="alert"');
  });

  it("says a setting that could not be loaded, as an alert, and not as a failed save", () => {
    const html = renderToStaticMarkup(<AlwaysAllowToggles allow={null} busy={null} failure="load" onToggle={NOOP} />);
    expect(html).toContain('data-testid="settings-media-error"');
    expect(html).toContain(t("settings.media.loadFailed"));
    expect(html).not.toContain(t("settings.media.failed"));
    expect(html).toContain('role="alert"');
  });

  it("never names the product's mascot or brand", () => {
    const html = enterprise(<SettingsMediaCard />).toLowerCase();
    expect(html).not.toContain("nultron");
  });

  it("keeps the Media group in both locales", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const key of [
        "settings.media.heading",
        "settings.media.help",
        "settings.media.image",
        "settings.media.video",
        "settings.media.failed",
        "settings.media.loadFailed",
      ]) {
        expect(t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});
