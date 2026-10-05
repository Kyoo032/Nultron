/**
 * The "Erase company account" panel at a phone's width (Enterprise only; owner review 2026-10-01, L8).
 *
 * At 360 px the shell's rail leaves the settings card about 160 px of room inside the panel, and the
 * final button used to sit beside Cancel in a wrapping row: the label broke onto four lines. The panel
 * is now a size container and answers to its own width, not the window's (the same reason the Edit empty
 * state does): narrow, the final button is full width under the phrase box, centered, with its warning
 * mark dropped so the words get the room; wide, it is the one-line button it always was.
 *
 * The environment is node with no layout engine, so these hold the rules the browser measurement
 * enforced (driven in a real browser at 360, 400 and desktop widths, both themes, both languages; see
 * `features/settings.md`): the classes that make the stack, and a budget for how long a label may be.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLocale, resetLocaleForTests, t } from "./i18n";

vi.mock("@/lib/api-client", () => ({
  isElectron: () => false,
  apiFetch: async () => ({ ok: true, json: async () => ({}) }) as Response,
  resetApp: async () => ({ ok: false }),
}));

async function panel(): Promise<string> {
  const { EraseAccountPanel } = await import("@/components/settings-erase-account");
  return renderToStaticMarkup(
    <EraseAccountPanel
      typed="DELETE"
      busy={false}
      reason={null}
      ids={{ title: "t", warning: "w", people: "p", instruction: "i", input: "in" }}
      onType={() => undefined}
      onSubmit={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

/** The opening tag of the element carrying `testId`. */
function tag(markup: string, testId: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) {
    throw new Error(`no element carries ${testId}`);
  }
  return match[0];
}

/** What sits between the final button's opening tag and its closing tag. */
function submitInner(markup: string): string {
  const start = markup.indexOf('data-testid="settings-reset-tenant-submit"');
  return markup.slice(markup.indexOf(">", start) + 1, markup.indexOf("</button>", start));
}

beforeEach(() => {
  applyLocale("en");
});
afterEach(() => {
  resetLocaleForTests();
});

describe("the panel answers to its own width", () => {
  it("is a size container, so its buttons follow the room the panel has", async () => {
    expect(tag(await panel(), "settings-reset-tenant-confirm")).toContain("[container-type:inline-size]");
  });

  it("pads less on a phone than on a desk, so the phrase box and the button keep their room", async () => {
    const open = tag(await panel(), "settings-reset-tenant-confirm");
    expect(open).toMatch(/\bp-3\b/);
    expect(open).toMatch(/min-\[480px\]:p-4/);
    expect(open).not.toMatch(/ p-4 /);
  });
});

describe("the final button, narrow and wide", () => {
  it("is full width and centered when the panel is narrow, and shrinks to its label when it is wide", async () => {
    const button = tag(await panel(), "settings-reset-tenant-submit");
    expect(button).toMatch(/\bw-full\b/);
    expect(button).toContain("justify-center");
    expect(button).toContain("text-center");
    expect(button).toMatch(/\[@container\(min-width:22rem\)\]:w-auto/);
  });

  it("sits under the phrase box with Cancel below it when narrow, and beside it when wide", async () => {
    const markup = await panel();
    const rowStart = markup.lastIndexOf("<div", markup.indexOf('data-testid="settings-reset-tenant-submit"'));
    const row = markup.slice(rowStart, markup.indexOf(">", rowStart) + 1);
    expect(row).toMatch(/\bflex-col\b/);
    expect(row).toMatch(/\[@container\(min-width:22rem\)\]:flex-row/);
    expect(row).toMatch(/\[@container\(min-width:22rem\)\]:flex-wrap/);
    // The phrase box comes first and Cancel comes last, in the DOM and so in the tab order.
    expect(markup.indexOf("settings-reset-tenant-confirm-name")).toBeLessThan(
      markup.indexOf("settings-reset-tenant-submit"),
    );
    expect(markup.indexOf("settings-reset-tenant-submit")).toBeLessThan(markup.indexOf("settings-reset-cancel"));
  });

  it("drops the warning mark when narrow so the words get the room, and still shows it when wide", async () => {
    const inner = submitInner(await panel());
    const mark = inner.match(/<svg[^>]*>/)?.[0] ?? "";
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toMatch(/\bhidden\b/);
    expect(mark).toMatch(/\[@container\(min-width:22rem\)\]:block/);
  });
});

describe("the label budget", () => {
  // At 360 px the words have about 150 px. Two lines of that is roughly 34 characters, with no word so
  // long it cannot share a line (measured: "Permanently erase" is 145 px, "Hapus permanen" 132 px). A longer label wraps onto three or four lines again.
  const MAX_LABEL_CHARACTERS = 34;
  const MAX_WORD_CHARACTERS = 17;

  for (const locale of ["en", "id"] as const) {
    it(`keeps the ${locale} final label short enough for two lines`, () => {
      applyLocale(locale);
      const label = t("settings.reset.eraseAccountSubmit");
      expect(label.length).toBeLessThanOrEqual(MAX_LABEL_CHARACTERS);
      for (const word of label.split(/\s+/)) {
        expect(word.length, word).toBeLessThanOrEqual(MAX_WORD_CHARACTERS);
      }
    });

    it(`keeps the ${locale} working label inside the same budget`, () => {
      applyLocale(locale);
      expect(t("settings.reset.eraseAccountWorking").length).toBeLessThanOrEqual(MAX_LABEL_CHARACTERS);
    });
  }

  it("still says what the button does in both languages: erase, permanently, the company account", () => {
    applyLocale("en");
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/permanently/i);
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/erase/i);
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/company/i);
    applyLocale("id");
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/permanen/i);
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/hapus/i);
    expect(t("settings.reset.eraseAccountSubmit")).toMatch(/perusahaan/i);
  });
});
