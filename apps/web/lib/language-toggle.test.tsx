import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageToggle } from "@/components/language-toggle";
import { applyLocale, getLocale, resetLocaleForTests } from "./i18n";
import { switchAppLocale } from "./switch-locale";

beforeEach(() => {
  resetLocaleForTests();
  applyLocale("en");
});

describe("LanguageToggle", () => {
  it("renders EN with Indonesian switch label in English locale", () => {
    const html = renderToStaticMarkup(<LanguageToggle />);
    expect(html).toContain('data-testid="language-toggle"');
    expect(html).toContain('data-locale="en"');
    expect(html).toContain(">EN<");
    expect(html).toContain('aria-label="Switch language to Bahasa Indonesia"');
  });

  it("renders ID with English switch label in Indonesian locale", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<LanguageToggle />);
    expect(html).toContain('data-locale="id"');
    expect(html).toContain(">ID<");
    expect(html).toContain('aria-label="Ganti bahasa ke Bahasa Inggris"');
  });
});

describe("switchAppLocale", () => {
  it("persists locale, applies it, and updates current locale", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ locale: "id" }), { status: 200 });
    });

    const result = await switchAppLocale("id", fakeFetch as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, locale: "id" });
    expect(getLocale()).toBe("id");
    expect(calls).toEqual([
      { url: "/api/v1/settings", method: "POST", body: JSON.stringify({ locale: "id" }) },
      { url: "/api/v1/settings/apply-locale", method: "POST", body: undefined },
    ]);
  });

  it("returns error without switching locale when settings save fails", async () => {
    const fakeFetch = vi.fn(async () => new Response("error", { status: 500 }));
    const result = await switchAppLocale("id", fakeFetch as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, message: "HTTP 500" });
    expect(getLocale()).toBe("en");
  });
});
