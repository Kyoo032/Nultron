/**
 * First-run setup copy stays concise and accurate in both languages, and the streamlined screen goes
 * straight into Chat without an intermediate Try wall or auto-launched modal tour.
 */
import { FIRST_RUN_MODES } from "@agentforge/core/product-modes";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { OnboardingScreen } from "@/components/onboarding-screen";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import en from "../locales/en/onboarding.json";
import id from "../locales/id/onboarding.json";

afterEach(() => {
  resetLocaleForTests();
});

describe("onboarding first-run copy", () => {
  it("keeps the first desk to Chat alone", () => {
    expect([...FIRST_RUN_MODES]).toEqual(["chat"]);
  });

  it("has accurate welcome and key copy in both English and Indonesian", () => {
    expect(en.welcome).toContain("{productName}");
    expect(id.welcome).toContain("{productName}");
    expect(en.keyHelp).toContain("{gatewayName}");
    expect(id.keyHelp).toContain("{gatewayName}");
    expect(en.intro).not.toMatch(/document|numbers|finance/i);
    expect(id.intro).not.toMatch(/dokumen|angka|keuangan/i);
    applyLocale("id");
    expect(t("onboarding.tourNext")).toBe(id.tourNext);
  });

  it("renders the streamlined key card without a Try wall or tour promise", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OnboardingScreen onDone={() => {}} gateway={null} />
      </MemoryRouter>,
    );
    expect(markup).toContain('data-testid="onboarding-card"');
    expect(markup).toContain('data-testid="onboarding-form"');
    expect(markup).not.toContain('data-testid="onboarding-try"');
    expect(markup).not.toContain('data-testid="onboarding-tour-hint"');
  });
});
