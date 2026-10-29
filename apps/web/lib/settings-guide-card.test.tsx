import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests } from "./i18n";
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

async function settingsHtml(): Promise<string> {
  applyLocale("en");
  const { SettingsPage } = await import("@/components/settings-page");
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionFixture value={SESSIONS_OFF}>
        <HostCapabilitiesFixture capabilities={hostCapabilities({})}>
          <SettingsPage />
        </HostCapabilitiesFixture>
      </SessionFixture>
    </MemoryRouter>,
  );
}

describe("Settings' Replay the guide card", () => {
  it("is drawn on the chat-first shell", async () => {
    const html = await settingsHtml();
    expect(html).toContain('data-testid="settings-guide"');
    expect(html).toContain('data-testid="settings-guide-replay"');
  });
});
