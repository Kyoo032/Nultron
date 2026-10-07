import { describe, expect, it } from "vitest";
import { isFileRefusal, parseDeskPath } from "@agentforge/core/tools/files";
import { privateFolderFor } from "../desk-files/private-uploads";
import { deskPathForDocument } from "./desk-name";

const pathFor = (filename: string, userId = "ana") => deskPathForDocument(filename, userId);

describe("deskPathForDocument", () => {
  it("puts the file in the person's own private folder under uploads", () => {
    expect(pathFor("a.pdf", "ana")).toBe(`uploads/${privateFolderFor("ana")}/a.pdf.md`);
    expect(pathFor("a.pdf", "ben")).toBe(`uploads/${privateFolderFor("ben")}/a.pdf.md`);
    expect(pathFor("a.pdf", "ana")).not.toBe(pathFor("a.pdf", "ben"));
    expect(pathFor("a.pdf", "ana@example.test")).toMatch(/^uploads\/~h-[0-9a-f]{32}\/a\.pdf\.md$/);
  });

  it("makes two names that differ only by Unicode form one file, since they read the same", () => {
    const composed = "Laporan café.pdf";
    const decomposed = "Laporan café.pdf";
    expect(composed).not.toBe(decomposed);
    expect(pathFor(composed)).toBe(pathFor(decomposed));
  });

  it("keeps two names that differ only by letter case apart, as the desk's paths are case sensitive", () => {
    expect(pathFor("Report.PDF")).not.toBe(pathFor("report.pdf"));
    expect(pathFor("Report.PDF")).toBe("uploads/~ana/Report.PDF.md");
  });

  it("puts the whole file name under uploads and adds .md", () => {
    expect(pathFor("Q3 report.pdf")).toBe("uploads/~ana/Q3 report.pdf.md");
    expect(pathFor("Laporan Keuangan.XLSX")).toBe("uploads/~ana/Laporan Keuangan.XLSX.md");
  });

  it("keeps the extension, so a report.pdf and a report.docx do not share a file", () => {
    expect(pathFor("report.pdf")).not.toBe(pathFor("report.docx"));
  });

  it("uses the last part of a path-like name", () => {
    expect(pathFor("C:\\files\\plan.docx")).toBe("uploads/~ana/plan.docx.md");
    expect(pathFor("../../etc/plan.docx")).toBe("uploads/~ana/plan.docx.md");
  });

  it("replaces characters a desk path refuses", () => {
    expect(pathFor('a:b?c*d"e|f<g>.pdf')).toBe("uploads/~ana/a_b_c_d_e_f_g_.pdf.md");
  });

  it("replaces control and direction-override characters", () => {
    expect(pathFor("a\u0000b\u202ec.pdf")).toBe("uploads/~ana/a_b_c.pdf.md");
  });

  it("does not make a hidden file or end in a dot or a space", () => {
    expect(pathFor(".env.pdf")).toBe("uploads/~ana/_env.pdf.md");
    expect(pathFor("report.pdf. ")).toBe("uploads/~ana/report.pdf.md");
  });

  it("falls back for a blank or all-dots name", () => {
    expect(pathFor("")).toBe("uploads/~ana/document.md");
    expect(pathFor("   ")).toBe("uploads/~ana/document.md");
    expect(pathFor("...")).toBe("uploads/~ana/document.md");
  });

  it("shortens a very long name but keeps its extension", () => {
    const path = pathFor(`${"a".repeat(400)}.pdf`);
    expect(path.endsWith(".pdf.md")).toBe(true);
    expect(path.length).toBeLessThanOrEqual(`uploads/~ana/${"x".repeat(120)}`.length);
  });

  it("never answers a path the desk refuses", () => {
    const names = [
      "CON.pdf",
      "nul.docx",
      "lpt1",
      "AUX",
      "com9.xlsx",
      "a/b/c.pdf",
      "   .pdf",
      "x".repeat(500),
      "\u202e\u0000",
      "emoji \u{1f600}.pdf",
    ];
    for (const name of names) {
      const parsed = parseDeskPath(pathFor(name));
      expect(isFileRefusal(parsed), name).toBe(false);
    }
  });

  it("prefixes a reserved device name instead of refusing it", () => {
    expect(pathFor("CON.pdf")).toBe("uploads/~ana/doc-CON.pdf.md");
  });
});
