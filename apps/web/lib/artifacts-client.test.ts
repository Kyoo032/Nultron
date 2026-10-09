import { describe, expect, it } from "vitest";
import { DOCX_MIME, PPTX_MIME, XLSX_MIME, type ArtifactSummary } from "@agentforge/core/artifacts";
import { textArtifacts } from "./artifacts-client";

const summary = (id: string, mime: ArtifactSummary["mime"]): ArtifactSummary => ({
  id,
  workspaceId: "w",
  mode: "presentations",
  kind: "draft",
  title: id,
  mime,
  meta: {},
  sizeBytes: 10,
  createdAt: 1,
  updatedAt: 1,
});

describe("textArtifacts", () => {
  it("keeps the artifacts a source box can hold and drops the Office files", () => {
    const items = [
      summary("notes", "text/markdown"),
      summary("data", "application/json"),
      summary("deck", PPTX_MIME),
      summary("memo", DOCX_MIME),
      summary("sheet", XLSX_MIME),
    ];
    expect(textArtifacts(items).map((item) => item.id)).toEqual(["notes", "data"]);
  });

  it("does not change the list it was given", () => {
    const items = Object.freeze([summary("deck", PPTX_MIME), summary("notes", "text/markdown")]);
    expect(textArtifacts(items)).toHaveLength(1);
    expect(items).toHaveLength(2);
  });
});
