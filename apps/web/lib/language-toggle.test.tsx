import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageToggle } from "@/components/language-toggle";
import { applyLocale, getLocale, LOCALE_RESTART_EVENT, resetLocaleForTests, t } from "./i18n";
import { LocaleContext, useLocale, useLocaleEpoch } from "./locale-context";
import { switchAppLocale } from "./switch-locale";
import { localizedLibrary } from "./ui-copy";
import { installMiniDom } from "./test-dom";

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

let setDraftText: ((value: string) => void) | null = null;
let draftMounts = 0;
let draftUnmounts = 0;

function StatefulDraft() {
  const [draft, setDraft] = useState("");
  setDraftText = setDraft;
  useEffect(() => {
    draftMounts += 1;
    return () => {
      draftUnmounts += 1;
    };
  }, []);
  return <output data-testid="dashboard-draft">{draft}</output>;
}

function LocalizedStarter() {
  const locale = useLocale();
  const starters = useMemo(() => localizedLibrary("research", locale), [locale]);
  return <span data-testid="localized-starter">{starters[0]?.title}</span>;
}

function LocaleHarness() {
  useLocaleEpoch();
  return (
    <LocaleContext.Provider value={getLocale()}>
      <section>
        <h1>{t("research.title")}</h1>
        <LocalizedStarter />
        <StatefulDraft />
      </section>
    </LocaleContext.Provider>
  );
}

describe("locale switching in the mounted shell", () => {
  it("updates translated copy without unmounting a stateful work-mode child", async () => {
    const dom = installMiniDom();
    try {
      setDraftText = null;
      draftMounts = 0;
      draftUnmounts = 0;
      const container = dom.document.createElement("div");
      dom.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(<LocaleHarness />);
      });
      expect(container.textContent).toContain("Research Dashboard");
      expect(container.textContent).toContain("Competitive landscape");

      await act(async () => {
        setDraftText?.("unsent research draft");
      });
      expect(container.textContent).toContain("unsent research draft");

      await act(async () => {
        applyLocale("id");
        dom.window.dispatchEvent(new Event(LOCALE_RESTART_EVENT));
      });

      expect(container.textContent).toContain("Dasbor Riset");
      expect(container.textContent).toContain("Peta persaingan");
      expect(container.textContent).toContain("unsent research draft");
      expect(draftMounts).toBe(1);
      expect(draftUnmounts).toBe(0);
      await act(async () => {
        root.unmount();
      });
    } finally {
      dom.restore();
    }
  });

  it("is the structure App uses for Shell", () => {
    const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const app = readFileSync(join(webRoot, "src/App.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(app).toContain("const localeEpoch = useLocaleEpoch()");
    expect(app).toContain("<LocaleProvider>");
    expect(app).not.toMatch(/<Shell\s+key=/);
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
