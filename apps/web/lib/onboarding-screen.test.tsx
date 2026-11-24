/**
 * The streamlined first-run screen, rendered.
 *
 * Opens directly on a single minimalist setup card with brand mark, title, subtitle, and gateway key
 * input — no 3-step stepper, no decorative hero aurora/floating shapes, and no extra Try wall.
 * A closed gate shows the catalog sentence for that status and never prints the gateway URL.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT_NAME, GATEWAY_NAME } from "@agentforge/core/gateway";
import { OnboardingScreen } from "@/components/onboarding-screen";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import type { GatewayGatePayload } from "./gateway-gate";

afterEach(() => {
  resetLocaleForTests();
});

const CLOSED: GatewayGatePayload = {
  status: "invalid_key",
  allowed: false,
  grace: false,
  endpoint: "https://api.tokotokenai.com/v1",
  endpointLocked: true,
  checkedAt: "2026-09-26T00:00:00.000Z",
  lastOkAt: null,
};

function render(gateway?: GatewayGatePayload | null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <OnboardingScreen onDone={() => {}} gateway={gateway} />
    </MemoryRouter>,
  );
}

describe("onboarding screen", () => {
  it("opens a fresh desk on a single minimalist key-setup card in the in-app name", () => {
    const markup = render(null);
    expect(markup).toContain('data-testid="onboarding-card"');
    expect(markup).toContain('data-testid="onboarding-form"');
    expect(markup).toContain('data-testid="onboarding-key"');
    expect(markup).toContain('data-testid="onboarding-continue"');
    expect(markup).toContain(`Welcome to ${DEFAULT_PRODUCT_NAME}`);
    expect(markup).toContain(t("onboarding.keyHelp", { productName: DEFAULT_PRODUCT_NAME, gatewayName: GATEWAY_NAME }));
    expect(markup).not.toContain('data-testid="onboarding-steps"');
    expect(markup).not.toContain("hero-aurora");
    expect(markup).not.toContain("float-shape");
    expect(markup).not.toContain("DPSBuddy");
    expect(markup).not.toMatch(/tokotokenai|https?:\/\//);
  });

  it("shows the friendly reason and recheck action when the gate is closed, with no address", () => {
    const markup = render(CLOSED);
    expect(markup).toContain('data-testid="onboarding-form"');
    expect(markup).toContain('data-testid="onboarding-key"');
    expect(markup).toContain('data-testid="onboarding-continue"');
    expect(markup).toContain('data-testid="onboarding-recheck"');
    expect(markup).toContain('data-testid="onboarding-gate-reason"');
    expect(markup).toContain(`That key didn&#x27;t work. Check it at ${GATEWAY_NAME} and paste it again.`);
    expect(markup).not.toContain('data-testid="onboarding-gateway-host"');
    expect(markup).not.toMatch(/tokotokenai|https?:\/\//);
  });

  it("speaks Indonesian on an id desk, still under the in-app name", () => {
    applyLocale("id");
    const markup = render(null);
    expect(markup).toContain(`Selamat datang di ${DEFAULT_PRODUCT_NAME}`);
    expect(markup).toContain(t("onboarding.keyHelp", { productName: DEFAULT_PRODUCT_NAME, gatewayName: GATEWAY_NAME }));
    expect(markup).not.toContain("DPSBuddy");
  });
});
