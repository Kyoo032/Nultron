/**
 * The prompt-template panel (Edit › Generate › Video, and /videos) reads `edit.templates.*`.
 *
 * `renderToStaticMarkup` against the real `t()` and the real catalogs: with the locale set to
 * Indonesian the heading, category chips, titles, citation line and prompting rules are the
 * Indonesian strings. The prompt body, tips and source citations stay the cited English, because
 * that text is what a model is given and what the guide names.
 */
import { promptTemplateById } from "@agentforge/core/edit";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { EditPromptTemplates } from "@/components/edit-prompt-templates";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

const SELECTED = "promo-product-stone";

afterEach(() => {
  resetLocaleForTests();
});

function renderPanel(): string {
  return renderToStaticMarkup(<EditPromptTemplates onPick={() => undefined} selectedId={SELECTED} />);
}

describe("prompt template panel locale", () => {
  it("shows the Indonesian catalog strings when the locale is id", () => {
    applyLocale("id");
    const html = renderPanel();
    const template = promptTemplateById(SELECTED);
    expect(template).toBeDefined();
    if (!template) {
      return;
    }

    expect(t("edit.templates.heading")).toBe("Mulai dari templat prompt");
    expect(html).toContain("Mulai dari templat prompt");
    expect(html).toContain("Semua");
    expect(html).toContain("Promo produk");
    expect(html).toContain("Talking head");
    expect(html).toContain("Reel vertikal");
    expect(html).toContain("Sosial persegi");
    expect(html).toContain("Produk di meja batu");
    expect(html).toContain("Aturan prompt");
    expect(html).toContain("Mulai dari subjek dan aksi; urutkan beberapa aksi sesuai linimasa.");
    expect(html).toContain(
      t("edit.templates.fromSource", { site: template.source.site, title: template.source.title }),
    );
    expect(html).toContain("Dari Higgsfield: Generating with Seedance 2.0");

    expect(html).not.toContain("edit.templates.");
    expect(html).not.toContain("Start from a prompt template");
    expect(html).not.toContain("Prompting rules");
    expect(html).not.toContain("Product promo");
    expect(html).not.toContain("Vertical reel");
    expect(html).not.toContain("Square social");
    expect(html).not.toContain("Product on stone counter");
    expect(html).not.toContain("No templates in this category.");
  });

  it("shows the English catalog strings when the locale is en", () => {
    applyLocale("en");
    const html = renderPanel();
    expect(html).toContain(t("edit.templates.heading"));
    expect(html).toContain("Start from a prompt template");
    expect(html).toContain("Prompting rules");
    expect(html).toContain("Product on stone counter");
    expect(html).toContain("From Higgsfield: Generating with Seedance 2.0");
  });
});
