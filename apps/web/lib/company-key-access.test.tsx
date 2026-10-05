/**
 * M4 on the screen — who is offered the company's gateway key on the hosted app.
 *
 * The host refuses a member's key write (`403 settings_key_forbidden`, `settings-key-roles.test.ts`).
 * This file holds the other half: the screens do not dangle a key field, a Save that cannot take it, a
 * "Sign out of the gateway" button or an onboarding key step at somebody the host will refuse. The role
 * is what the host reports for the person (`GET /api/v1/auth/session`, the membership row) and the
 * screen only hides controls with it — a courtesy, never the control. A stale role costs one refused
 * click.
 *
 * Unknown is never an administrator: a signed-in person whose role this screen cannot read does not see
 * the key controls either, the same fail-closed reading the Erase account button has.
 *
 * Personal is held to the byte. `personal-settings-page.golden.json` is the markup `SettingsPage`
 * rendered on a desk BEFORE this change, in English and in Indonesian; the page as it is today must
 * render it unchanged, because a desk has no session and no role to read.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { mayChangeCompanyKey } from "./company-key-access";
import { HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { SESSION_BOOTING, SESSIONS_OFF, SessionFixture, type SessionRole, type SessionSnapshot } from "./session";
import type { GatewayGatePayload } from "./gateway-gate";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
  checkGateway: async () => null,
  relaunchDesktopApp: async () => ({}),
  resetApp: async () => ({}),
  cancelReset: async () => ({}),
}));

const GOLDEN = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "personal-settings-page.golden.json"),
    "utf8",
  ),
) as Record<string, string>;

const DESK = hostCapabilities({});
const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

function signedIn(role?: SessionRole): SessionSnapshot {
  return {
    status: "signed-in",
    identity: { userId: "usr_1", orgId: "org_1", tenantId: "tnt_1", expiresAt: 0, ...(role ? { role } : {}) },
    reason: null,
  };
}

const SIGNED_OUT: SessionSnapshot = { status: "signed-out", identity: null, reason: null };

/** Static markup escapes an apostrophe, so a catalog sentence is compared the way it is written out. */
function escaped(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// The three screens are imported lazily below. The first import evaluates a large closure (the mascot,
// the mode art, the catalogs), which takes seconds on a busy machine and is not what any case asserts, so
// it is paid here under its own budget and the cases keep vitest's default.
beforeAll(async () => {
  await Promise.all([
    import("@/components/settings-page"),
    import("@/components/settings-reset-card"),
    import("@/components/onboarding-screen"),
  ]);
}, 120_000);

afterEach(() => resetLocaleForTests());

describe("mayChangeCompanyKey", () => {
  it("is true for an owner and an admin, the two roles the host admits", () => {
    expect(mayChangeCompanyKey(signedIn("owner"))).toBe(true);
    expect(mayChangeCompanyKey(signedIn("admin"))).toBe(true);
  });

  it("is false for a member, and for a role this screen cannot read", () => {
    expect(mayChangeCompanyKey(signedIn("member"))).toBe(false);
    expect(mayChangeCompanyKey(signedIn())).toBe(false);
  });

  it("is true off the hosted server whatever the session says: no role is read there at all", () => {
    for (const role of ["owner", "admin", "member", undefined] as const) {
      expect(mayChangeCompanyKey(signedIn(role), false), String(role)).toBe(true);
    }
  });

  it("is true wherever there is no signed-in person to judge: a desk, a boot, a signed-out visit", () => {
    // A desk has no sessions at all. The other two are transient on the hosted app and are followed by
    // a sign-in screen or a real role; the host decides either way.
    for (const session of [SESSIONS_OFF, SESSION_BOOTING, SIGNED_OUT]) {
      expect(mayChangeCompanyKey(session), session.status).toBe(true);
    }
  });
});

async function renderSettings(
  session: SessionSnapshot,
  capabilities: typeof DESK,
  locale: "en" | "id" = "en",
): Promise<string> {
  applyLocale(locale);
  const { SettingsPage } = await import("@/components/settings-page");
  return renderToStaticMarkup(
    <MemoryRouter>
      <SessionFixture value={session}>
        <HostCapabilitiesFixture capabilities={capabilities}>
          <SettingsPage />
        </HostCapabilitiesFixture>
      </SessionFixture>
    </MemoryRouter>,
  );
}

describe("Settings", () => {
  it("Personal: renders byte for byte what it rendered before this change, in both languages", async () => {
    expect(await renderSettings(SESSIONS_OFF, DESK, "en")).toBe(GOLDEN["en/desk"]);
    expect(await renderSettings(SESSIONS_OFF, DESK, "id")).toBe(GOLDEN["id/desk"]);
  });

  it("the strings a member must not see are the strings a desk does show", () => {
    // Keeps the absence checks below honest: if the golden stopped carrying these, "not.toContain"
    // would pass for the wrong reason.
    expect(GOLDEN["en/desk"]).toContain(t("settings.gatewayHelp"));
    expect(GOLDEN["en/desk"]).toContain(t("settings.runtimeStub"));
    expect(GOLDEN["en/desk"]).toContain(t("settings.introNeedsKey", { gatewayName: "Toko Token" }));
  });

  it("an owner and an admin on the hosted app get the key field and the Save", async () => {
    for (const role of ["owner", "admin"] as const) {
      const markup = await renderSettings(signedIn(role), HOSTED);
      expect(markup, role).toContain('data-testid="openai-key"');
      expect(markup, role).toContain('data-testid="save-settings"');
      expect(markup, role).not.toContain("settings-key-restricted");
    }
  });

  it("a member gets no key field, a short line saying who can change it, and no pretence otherwise", async () => {
    const markup = await renderSettings(signedIn("member"), HOSTED);

    expect(markup).not.toContain('data-testid="openai-key"');
    expect(markup).toContain('data-testid="settings-key-restricted"');
    expect(markup).toContain(t("settings.keyRestricted"));
    expect(t("settings.keyRestricted")).toBe("Only an owner or admin can change the company key.");
    // Nothing on the page still tells them to paste a key or points at a field that is not there.
    expect(markup).not.toContain(t("settings.gatewayHelp"));
    expect(markup).not.toContain(t("settings.runtimeStub"));
    expect(markup).not.toContain(t("settings.introNeedsKey", { gatewayName: "Toko Token" }));
  });

  it("a member still has the rest of the page: language, the gateway status, the re-check", async () => {
    const markup = await renderSettings(signedIn("member"), HOSTED);

    for (const testid of ["settings-locale", "settings-gateway-status", "settings-gateway-recheck", "save-settings"]) {
      expect(markup, testid).toContain(`data-testid="${testid}"`);
    }
  });

  it("a member does not get Forget the key either: the reset card has nothing left to offer them", async () => {
    const markup = await renderSettings(signedIn("member"), HOSTED);

    expect(markup).not.toContain("settings-reset-key");
    expect(markup).not.toContain("settings-reset-danger");
  });

  it("an unknown role is treated as a member, not as an owner", async () => {
    const markup = await renderSettings(signedIn(), HOSTED);

    expect(markup).not.toContain('data-testid="openai-key"');
    expect(markup).toContain('data-testid="settings-key-restricted"');
  });

  it("says it in Indonesian too", async () => {
    const markup = await renderSettings(signedIn("member"), HOSTED, "id");

    expect(markup).toContain('data-testid="settings-key-restricted"');
    expect(markup).toContain(t("settings.keyRestricted"));
    expect(t("settings.keyRestricted")).toBe("Hanya pemilik atau admin yang dapat mengubah kunci perusahaan.");
  });

  it("renders sentences, not raw catalog keys", async () => {
    const markup = await renderSettings(signedIn("member"), HOSTED);

    expect([...markup.matchAll(/settings\.(?:keyRestricted|introRestricted|runtimeStubRestricted)\b/g)]).toEqual([]);
  });
});

describe("the reset card", () => {
  async function renderReset(session: SessionSnapshot, capabilities: typeof DESK): Promise<string> {
    applyLocale("en");
    const { SettingsResetCard } = await import("@/components/settings-reset-card");
    return renderToStaticMarkup(
      <MemoryRouter>
        <SessionFixture value={session}>
          <HostCapabilitiesFixture capabilities={capabilities}>
            <SettingsResetCard />
          </HostCapabilitiesFixture>
        </SessionFixture>
      </MemoryRouter>,
    );
  }

  it("keeps Forget the key for an owner and an admin", async () => {
    for (const role of ["owner", "admin"] as const) {
      expect(await renderReset(signedIn(role), HOSTED), role).toContain('data-testid="settings-reset-key"');
    }
  });

  it("drops the whole card for a member: the key row was the only thing in it they could use", async () => {
    expect(await renderReset(signedIn("member"), HOSTED)).toBe("");
  });

  it("keeps the owner's Erase account where it was", async () => {
    expect(await renderReset(signedIn("owner"), HOSTED)).toContain("settings-reset-tenant");
  });
});

describe("the onboarding key step", () => {
  const NEEDS_KEY: GatewayGatePayload = {
    status: "needs_key",
    allowed: false,
    grace: false,
    endpoint: "https://api.tokotokenai.com/v1",
    endpointLocked: true,
    checkedAt: null,
    lastOkAt: null,
  };

  async function renderKeyStep(
    session: SessionSnapshot,
    locale: "en" | "id" = "en",
    capabilities: typeof DESK = HOSTED,
  ): Promise<string> {
    applyLocale(locale);
    const { OnboardingScreen } = await import("@/components/onboarding-screen");
    return renderToStaticMarkup(
      <MemoryRouter>
        <SessionFixture value={session}>
          <HostCapabilitiesFixture capabilities={capabilities}>
            <OnboardingScreen onDone={() => {}} onLater={() => {}} gateway={NEEDS_KEY} initialStep="key" />
          </HostCapabilitiesFixture>
        </SessionFixture>
      </MemoryRouter>,
    );
  }

  it("an owner and an admin see the key form as they always did", async () => {
    for (const role of ["owner", "admin"] as const) {
      const markup = await renderKeyStep(signedIn(role));
      expect(markup, role).toContain('data-testid="onboarding-key"');
      expect(markup, role).toContain('data-testid="onboarding-continue"');
      expect(markup, role).not.toContain("onboarding-key-restricted");
    }
  });

  it("a member gets no key box and no Check this key: they are told who can add it, and can still wait", async () => {
    const markup = await renderKeyStep(signedIn("member"));

    expect(markup).not.toContain('data-testid="onboarding-key"');
    expect(markup).not.toContain('data-testid="onboarding-continue"');
    expect(markup).toContain('data-testid="onboarding-key-restricted"');
    expect(markup).toContain(escaped(t("onboarding.keyRestricted", { gatewayName: "Toko Token" })));
    // The ways forward that need no key survive: look around now, or check again once it is added.
    expect(markup).toContain('data-testid="onboarding-later"');
    expect(markup).toContain('data-testid="onboarding-recheck"');
    expect(markup).toContain('data-testid="onboarding-back"');
    // The hint under Add it later tells a person to paste their own key, which is not theirs to do.
    expect(markup).not.toContain('data-testid="onboarding-later-hint"');
  });

  it("speaks Indonesian to a member on an id desk", async () => {
    const markup = await renderKeyStep(signedIn("member"), "id");

    expect(markup).toContain(escaped(t("onboarding.keyRestricted", { gatewayName: "Toko Token" })));
    expect(t("onboarding.keyRestricted", { gatewayName: "Toko Token" })).toMatch(/pemilik atau admin/i);
  });

  it("Personal and a signed-out visit: the key step it always had, with the box and the button", async () => {
    for (const [session, capabilities] of [
      [SESSIONS_OFF, DESK],
      [SIGNED_OUT, HOSTED],
      // The role is never read off the hosted server, even if a session somehow said member.
      [signedIn("member"), DESK],
    ] as const) {
      const markup = await renderKeyStep(session, "en", capabilities);
      expect(markup, session.status).toContain('data-testid="onboarding-key"');
      expect(markup, session.status).toContain('data-testid="onboarding-continue"');
    }
  });
});
