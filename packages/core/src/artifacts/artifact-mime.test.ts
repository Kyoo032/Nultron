import { describe, expect, it } from "vitest";
import {
  ARTIFACT_MIMES,
  DOCX_MIME,
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
