import { describe, expect, it } from "vitest";
import {
  ARTIFACT_MIMES,
  DOCX_MIME,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
  artifactExtension,
  artifactFilename,
  isArtifactMime,
  isBinaryArtifactMime,
} from "./artifact-meta";

describe("the PowerPoint artifact type", () => {
  it("is the Office Open XML presentation type, and a catalog member", () => {
    expect(PPTX_MIME).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(isArtifactMime(PPTX_MIME)).toBe(true);
    expect(ARTIFACT_MIMES).toContain(PPTX_MIME);
  });

  it("is stored as base64, like the other Office files", () => {
    expect(isBinaryArtifactMime(PPTX_MIME)).toBe(true);
    expect(isBinaryArtifactMime(DOCX_MIME)).toBe(true);
    expect(isBinaryArtifactMime(XLSX_MIME)).toBe(true);
    expect(isBinaryArtifactMime("text/markdown")).toBe(false);
    expect(isBinaryArtifactMime("application/json")).toBe(false);
  });

  it("gets a .pptx file name", () => {
    expect(artifactExtension(PPTX_MIME)).toBe("pptx");
    expect(artifactFilename("Q3 plan: growth & risk", PPTX_MIME)).toBe("q3-plan-growth-risk.pptx");
  });
});

describe("the PDF artifact type", () => {
  it("is application/pdf, and a catalog member stored as base64", () => {
    expect(PDF_MIME).toBe("application/pdf");
    expect(isArtifactMime(PDF_MIME)).toBe(true);
    expect(isBinaryArtifactMime(PDF_MIME)).toBe(true);
  });

  it("gets a .pdf file name", () => {
    expect(artifactExtension(PDF_MIME)).toBe("pdf");
    expect(artifactFilename("Q3 plan", PDF_MIME)).toBe("q3-plan.pdf");
  });
});
