/**
 * The Edit Generate tab's needs-key line comes from the `edit` catalog, in both languages.
 *
 * It was an English literal in the JSX ("Add a {gatewayName} gateway key in Settings to generate."), so
 * an Indonesian desk read English on the one line that tells a person why the button is quiet — while
 * `edit.generate.needsKey` already sat, unused, in both catalogs. The sentence is now read from there,
 * and the link label is the shared Settings label every other pane uses (`rail.settings`).
 *
 * The English markup is held to the byte on the Personal desk by `edit-hosted-needs-key.test.tsx`
 * (the literal it captured before this change); this file adds the other language and the source rule.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditGenerateTab } from "@/components/edit-generate-tab";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
}));

afterEach(() => resetLocaleForTests());

function generate(needsKey: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EditGenerateTab project={{ id: "p1" }} models={[]} needsKey={needsKey} gatewayName="Toko Token" />
    </MemoryRouter>,
  );
}

/** The inner HTML of the needs-key paragraph. */
function note(markup: string): string {
  return /<p[^>]*data-testid="edit-needs-key"[^>]*>([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? "";
}

describe("the Edit Generate tab's needs-key line", () => {
  it("reads in English from the edit catalog, with Settings as the link", () => {
    applyLocale("en");
    const line = note(generate(true));

    expect(line).toContain("Add a Toko Token gateway key in");
    expect(line).toContain('<a class="underline" href="/settings"');
    expect(line).toContain(`>${t("rail.settings")}</a>`);
    expect(line.endsWith(" to generate.")).toBe(true);
  });

  it("reads in Indonesian on an id desk, and not in English", () => {
    applyLocale("id");
    const line = note(generate(true));

    expect(t("edit.generate.needsKey", { gateway: "Toko Token", settings: "{settings}" })).toBe(
      "Tambahkan kunci gateway Toko Token di {settings} untuk membuat konten.",
    );
    expect(line).toContain("Tambahkan kunci gateway Toko Token di");
    expect(line).toContain(`>${t("rail.settings")}</a>`);
    expect(line).toContain("untuk membuat konten.");
    expect(line).not.toContain("Add a ");
    expect(line).not.toContain("to generate");
  });

  it("is absent when a key is there", () => {
    applyLocale("en");
    expect(generate(false)).not.toContain("edit-needs-key");
  });

  it("is no English literal in the component any more", () => {
    const web = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(web, "components/edit-generate-tab.tsx"), "utf8");

    expect(source).not.toContain("gateway key in");
    expect(source).toContain('i18nKey="edit.generate.needsKey"');
  });
});
