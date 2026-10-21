/**
 * First-run setup says nothing that the first desk cannot do. The first desk has the default agent
 * alone (`FIRST_RUN_MODES`, owner decision 2026-10-21), and every example tile is a job that agent
 * does in its own chat with a tool it binds. The hello and the tiles say so in both languages, and
 * promise the tour only while it is coming.
 */
import { FIRST_RUN_MODES } from "@agentforge/core/product-modes";
import { virtualAgentFor } from "@agentforge/core/virtual-agents";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { EXAMPLES, EXAMPLE_MODE, OnboardingScreen } from "@/components/onboarding-screen";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import en from "../locales/en/onboarding.json";
import id from "../locales/id/onboarding.json";

afterEach(() => {
  resetLocaleForTests();
});

const NOT_ON_A_FIRST_DESK = ["documents", "finance", "data", "market", "legal", "meeting", "music", "edit", "education"];

const EXAMPLE_TOOL: Record<(typeof EXAMPLES)[number], string | null> = {
  chat: null,
  research: "research_dossier",
  images: "image_generate",
  presentation: "build_deck",
};

describe("onboarding's example tiles", () => {
  it("only offer what a first desk does: the default agent alone, with a tool it binds for each tile", () => {
    expect([...FIRST_RUN_MODES]).toEqual(["chat"]);
    const tools = virtualAgentFor("chat").tools;
    for (const example of EXAMPLES) {
      const tool = EXAMPLE_TOOL[example];
      if (tool) {
        expect(tools, example).toContain(tool);
      }
    }
  });

  it("do not name a tool that is not on a first desk", () => {
    for (const example of EXAMPLES) {
      expect(NOT_ON_A_FIRST_DESK, example).not.toContain(EXAMPLE_MODE[example]);
    }
  });

  it("have a title and a hint in both catalogs, and no leftover tile for a tool that is not there", () => {
    for (const catalog of [en, id]) {
      expect(Object.keys(catalog.examples).sort()).toEqual([...EXAMPLES].sort());
      for (const example of EXAMPLES) {
        expect(catalog.examples[example].title.length).toBeGreaterThan(0);
        expect(catalog.examples[example].hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("onboarding's hello", () => {
  it("describes what the first desk can do, in English and in Indonesian", () => {
    expect(en.intro).toMatch(/research/i);
    expect(en.intro).toMatch(/picture|image/i);
    expect(en.intro).toMatch(/presentation/i);
    expect(en.intro).not.toMatch(/document|numbers|finance/i);
    expect(id.intro).toMatch(/riset/i);
    expect(id.intro).toMatch(/presentasi/i);
    expect(id.intro).not.toMatch(/dokumen|angka|keuangan/i);
  });

  it("promises the tour in both languages, and the key exists in both", () => {
    expect(en.tourNext).toContain("tour");
    expect(id.tourNext).toContain("Tur");
    applyLocale("id");
    expect(t("onboarding.tourNext")).toBe(id.tourNext);
  });

  it("renders the hello step without the tour promise: that line belongs to the last step", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OnboardingScreen onDone={() => {}} gateway={null} />
      </MemoryRouter>,
    );
    expect(markup).toContain('data-testid="onboarding-welcome"');
    expect(markup).not.toContain('data-testid="onboarding-tour-hint"');
  });
});
