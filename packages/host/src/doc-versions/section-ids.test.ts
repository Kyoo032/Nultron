import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { artifactStore } from "../artifacts";
import { docSpecFromMarkdown, parseDocSpec, replaceSection, restyle } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { readEditableSpec, type EditableSpec } from "../doc-tools/doc-meta";
import { sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import { reviseDocumentForTenant } from "../doc-tools/revise-document";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
import { changedSectionIds, newSectionId, sectionIdsOf } from "./section-ids";

process.env.AGENTFORGE_SECRETS_KEY = "6b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d";
delete process.env.AGENTFORGE_SERVER;

const SAMPLE_IDS = ["intro", "numbers", "close"];

let tenant: TenantContext;

beforeAll(async () => {
  tenant = await getTenant();
});

afterAll(() => {
  sql.close();
});

function sample(): EditableSpec {
  return { kind: "document", spec: parseDocSpec({ kind: "document", ...sampleDocInput() }) };
}

function savedSpec(artifactId: string): EditableSpec | null {
  const record = artifactStore().get(tenant, artifactId);
  return record === null ? null : readEditableSpec(record);
}

async function savedDocument(): Promise<string> {
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, tenant);
  if (!made.ok) {
    throw new Error(made.message);
  }
  return made.artifactId;
}

describe("a new section id comes from the host", () => {
  it("is unique within the document, and a section with it parses", () => {
    const spec = sample();
    const ids = new Set(Array.from({ length: 300 }, () => newSectionId(spec)));
    expect(ids.size).toBe(300);
    const id = newSectionId(spec);
    expect(SAMPLE_IDS).not.toContain(id);
    expect(id).toMatch(/^s-[0-9a-f]{10}$/);
    const grown = parseDocSpec({ ...spec.spec, sections: [...spec.spec.sections, { id, blocks: [] }] });
    expect(grown.sections.map((section) => section.id)).toEqual([...SAMPLE_IDS, id]);
  });
});

describe("section ids stay stable", () => {
  it("through create: the saved spec keeps the ids it was given", async () => {
    const saved = savedSpec(await savedDocument());
    expect(saved === null ? null : sectionIdsOf(saved)).toEqual(SAMPLE_IDS);
  });

  it("through import: Markdown sections are s1 to sN", () => {
    const spec = docSpecFromMarkdown("# One\n\nFirst.\n\n# Two\n\nSecond.\n\n# Three\n\nThird.", { title: "Imported" });
    expect(spec.sections.map((section) => section.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("through replaceSection and restyle", () => {
    const spec = sample();
    if (spec.kind !== "document") {
      throw new Error("sample is a document");
    }
    const replaced = replaceSection(spec.spec, "numbers", { id: "other", heading: "New", blocks: [] });
    expect(replaced.sections.map((section) => section.id)).toEqual(SAMPLE_IDS);
    expect(restyle(replaced, "modern").sections.map((section) => section.id)).toEqual(SAMPLE_IDS);
  });

  it("through a format change: the PDF copy keeps every id", async () => {
    const revised = await reviseDocumentForTenant({ artifactId: await savedDocument(), format: "pdf" }, tenant);
    if (!revised.ok) {
      throw new Error(revised.message);
    }
    const saved = savedSpec(revised.artifactId);
    expect(saved === null ? null : sectionIdsOf(saved)).toEqual(SAMPLE_IDS);
  });
});

describe("which sections an edit changed", () => {
  it("names a replaced, an added and a removed section, and nothing for a restyle", () => {
    const before = sample();
    if (before.kind !== "document") {
      throw new Error("sample is a document");
    }
    const replaced = replaceSection(before.spec, "intro", { id: "intro", heading: "Hello", blocks: [] });
    expect(changedSectionIds(before, { kind: "document", spec: replaced })).toEqual(["intro"]);
    const added = { ...before.spec, sections: [...before.spec.sections, { id: "s-new", blocks: [] }] };
    expect(changedSectionIds(before, { kind: "document", spec: added })).toEqual(["s-new"]);
    const removed = { ...before.spec, sections: before.spec.sections.filter((section) => section.id !== "close") };
    expect(changedSectionIds(before, { kind: "document", spec: removed })).toEqual(["close"]);
    expect(changedSectionIds(before, { kind: "document", spec: restyle(before.spec, "modern") })).toEqual([]);
  });
});
