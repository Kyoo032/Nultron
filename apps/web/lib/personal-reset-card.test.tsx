/**
 * The Personal "Start over" card is exactly what it was (owner rule 2026-10-01: "you have to change the
 * ent version only").
 *
 * The company-erase decision (SR-65) rebuilt the hosted account erase and nothing else. This test holds
 * the other side of that line. `personal-reset-card.golden.json` is the markup the card rendered at
 * 0b61a29, **before** the erase change, for every state a Personal install can show it in — a desk, a
 * desk with a wipe queued, a desk with a wipe queued inside the packaged shell, and the moment before
 * ping has answered — in English and in Indonesian. The card as it is today must render those states
 * byte for byte: same buttons, same testids, same copy, same order.
 *
 * Captured by rendering the pre-change component and the changed one side by side and asserting they
 * were equal before the golden was written, so it is a record of the old card and not of the new one.
 * If this fails, somebody changed a Personal screen. If the change was meant, the owner decided it, and
 * the golden is regenerated in the same commit; if it was not, it is a regression.
 *
 * What a static render cannot show — the panels opening, the confirm box enabling on `RESET`, Cancel
 * closing — was driven in a browser against the real desk on :3000 and is recorded in
 * `.cursor/skills/verify-agentforge/features/settings.md`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { EVERYTHING_OFF, HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests } from "./i18n";

let electron = false;
vi.mock("@/lib/api-client", () => ({
  isElectron: () => electron,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
  resetApp: async () => ({}),
  cancelReset: async () => ({}),
  relaunchDesktopApp: async () => ({}),
}));

const GOLDEN = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "personal-reset-card.golden.json"),
    "utf8",
  ),
) as Record<string, string>;

const DESK = hostCapabilities({});
const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

type Variant = {
  readonly locale: "en" | "id";
  readonly name: "desk" | "desk-pending" | "desk-pending-electron" | "before-ping";
  readonly capabilities: typeof DESK;
  readonly pending: boolean;
  readonly electron: boolean;
};

const VARIANTS: Variant[] = (["en", "id"] as const).flatMap((locale) => [
  { locale, name: "desk", capabilities: DESK, pending: false, electron: false },
  { locale, name: "desk-pending", capabilities: DESK, pending: true, electron: false },
  { locale, name: "desk-pending-electron", capabilities: DESK, pending: true, electron: true },
  { locale, name: "before-ping", capabilities: EVERYTHING_OFF, pending: false, electron: false },
]);

async function render(capabilities: typeof DESK, pending: boolean): Promise<string> {
  const { SettingsResetCard } = await import("@/components/settings-reset-card");
  return renderToStaticMarkup(
    <MemoryRouter>
      <HostCapabilitiesFixture capabilities={capabilities}>
        <SettingsResetCard resetPending={pending} />
      </HostCapabilitiesFixture>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  electron = false;
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the Personal Start over card", () => {
  it("has a golden for every variant this file renders", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(VARIANTS.map((v) => `${v.locale}/${v.name}`).sort());
  });

  for (const variant of VARIANTS) {
    it(`renders byte for byte what it rendered before the company-erase change: ${variant.locale} ${variant.name}`, async () => {
      electron = variant.electron;
      applyLocale(variant.locale);
      expect(await render(variant.capabilities, variant.pending)).toBe(GOLDEN[`${variant.locale}/${variant.name}`]);
    });
  }

  it("still offers exactly the two Personal doors on a desk, and never the hosted one", async () => {
    applyLocale("en");
    const markup = await render(DESK, false);
    for (const testid of ["settings-reset", "settings-reset-danger", "settings-reset-key", "settings-reset-all"]) {
      expect(markup, testid).toContain(`data-testid="${testid}"`);
    }
    for (const hosted of ["settings-reset-tenant", "settings-reset-tenant-zone", "settings-reset-tenant-confirm"]) {
      expect(markup, hosted).not.toContain(hosted);
    }
    // The copy a Personal owner reads is the copy it always was.
    expect(markup).toContain("Sign out and delete");
    expect(markup).toContain("Sign out of the gateway");
    expect(markup).toContain("Reset to a fresh install");
  });

  it("would notice if it changed: the hosted card is NOT the Personal card", async () => {
    // A guard on the guard. If the golden could never fail, this file would prove nothing.
    applyLocale("en");
    expect(await render(HOSTED, false)).not.toBe(GOLDEN["en/desk"]);
  });
});
