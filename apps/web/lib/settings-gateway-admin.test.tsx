import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import {
  GatewayAdminPanel,
  SettingsGatewayAdminCard,
  type GatewayAdminPanelProps,
} from "@/components/settings-gateway-admin-card";
import type { GatewayAdminState } from "./gateway-admin-client";
import { EVERYTHING_OFF, HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { SessionFixture, SESSIONS_OFF, type SessionRole, type SessionSnapshot } from "./session";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const SENTINEL = "gw-mgmt-SENTINEL-7f3a9c";
const CONFIGURED: GatewayAdminState = {
  configured: true,
  accountIdSet: true,
  checkedAt: "2026-10-15T09:30:00.000Z",
  status: "ok",
};
const NOT_SET: GatewayAdminState = { configured: false, accountIdSet: false, checkedAt: null, status: "unchecked" };
const NOOP = () => undefined;

const DESK = hostCapabilities({});
const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

function signedIn(role?: SessionRole): SessionSnapshot {
  return {
    status: "signed-in",
    identity: { userId: "usr_1", orgId: "org_1", tenantId: "tnt_1", expiresAt: 0, ...(role ? { role } : {}) },
    reason: null,
  };
}

function panel(overrides: Partial<GatewayAdminPanelProps> = {}): string {
  return renderToStaticMarkup(
    <GatewayAdminPanel
      state={CONFIGURED}
      loadFailed={false}
      token="abc"
      accountIdText=""
      busy={false}
      confirming={false}
      message={null}
      error={null}
      onTokenChange={NOOP}
      onAccountIdChange={NOOP}
      onSave={NOOP}
      onAskRemove={NOOP}
      onCancelRemove={NOOP}
      onRemove={NOOP}
      {...overrides}
    />,
  );
}

function card(session: SessionSnapshot, capabilities: typeof DESK): string {
  return renderToStaticMarkup(
    <SessionFixture value={session}>
      <HostCapabilitiesFixture capabilities={capabilities}>
        <SettingsGatewayAdminCard />
      </HostCapabilitiesFixture>
    </SessionFixture>,
  );
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the gateway management token section", () => {
  it("draws the heading, the one help line, a password token field and an optional account id", () => {
    const html = panel();
    expect(html).toContain('data-testid="settings-gateway-admin"');
    expect(html).toContain("Gateway management token");
    expect(html).toContain(
      "Lets this platform create, update and remove API keys on the gateway for your people. It is an account-level credential; keep it private.",
    );
    expect(html).toMatch(/type="password"[^>]*data-testid="settings-gateway-admin-token"/);
    expect(html).toMatch(/type="number"[^>]*data-testid="settings-gateway-admin-account-id"/);
    expect(html).toContain("Account ID (optional)");
  });

  it("offers Save and Remove as buttons, and Remove only once a token is saved", () => {
    expect(panel()).toMatch(/data-testid="settings-gateway-admin-save"/);
    expect(panel({ state: NOT_SET })).toMatch(/disabled=""[^>]*data-testid="settings-gateway-admin-remove"/);
    expect(panel({ state: CONFIGURED })).not.toMatch(/disabled=""[^>]*data-testid="settings-gateway-admin-remove"/);
  });

  it("holds Save until a token is typed", () => {
    expect(panel({ token: "" })).toMatch(/disabled=""[^>]*data-testid="settings-gateway-admin-save"/);
    expect(panel({ token: "x" })).not.toMatch(/disabled=""[^>]*data-testid="settings-gateway-admin-save"/);
  });

  it("holds Save while a save is running", () => {
    expect(panel({ busy: true, token: "x" })).toMatch(/disabled=""[^>]*data-testid="settings-gateway-admin-save"/);
  });

  it("shows each status as text", () => {
    const cases: Array<[GatewayAdminState, string]> = [
      [{ ...CONFIGURED, status: "ok" }, "Connected"],
      [{ ...CONFIGURED, status: "invalid" }, "Not accepted by the gateway"],
      [{ ...CONFIGURED, status: "unreachable" }, "Gateway not reachable"],
      [{ ...CONFIGURED, status: "unchecked", checkedAt: null }, "Not checked"],
      [NOT_SET, "No token saved"],
    ];
    for (const [state, words] of cases) {
      const html = panel({ state });
      expect(html, words).toMatch(new RegExp(`data-testid="settings-gateway-admin-status"[^>]*>${words}`));
    }
  });

  it("adds the time it was last checked, when there is one", () => {
    expect(panel()).toContain("Last checked");
    expect(panel({ state: { ...CONFIGURED, checkedAt: null } })).not.toContain("Last checked");
  });

  it("asks for confirmation before a remove, in an inline panel with its own cancel", () => {
    const html = panel({ confirming: true });
    expect(html).toContain('data-testid="settings-gateway-admin-confirm"');
    expect(html).toContain("Remove the gateway management token from this platform?");
    expect(html).toContain('data-testid="settings-gateway-admin-remove-confirm"');
    expect(html).toContain('data-testid="settings-gateway-admin-remove-cancel"');
    expect(html).not.toContain('data-testid="settings-gateway-admin-remove"');
  });

  it("says Saved and shows the status after a save, with the token field empty", () => {
    const html = panel({ token: "", message: "Saved" });
    expect(html).toMatch(/data-testid="settings-gateway-admin-message"[^>]*>Saved</);
    expect(html).toMatch(/data-testid="settings-gateway-admin-status"[^>]*>Connected/);
    expect(html).toMatch(/data-testid="settings-gateway-admin-token" value=""/);
    expect(html).not.toContain(SENTINEL);
  });

  it("shows a refused save as an alert", () => {
    const html = panel({ error: "Could not save the gateway management token. Try again in a moment." });
    expect(html).toMatch(/role="alert"[^>]*data-testid="settings-gateway-admin-error"/);
    expect(html).toContain("Could not save the gateway management token.");
  });

  it("shows a failed status read as an alert, and still draws the form", () => {
    const html = panel({ state: null, loadFailed: true });
    expect(html).toContain(t("settings.gatewayAdmin.loadFailed"));
    expect(html).toContain('data-testid="settings-gateway-admin-load-error"');
    expect(html).toContain('data-testid="settings-gateway-admin-token"');
  });

  it("never names the product's mascot or brand, in either language", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const state of [CONFIGURED, NOT_SET, null]) {
        expect(
          panel({ state, confirming: true, error: "e", message: "m", loadFailed: true }).toLowerCase(),
          locale,
        ).not.toContain("nultron");
      }
    }
  });

  it("speaks Indonesian when the desk does", () => {
    applyLocale("id");
    const html = panel();
    expect(html).toContain("Token manajemen gateway");
    expect(html).toContain("Terhubung");
  });
});

describe("who is offered the section", () => {
  it("is not drawn on a desk, so the Personal Settings page does not change", () => {
    expect(card(SESSIONS_OFF, DESK)).toBe("");
    expect(card(signedIn("owner"), DESK)).toBe("");
  });

  it("is not drawn on the hosted server before ping has answered", () => {
    expect(card(signedIn("owner"), EVERYTHING_OFF)).toBe("");
  });

  it("is drawn to a hosted owner and to a hosted admin", () => {
    expect(card(signedIn("owner"), HOSTED)).toContain('data-testid="settings-gateway-admin"');
    expect(card(signedIn("admin"), HOSTED)).toContain('data-testid="settings-gateway-admin"');
  });

  it("is not drawn to a hosted member, nor to a role the screen cannot read", () => {
    expect(card(signedIn("member"), HOSTED)).toBe("");
    expect(card(signedIn(), HOSTED)).toBe("");
  });

  it("does not render a single control to someone who is not drawn", () => {
    expect(card(signedIn("member"), HOSTED)).not.toContain("settings-gateway-admin-token");
    expect(card(SESSIONS_OFF, DESK)).not.toContain("settings-gateway-admin-save");
  });
});

describe("the Settings page mounts the section beside the company key", () => {
  it("imports it once and mounts it after the settings form, not inside it", () => {
    const page = source("../components/settings-page.tsx");
    expect(page).toContain('import { SettingsGatewayAdminCard } from "./settings-gateway-admin-card";');
    expect(page.split("<SettingsGatewayAdminCard />").length - 1).toBe(1);
    expect(page.indexOf("</form>")).toBeLessThan(page.indexOf("<SettingsGatewayAdminCard />"));
    expect(page.indexOf("<SettingsGatewayAdminCard />")).toBeLessThan(page.indexOf("<AccountSessionRow />"));
  });
});

describe("the gateway management locale keys", () => {
  const keys = [
    "heading",
    "help",
    "tokenLabel",
    "tokenPlaceholderSaved",
    "tokenPlaceholderEmpty",
    "accountIdLabel",
    "accountIdPlaceholderSaved",
    "accountIdPlaceholderEmpty",
    "accountIdInvalid",
    "tokenRequired",
    "save",
    "remove",
    "removeConfirm",
    "removeConfirmSubmit",
    "cancel",
    "saved",
    "removed",
    "failed",
    "removeFailed",
    "forbidden",
    "loadFailed",
    "status.ok",
    "status.invalid",
    "status.unreachable",
    "status.unchecked",
    "status.notSet",
  ];

  it("is translated in both locales", () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      for (const key of keys) {
        const full = `settings.gatewayAdmin.${key}`;
        expect(t(full), `${locale} ${full}`).not.toBe(full);
      }
    }
  });
});
