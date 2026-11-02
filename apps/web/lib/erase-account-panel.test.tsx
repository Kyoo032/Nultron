/**
 * The "Erase company account" panel, rendered (owner decision 2026-10-01, SR-65).
 *
 * `renderToStaticMarkup` against the real `t()` and the real catalogs, in both locales: that the final
 * button really is disabled until the phrase matches, that the warning says what the owner decided it
 * must say, that the panel is wired for a screen reader, and that no catalog key is missing from either
 * language. Focus moves and the Escape key need a browser and are driven there (see the verify recipe,
 * `features/settings.md`); the rules they enforce are the reducer's, in `erase-account-flow.test.ts`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCapabilitiesFixture } from "./host-capabilities";
import { hostCapabilities } from "@agentforge/core/capabilities";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { SessionFixture, type SessionSnapshot } from "./session";

const OWNER_SESSION: SessionSnapshot = {
  status: "signed-in",
  identity: { userId: "usr_1", orgId: "org_1", tenantId: "tnt_1", expiresAt: 0, role: "owner" },
  reason: null,
};

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
  resetApp: async () => ({ ok: false, scope: "tenant", relaunch: false, resetPending: false, gateway: null }),
  cancelReset: async () => ({ ok: true, resetPending: false }),
  relaunchDesktopApp: async () => ({ ok: false, reason: "unavailable" }),
}));

const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });

async function panel(props: { typed?: string; busy?: boolean; reason?: "forbidden" | "shared" | "generic" | null }) {
  const { EraseAccountPanel } = await import("@/components/settings-erase-account");
  return renderToStaticMarkup(
    <EraseAccountPanel
      typed={props.typed ?? ""}
      busy={props.busy ?? false}
      reason={props.reason ?? null}
      ids={{ title: "t", warning: "w", people: "p", instruction: "i", input: "in" }}
      onType={() => undefined}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

/** The attribute, not the word: every button's class list carries a `disabled:` variant. */
function isDisabled(tag: string): boolean {
  return / disabled=""/.test(tag);
}

function submitTag(markup: string): string {
  const match = markup.match(/<button[^>]*data-testid="settings-reset-tenant-submit"[^>]*>/);
  if (!match) {
    throw new Error("the final button is not in the markup");
  }
  return match[0];
}

beforeEach(() => {
  applyLocale("en");
});

afterEach(() => {
  resetLocaleForTests();
});

describe("EraseAccountPanel", () => {
  it("disables the final button until the exact phrase is typed", async () => {
    for (const typed of ["", "RESET", "delete", "DELET"]) {
      expect(isDisabled(submitTag(await panel({ typed }))), typed).toBe(true);
    }
    expect(isDisabled(submitTag(await panel({ typed: "DELETE" })))).toBe(false);
    // Spaces around the phrase are trimmed away before it is sent, so they do not hold the button off.
    expect(isDisabled(submitTag(await panel({ typed: " DELETE " })))).toBe(false);
  });

  it("disables it again while the erase is running, whatever is typed", async () => {
    expect(isDisabled(submitTag(await panel({ typed: "DELETE", busy: true })))).toBe(true);
  });

  it("is a labelled alert dialog whose description is the warning, for a screen reader", async () => {
    const markup = await panel({});
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('aria-labelledby="t"');
    // The description names both warning paragraphs, so they are read when focus lands in the panel.
    expect(markup).toMatch(/role="alertdialog"[^>]*aria-describedby="w p"/);
    expect(markup).toContain('id="w"');
    expect(markup).toContain('id="p"');
    // The box has a real label and is described by the instruction line too.
    expect(markup).toMatch(/<label[^>]*for="in"/);
    expect(markup).toMatch(/<input[^>]*id="in"[^>]*aria-describedby="i"/);
  });

  it("tells the owner everything the decision says it must", async () => {
    const markup = await panel({});
    // Everyone is deleted and signed out, it cannot be undone, and it is covered by the contract.
    expect(markup).toContain("Every person in the company is deleted and signed out");
    expect(markup).toContain("cannot be undone");
    expect(markup).toContain("service contract");
    // The phrase to type is spelled out in the instruction, from the one constant.
    expect(markup).toContain("DELETE");
  });

  it("shows the refusal when the host said no, as an alert", async () => {
    const forbidden = await panel({ reason: "forbidden" });
    expect(forbidden).toContain('role="alert"');
    expect(forbidden).toContain("Only an owner of this company can erase it");
    const generic = await panel({ reason: "generic" });
    expect(generic).toContain("Could not finish that just now");
  });

  it("says plainly that a server holding several companies erases from the operator's side (SR-163)", async () => {
    const shared = await panel({ reason: "shared" });
    expect(shared).toContain('role="alert"');
    expect(shared).toContain("several companies");
    expect(shared).toContain("operator");
    expect(shared).toContain("Nothing has been deleted");
    applyLocale("id");
    const indonesian = await panel({ reason: "shared" });
    expect(indonesian).not.toContain("settings.reset.eraseAccountShared");
    expect(indonesian).toContain("operator");
    expect(indonesian).not.toContain("several companies");
    applyLocale("en");
  });

  it("does not autocomplete or spell-check the phrase box", async () => {
    const markup = await panel({});
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain('spellCheck="false"');
  });

  it("renders sentences, never raw catalog keys, in English and in Indonesian", async () => {
    for (const locale of ["en", "id"] as const) {
      applyLocale(locale);
      const markup = await panel({ reason: "forbidden" });
      expect(
        [...markup.matchAll(/settings\.reset\.[\w.]+/g)].map((match) => match[0]),
        locale,
      ).toEqual([]);
    }
  });

  it("speaks Indonesian, and keeps the phrase itself untranslated", async () => {
    applyLocale("id");
    const markup = await panel({});
    expect(markup).toContain("Setiap orang di perusahaan ikut dihapus");
    expect(markup).toContain("tidak bisa dibatalkan");
    expect(markup).toContain("kontrak layanan");
    // The server compares one word; the Indonesian screen asks for the same one.
    expect(markup).toContain("DELETE");
  });
});

describe("the hosted card", () => {
  async function card(capabilities = HOSTED) {
    const { SettingsResetCard } = await import("@/components/settings-reset-card");
    // The button is shown to an owner only (SR-65); `host-capabilities.test.tsx` pins who else sees it.
    return renderToStaticMarkup(
      <MemoryRouter>
        <SessionFixture value={OWNER_SESSION}>
          <HostCapabilitiesFixture capabilities={capabilities}>
            <SettingsResetCard />
          </HostCapabilitiesFixture>
        </SessionFixture>
      </MemoryRouter>,
    );
  }

  it("shows the red first button and none of the confirmation: the first click opens it", async () => {
    const markup = await card();
    expect(markup).toContain('data-testid="settings-reset-tenant"');
    expect(markup).not.toContain("settings-reset-tenant-confirm");
    expect(markup).not.toContain("settings-reset-tenant-submit");
    // Not hidden in the collapsed "Sign out and delete" disclosure: it is where an owner can see it.
    const disclosure = markup.match(/<details[\s\S]*<\/details>/)?.[0] ?? "";
    expect(disclosure).toContain("settings-reset-key");
    expect(disclosure).not.toContain("settings-reset-tenant");
  });

  it("makes the first button bright red, with a warning mark a screen reader skips", async () => {
    const markup = await card();
    const tag = markup.match(/<button[^>]*data-testid="settings-reset-tenant"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain("bg-[var(--danger)]");
    expect(tag).toContain('aria-expanded="false"');
    expect(markup).toMatch(/data-testid="settings-reset-tenant"[^>]*>(<svg[^>]*aria-hidden="true")/);
  });

  it("is absent on a desk, where Start over is the one that works", async () => {
    const markup = await card(hostCapabilities({}));
    expect(markup).not.toContain("settings-reset-tenant");
  });
});
