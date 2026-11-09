/**
 * The Documents checks note, rendered with the real catalogs in both languages, and the studio's wiring of
 * the desk-source picker and of the checks off the response. The picker itself is held in
 * `desk-source-picker.test.tsx`; the rules behind it in `documents-desk-sources.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentChecksNote } from "@/components/document-checks-note";
import { DocumentsStudio } from "@/components/documents-studio";
import { applyLocale, resetLocaleForTests } from "./i18n";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relative: string) => readFileSync(resolve(here, relative), "utf8").replace(/\r\n/g, "\n");

const count = (html: string, needle: string) => html.split(needle).length - 1;

afterEach(() => resetLocaleForTests());

describe("DocumentChecksNote", () => {
  it("draws nothing without a note", () => {
    expect(renderToStaticMarkup(<DocumentChecksNote note={null} />)).toBe("");
  });

  it("says how many sections may not follow the source, names them, and says the draft is saved", () => {
    const html = renderToStaticMarkup(
      <DocumentChecksNote note={{ kind: "grounding", headings: ["Context", "Risks"] }} />,
    );
    expect(html).toContain("2 sections may not follow the source");
    expect(html).toContain('role="status"');
    expect(html).toContain('data-kind="grounding"');
    expect(count(html, "<li")).toBe(2);
    expect(html).toContain("Context");
    expect(html).toContain("The draft is saved.");
    expect(html).toContain("Check against source");
    expect(html).toContain("truncate");
  });

  it("uses the singular for one section", () => {
    const html = renderToStaticMarkup(<DocumentChecksNote note={{ kind: "grounding", headings: ["Context"] }} />);
    expect(html).toContain("1 section may not follow the source");
  });

  it("says structure in words that need no host text, in both languages", () => {
    expect(renderToStaticMarkup(<DocumentChecksNote note={{ kind: "structure" }} />)).toContain(
      "Some sections may be missing or too short",
    );
    applyLocale("id");
    const id = renderToStaticMarkup(<DocumentChecksNote note={{ kind: "grounding", headings: ["A", "B", "C"] }} />);
    expect(id).toContain("3 bagian mungkin menyimpang dari sumber");
    expect(id).toContain("Periksa terhadap sumber");
  });
});

describe("DocumentsStudio wiring", () => {
  it("renders without the picker or the note on a first visit", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocumentsStudio />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="documents-studio-prompt-bar"');
    expect(html).not.toContain("desk-sources");
    expect(html).not.toContain("documents-checks-note");
  });

  const studio = source("../components/documents-studio.tsx");

  it("sends the picked files on generate, rewrite and check, and reads the checks off the response", () => {
    expect(count(studio, "...sourceFilesBody(deskSources)")).toBe(3);
    expect(studio).toContain("splitDraftResponse(data)");
    expect(studio).toContain("landDraft(landed.draft, landed.checks)");
    // A rewrite changes the sections the flags named, so the note goes with it.
    expect(studio).toMatch(/setDraft\(data as DocumentDraft\);\s*\/\/[^\n]*\n\s*setChecks\(null\)/);
  });

  it("puts the picker under the source box and the note under the header", () => {
    expect(studio.indexOf("<SourceMaterialField")).toBeLessThan(studio.indexOf("<DeskSourcePicker"));
    expect(studio.indexOf("<DeskSourcePicker")).toBeLessThan(studio.indexOf("<ModelSelect"));
    expect(studio.indexOf("<ModeHeader")).toBeLessThan(studio.indexOf("<DocumentChecksNote"));
    expect(studio).toContain("pastedChars={sourceText.length}");
  });
});
