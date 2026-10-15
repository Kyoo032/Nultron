import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { BrandContext, DEFAULT_PRODUCT_BRAND, type ProductBrand } from "./product-brand";
import { SESSIONS_OFF, SessionFixture } from "./session";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
  checkGateway: async () => null,
  relaunchDesktopApp: async () => ({}),
  resetApp: async () => ({}),
  cancelReset: async () => ({}),
}));

beforeAll(async () => {
  await import("@/components/settings-page");
}, 120_000);

afterEach(() => resetLocaleForTests());

async function settingsUnder(brand: ProductBrand): Promise<string> {
  applyLocale("en");
  const { SettingsPage } = await import("@/components/settings-page");
  return renderToStaticMarkup(
    <MemoryRouter>
      <BrandContext.Provider value={brand}>
        <SessionFixture value={SESSIONS_OFF}>
          <HostCapabilitiesFixture capabilities={hostCapabilities({})}>
            <SettingsPage />
          </HostCapabilitiesFixture>
        </SessionFixture>
      </BrandContext.Provider>
    </MemoryRouter>,
  );
}

describe("Settings' Replay the guide card and the shell look", () => {
  it("is drawn on the default shell", async () => {
    const html = await settingsUnder(DEFAULT_PRODUCT_BRAND);
    expect(html).toContain('data-testid="settings-guide"');
    expect(html).toContain('data-testid="settings-guide-replay"');
  });

  it("is not drawn under the enterprise look, which has no tour", async () => {
    const html = await settingsUnder({ ...DEFAULT_PRODUCT_BRAND, shell: "enterprise" });
    expect(html).not.toContain('data-testid="settings-guide"');
    expect(html).not.toContain('data-testid="settings-guide-replay"');
    expect(html).toContain('data-testid="settings-form"');
  });
});
