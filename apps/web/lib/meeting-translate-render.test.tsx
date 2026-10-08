/**
 * Translation is opt-in (doc-flow 7a.2): a button on the minutes, one paid call, only when pressed. The
 * remembered "always translate" choice lives under More and is rendered by `MeetingMore`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingMore, type MeetingMoreProps } from "@/components/meeting-more";
import { MeetingTranslateBar } from "@/components/meeting-translate-bar";
import { applyLocale, resetLocaleForTests } from "./i18n";

afterEach(() => resetLocaleForTests());

describe("MeetingTranslateBar", () => {
  const base = { target: "id" as const, hasTranslation: false, busy: false, disabled: false, onTranslate: vi.fn() };

  it("offers to translate to the other language, and says it uses the key", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingTranslateBar {...base} />);
    expect(html).toContain('data-testid="meeting-translate"');
    expect(html).toContain("Translate to Indonesian");
    expect(html).toContain("Uses your key: one call.");
  });

  it("targets English for minutes written in Indonesian", () => {
    applyLocale("en");
    expect(renderToStaticMarkup(<MeetingTranslateBar {...base} target="en" />)).toContain("Translate to English");
  });

  it("offers a second go once there is a translation, which replaces the first", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingTranslateBar {...base} hasTranslation />);
    expect(html).toContain("Translate again to Indonesian");
  });

  it("is locked while a job runs or the hosted desk has no key", () => {
    expect(renderToStaticMarkup(<MeetingTranslateBar {...base} disabled />)).toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="meeting-translate"/,
    );
  });

  it("shows it is working while the translation runs", () => {
    applyLocale("en");
    expect(renderToStaticMarkup(<MeetingTranslateBar {...base} busy disabled />)).toContain("Translating…");
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<MeetingTranslateBar {...base} target="en" />);
    expect(html).toContain("Terjemahkan ke bahasa Inggris");
    expect(html).toContain("Memakai kunci Anda: satu panggilan.");
  });
});

describe("MeetingMore", () => {
  const props: MeetingMoreProps = {
    open: false,
    onOpenChange: vi.fn(),
    title: "",
    onTitle: vi.fn(),
    locale: "en",
    onLocale: vi.fn(),
    onCreate: vi.fn(),
    createDisabled: false,
    models: [],
    model: "",
    onModel: vi.fn(),
    alwaysTranslate: false,
    onAlwaysTranslate: vi.fn(),
    children: <div data-testid="meeting-recorder" />,
  };

  it("is closed by default and holds everything the front door leaves out", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<MeetingMore {...props} />);
    expect(html).toContain('data-testid="meeting-more"');
    expect(html).not.toMatch(/<details[^>]*data-testid="meeting-more-details"[^>]* open/);
    expect(html).not.toMatch(/<details[^>]* open=""[^>]*data-testid="meeting-more-details"/);
    for (const id of [
      "meeting-new",
      "meeting-title",
      "meeting-locale",
      "meeting-create",
      "meeting-model",
      "meeting-translate-default",
      "meeting-recorder",
      "meeting-how-it-works",
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
  });

  it("opens when it is told to", () => {
    expect(renderToStaticMarkup(<MeetingMore {...props} open />)).toMatch(/<details[^>]* open=""/);
  });

  it("remembers the translate choice as a checkbox, off until chosen", () => {
    const off = renderToStaticMarkup(<MeetingMore {...props} />);
    const on = renderToStaticMarkup(<MeetingMore {...props} alwaysTranslate />);
    expect(off).not.toMatch(/<input[^>]*data-testid="meeting-translate-default"[^>]*checked=""/);
    expect(on).toMatch(/<input[^>]*data-testid="meeting-translate-default"[^>]*checked=""/);
    expect(on).toContain("Always translate the minutes when I press Run");
  });

  it("keeps the manual create form working: Create waits for a title", () => {
    const html = renderToStaticMarkup(<MeetingMore {...props} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-create"/);
    const typed = renderToStaticMarkup(<MeetingMore {...props} title="Weekly" />);
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="meeting-create"/);
  });

  it("says it in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<MeetingMore {...props} />);
    expect(html).toContain("Lainnya");
    expect(html).toContain("Selalu terjemahkan notulen saat saya menekan Jalankan");
    expect(html).not.toContain("meeting.");
  });
});
