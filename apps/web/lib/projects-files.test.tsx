import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ImportDocumentAction } from "@/components/projects-files";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";
import type { ProjectFileWithEditable } from "@/lib/projects-doc-import";

afterEach(() => {
  resetLocaleForTests();
});

const file = (overrides: Partial<ProjectFileWithEditable> = {}): ProjectFileWithEditable => ({
  id: "art_1",
  kind: "artifact",
  title: "Q3 report",
  mime: DOCX_MIME,
  sizeBytes: 2048,
  ownerUserId: "user_ana",
  updatedAt: 1,
  previewUrl: null,
  downloadUrl: "/api/v1/artifacts/art_1/file",
  editable: false,
  ...overrides,
});

const render = (row: ProjectFileWithEditable, busy = false) =>
  renderToStaticMarkup(<ImportDocumentAction file={row} busy={busy} onImport={() => {}} />);

describe("Import as document on a Workspace file row", () => {
  it.each([DOCX_MIME, XLSX_MIME, PDF_MIME])("is offered on a %s file that is not yet an editable document", (mime) => {
    const markup = render(file({ mime }));
    expect(markup).toContain('data-testid="projects-file-import"');
    expect(markup).toContain("Import as document");
  });

  it("is hidden on a file that is already an editable document", () => {
    expect(render(file({ editable: true }))).toBe("");
  });

  it("is hidden while the host does not say whether the file is editable", () => {
    expect(render(file({ editable: undefined }))).toBe("");
  });

  it("is hidden on a type that is not Word, Excel or PDF", () => {
    expect(render(file({ mime: "image/png" }))).toBe("");
    expect(render(file({ mime: "text/plain" }))).toBe("");
  });

  it("is hidden on a generated picture or clip", () => {
    expect(render(file({ kind: "image" }))).toBe("");
    expect(render(file({ kind: "video", mime: PDF_MIME }))).toBe("");
  });

  it("is disabled and says Importing while its file is being imported", () => {
    const markup = render(file(), true);
    expect(markup).toContain("disabled");
    expect(markup).toContain("Importing…");
  });

  it("uses the Indonesian label in the Indonesian locale", () => {
    applyLocale("id");
    expect(render(file())).toContain("Impor sebagai dokumen");
  });

  it("names neither the old product nor its mascot in the markup", () => {
    for (const markup of [render(file()), render(file(), true), render(file({ editable: true }))]) {
      expect(markup).not.toMatch(/nultron/i);
    }
  });
});
