/**
 * The one desk-source picker, rendered with the real catalogs in both languages. The environment has no
 * DOM, so the open state and the presses are covered where their rules live (`documents-desk-sources.test.ts`);
 * here we hold what each piece draws, that the picker is absent on a desk without files, and that both
 * studios mount it and still send `sourceFiles` as a list of paths.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DeskSourceChips, DeskSourceList, DeskSourcePicker } from "@/components/desk-source-picker";
import type { FileEntry } from "./files-model";
import { applyLocale, resetLocaleForTests } from "./i18n";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");
const NOOP = () => undefined;

const entry = (path: string, bytes = 2048): FileEntry => ({ path, kind: "file", bytes, updatedAt: 0, version: 1 });
const count = (html: string, needle: string) => html.split(needle).length - 1;

afterEach(() => resetLocaleForTests());

describe("DeskSourceChips", () => {
  it("draws nothing when no file is picked", () => {
    expect(renderToStaticMarkup(<DeskSourceChips selected={[]} disabled={false} onRemove={NOOP} />)).toBe("");
  });

  it("draws one chip per picked file with a remove button that names the file", () => {
    const html = renderToStaticMarkup(
      <DeskSourceChips selected={["notes/plan.md", "brief.md"]} disabled={false} onRemove={NOOP} />,
    );
    expect(count(html, 'data-testid="desk-sources-chip"')).toBe(2);
    expect(count(html, 'data-testid="desk-sources-remove"')).toBe(2);
    expect(html).toContain('aria-label="Remove notes/plan.md"');
    expect(html).toContain('title="notes/plan.md"');
  });

  it("speaks Indonesian, and lets a long path shrink with a title instead of stretching the row", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(
      <DeskSourceChips selected={["a/very/long/path/to/a/file.md"]} disabled onRemove={NOOP} />,
    );
    expect(html).toContain('aria-label="Hapus a/very/long/path/to/a/file.md"');
    expect(html).toContain('aria-label="Berkas meja yang dipakai sebagai sumber"');
    expect(html).toContain('title="a/very/long/path/to/a/file.md"');
    // The folders shorten first and the file name is a span of its own.
    expect(html).toContain("shrink-[1000] truncate");
    expect(html).toContain(">a/very/long/path/to/a/<");
    expect(html).toContain(">file.md<");
    expect(html).toContain("disabled");
  });
});

describe("DeskSourceList", () => {
  const entries = [entry("a.md", 512), entry("notes/b.md", 3 * 1024 * 1024)];

  it("draws a checkbox row per file with its size, checked for a picked one", () => {
    const html = renderToStaticMarkup(
      <DeskSourceList entries={entries} selected={["a.md"]} disabled={false} onToggle={NOOP} />,
    );
    expect(count(html, 'data-testid="desk-sources-option"')).toBe(2);
    expect(html).toMatch(/data-path="a\.md"[^>]*checked=""/);
    expect(html).not.toMatch(/data-path="notes\/b\.md"[^>]*checked=""/);
    expect(html).toContain("512 B");
    expect(html).toContain("3.0 MB");
  });

  it("truncates a long path inside the row and keeps the whole path in the title", () => {
    const long = "projects/2026/third-quarter/board/minutes-of-the-quarterly-planning-meeting-final-v2.md";
    const html = renderToStaticMarkup(
      <DeskSourceList entries={[entry(long)]} selected={[]} disabled={false} onToggle={NOOP} />,
    );
    expect(html).toContain(`title="${long}"`);
    expect(html).toContain("shrink-[1000] truncate");
    expect(html).toContain(">minutes-of-the-quarterly-planning-meeting-final-v2.md<");
  });

  it("disables every unpicked row once five are picked, and leaves the picked ones live", () => {
    const five = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    const all = [...five, "6.md"].map((path) => entry(path));
    const html = renderToStaticMarkup(
      <DeskSourceList entries={all} selected={five} disabled={false} onToggle={NOOP} />,
    );
    const rows = html.split("<li>").slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const picked = five.some((path) => row.includes(`data-path="${path}"`));
      expect(row.includes("disabled"), row).toBe(!picked);
    }
  });
});

describe("DeskSourcePicker", () => {
  it("is absent on a desk with no files and nothing picked (the first paint, before the list arrives)", () => {
    expect(renderToStaticMarkup(<DeskSourcePicker selected={[]} onChange={NOOP} refreshKey={0} />)).toBe("");
  });

  it("still shows the picked files while the list has not arrived, so a pick is never hidden", () => {
    const html = renderToStaticMarkup(<DeskSourcePicker selected={["a.md"]} onChange={NOOP} />);
    expect(html).toContain('data-testid="desk-sources"');
    expect(html).toContain("Add from desk files");
    expect(html).toContain("Up to 5 files");
    expect(html).toContain('data-testid="desk-sources-chip"');
    expect(html).not.toContain("desk-sources-list");
  });

  it("says the cap is reached once five are picked", () => {
    const five = ["1.md", "2.md", "3.md", "4.md", "5.md"];
    const html = renderToStaticMarkup(<DeskSourcePicker selected={five} onChange={NOOP} />);
    expect(html).toContain("5 files picked, the most that fit. Remove one to add another.");
    expect(html).not.toContain("Up to 5 files");
  });

  it("keeps the toggle a disclosure and says the limit in Indonesian", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<DeskSourcePicker selected={["a.md"]} onChange={NOOP} />);
    expect(html).toContain("Tambah dari berkas meja");
    expect(html).toContain("Maksimal 5 berkas");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Add from desk files");
  });
});

describe("the picker strings", () => {
  const load = (locale: "en" | "id") =>
    (JSON.parse(source(`../locales/${locale}/files.json`)) as { deskSources: Record<string, string> }).deskSources;
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("has the same keys and placeholders in both languages", () => {
    const en = load("en");
    const id = load("id");
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(placeholders(id[key] ?? ""), key).toEqual(placeholders(value));
    }
    expect(placeholders(en.limit ?? "")).toEqual(["max"]);
    expect(placeholders(en.full ?? "")).toEqual(["max"]);
    expect(placeholders(en.remove ?? "")).toEqual(["name"]);
  });
});

describe("the studios that mount the picker", () => {
  const documents = source("../components/documents-studio.tsx");
  const presentations = source("../components/presentations-studio.tsx");

  it("is the only desk-source control: the two old components and their test ids are gone", () => {
    expect(existsSync(resolve(here, "../components/documents-desk-sources.tsx"))).toBe(false);
    expect(existsSync(resolve(here, "../components/presentation-desk-files.tsx"))).toBe(false);
    for (const studio of [documents, presentations]) {
      expect(count(studio, "<DeskSourcePicker")).toBe(1);
      expect(studio).not.toContain("DocumentsDeskSources");
      expect(studio).not.toContain("PresentationDeskFiles");
      expect(studio).not.toContain("useDeskFiles");
    }
  });

  it("Documents keeps sending the picked paths as sourceFiles on generate, rewrite and check", () => {
    expect(count(documents, "...sourceFilesBody(deskSources)")).toBe(3);
  });

  it("Presentation keeps sending the picked paths as sourceFiles on both engines and on rewrite", () => {
    expect(count(presentations, "sourceFiles: sourceFiles.length > 0 ? sourceFiles : undefined")).toBe(3);
    expect(presentations).toContain("pastedChars={sourceText.length}");
  });

  it("puts the picker under the source box in both", () => {
    for (const studio of [documents, presentations]) {
      expect(studio.indexOf("<SourceMaterialField")).toBeLessThan(studio.indexOf("<DeskSourcePicker"));
    }
  });
});
