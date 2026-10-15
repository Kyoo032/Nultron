import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@agentforge/core/artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsError } from "@/lib/docs-client";
import { applyLocale, resetLocaleForTests, t } from "@/lib/i18n";
import type { ProjectFile } from "@/lib/projects-client";
import {
  canImportAsDocument,
  importAsDocument,
  importMessageKey,
  type ImportMessageKey,
  type ProjectFileWithEditable,
} from "@/lib/projects-doc-import";

afterEach(() => {
  resetLocaleForTests();
});

const file = (overrides: Partial<ProjectFileWithEditable> = {}): ProjectFileWithEditable => {
  const base: ProjectFile = {
    id: "art_1",
    kind: "artifact",
    title: "Q3 report",
    mime: DOCX_MIME,
    sizeBytes: 2048,
    ownerUserId: "user_ana",
    updatedAt: 1,
    previewUrl: null,
    downloadUrl: "/api/v1/artifacts/art_1/file",
  };
  return { ...base, ...overrides };
};

const EN: Record<ImportMessageKey, string> = {
  "projects.files.importFailed": "The file could not be imported.",
  "projects.files.importTooLarge": "This file is too large to import.",
  "projects.files.importNotEditable": "This file can't be read as a document.",
  "projects.files.importUnavailable": "The import is not available right now. Try again.",
  "projects.files.importNotFound": "Not found, or you are not a member of this Workspace.",
};

const ID: Record<ImportMessageKey, string> = {
  "projects.files.importFailed": "Berkas tidak bisa diimpor.",
  "projects.files.importTooLarge": "Berkas ini terlalu besar untuk diimpor.",
  "projects.files.importNotEditable": "Berkas ini tidak bisa dibaca sebagai dokumen.",
  "projects.files.importUnavailable": "Impor belum bisa dilakukan sekarang. Coba lagi.",
  "projects.files.importNotFound": "Tidak ditemukan, atau Anda bukan anggota ruang kerja ini.",
};

describe("canImportAsDocument", () => {
  it.each([DOCX_MIME, XLSX_MIME, PDF_MIME])(
    "offers the import for a %s file that is not yet an editable document",
    (mime) => {
      expect(canImportAsDocument(file({ mime, editable: false }))).toBe(true);
    },
  );

  it("hides the import for a file that is already an editable document", () => {
    expect(canImportAsDocument(file({ editable: true }))).toBe(false);
  });

  it("hides the import while the host does not say whether the file is editable", () => {
    expect(canImportAsDocument(file())).toBe(false);
  });

  it("hides the import for a type that is not Word, Excel or PDF", () => {
    expect(canImportAsDocument(file({ mime: "text/plain", editable: false }))).toBe(false);
    expect(canImportAsDocument(file({ mime: "image/png", editable: false }))).toBe(false);
  });

  it("hides the import for a generated picture or clip", () => {
    expect(canImportAsDocument(file({ kind: "image", editable: false }))).toBe(false);
    expect(canImportAsDocument(file({ kind: "video", mime: PDF_MIME, editable: false }))).toBe(false);
  });
});

describe("importMessageKey", () => {
  it.each([
    [404, "projects.files.importNotFound"],
    [409, "projects.files.importNotEditable"],
    [413, "projects.files.importTooLarge"],
    [503, "projects.files.importUnavailable"],
  ] as const)("maps HTTP %i to its own sentence", (status, key) => {
    expect(importMessageKey(new DocsError("code", "host sentence", status))).toBe(key);
  });

  it.each([400, 403, 500])("maps HTTP %i to the generic sentence", (status) => {
    expect(importMessageKey(new DocsError("code", "host sentence", status))).toBe("projects.files.importFailed");
  });

  it("maps a network failure to the generic sentence", () => {
    expect(importMessageKey(new TypeError("Failed to fetch"))).toBe("projects.files.importFailed");
  });
});

describe("importAsDocument", () => {
  it("imports the file, then navigates to the new document in the same Workspace", async () => {
    const importDoc = vi.fn(async () => "art_2");
    const navigate = vi.fn();

    const outcome = await importAsDocument("art_1", "proj_1", { importDoc, navigate });

    expect(importDoc).toHaveBeenCalledWith("art_1");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/docs/art_2?workspace=proj_1");
    expect(outcome).toEqual({ ok: true, path: "/docs/art_2?workspace=proj_1" });
  });

  it.each([
    [413, "too_large", "projects.files.importTooLarge"],
    [409, "not_editable", "projects.files.importNotEditable"],
    [503, "unavailable", "projects.files.importUnavailable"],
    [404, "not_found", "projects.files.importNotFound"],
  ] as const)("keeps the page where it is on HTTP %i and shows its sentence", async (status, code, key) => {
    const importDoc = vi.fn(async () => {
      throw new DocsError(code, "host sentence", status);
    });
    const navigate = vi.fn();

    const outcome = await importAsDocument("art_1", "proj_1", { importDoc, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, messageKey: key });
  });

  it("keeps the page where it is on a network failure", async () => {
    const importDoc = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const navigate = vi.fn();

    const outcome = await importAsDocument("art_1", "proj_1", { importDoc, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, messageKey: "projects.files.importFailed" });
  });
});

describe("import sentences", () => {
  it("shows the English sentence for every outcome", () => {
    applyLocale("en");
    for (const key of Object.keys(EN) as ImportMessageKey[]) {
      expect(t(key)).toBe(EN[key]);
    }
  });

  it("shows the Indonesian sentence for every outcome", () => {
    applyLocale("id");
    for (const key of Object.keys(ID) as ImportMessageKey[]) {
      expect(t(key)).toBe(ID[key]);
    }
  });

  it("names neither the old product nor the mascot in any sentence", () => {
    for (const sentence of [...Object.values(EN), ...Object.values(ID)]) {
      expect(sentence).not.toMatch(/nultron/i);
    }
  });
});
