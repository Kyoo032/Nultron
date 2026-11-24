/**
 * The onboarding screen's "Add it later" (Nultron Enterprise only, owner decision 2026-10-01).
 *
 * The button exists only when the caller hands the screen an `onLater`, and the caller does that only
 * for a signed-in person on the hosted build (`canOfferKeyLater`).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { OnboardingScreen } from "@/components/onboarding-screen";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import type { GatewayGatePayload } from "./gateway-gate";

afterEach(() => resetLocaleForTests());

const NEEDS_KEY: GatewayGatePayload = {
  status: "needs_key",
  allowed: false,
  grace: false,
  endpoint: "https://api.tokotokenai.com/v1",
  endpointLocked: true,
  checkedAt: null,
  lastOkAt: null,
};

const REJECTED: GatewayGatePayload = { ...NEEDS_KEY, status: "invalid_key" };

function render(props: { gateway?: GatewayGatePayload | null; onLater?: () => void }): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <OnboardingScreen onDone={() => {}} {...props} />
    </MemoryRouter>,
  );
}

describe("onboarding on the hosted build", () => {
  it("offers Add it later alongside the primary continue button, with a quiet hint", () => {
    const markup = render({ gateway: NEEDS_KEY, onLater: () => {} });

    expect(markup).toContain('data-testid="onboarding-form"');
    expect(markup).toContain('data-testid="onboarding-continue"');
    expect(markup).toContain('data-testid="onboarding-later"');
    expect(markup).toContain(t("onboarding.later"));
    expect(markup).toContain('data-testid="onboarding-later-hint"');
    expect(markup).toContain(t("onboarding.laterHint"));
  });

  it("keeps it a secondary action: Continue stays the one primary button", () => {
    const markup = render({ gateway: NEEDS_KEY, onLater: () => {} });
    const later = /<button[^>]*data-testid="onboarding-later"[^>]*>/.exec(markup)?.[0] ?? "";
    const submit = /<button[^>]*data-testid="onboarding-continue"[^>]*>/.exec(markup)?.[0] ?? "";

    expect(later).not.toContain("btn-primary");
    expect(submit).toContain("btn-primary");
  });

  it("still offers it when the key was rejected, and still shows why", () => {
    const markup = render({ gateway: REJECTED, onLater: () => {} });

    expect(markup).toContain('data-testid="onboarding-gate-reason"');
    expect(markup).toContain('data-testid="onboarding-later"');
  });

  it("speaks Indonesian on an id desk", () => {
    applyLocale("id");
    const markup = render({ gateway: NEEDS_KEY, onLater: () => {} });

    expect(markup).toContain(t("onboarding.later"));
    expect(t("onboarding.later")).toBe("Tambahkan nanti");
    expect(markup).toContain(t("onboarding.laterHint"));
  });
});

describe("onboarding without onLater (Personal / non-hosted)", () => {
  it("has no Add it later and no hint when nobody passed onLater", () => {
    for (const gateway of [NEEDS_KEY, REJECTED, null]) {
      const markup = render({ gateway });

      expect(markup, String(gateway?.status)).toContain('data-testid="onboarding-form"');
      expect(markup).not.toContain('data-testid="onboarding-later"');
      expect(markup).not.toContain('data-testid="onboarding-later-hint"');
      expect(markup).not.toContain(t("onboarding.later"));
    }
  });

  it("renders identical markup with and without the hosted button, apart from the button and hint", () => {
    const personal = render({ gateway: NEEDS_KEY });
    const hosted = render({ gateway: NEEDS_KEY, onLater: () => {} });
    const stripped = hosted
      .replace(/<button[^>]*data-testid="onboarding-later"[^>]*>.*?<\/button>/, "")
      .replace(/<p[^>]*data-testid="onboarding-later-hint"[^>]*>.*?<\/p>/, "");

    expect(stripped).toBe(personal);
  });
});
