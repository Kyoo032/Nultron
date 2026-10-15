import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { requireArtifact } from "../artifacts";
import { replaceSection } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { docxBodyText, sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
import { BODY_VERSION_META_KEY, refreshHeadBody, staleHeadFile } from "./render-head";
import { docVersionStore } from "./store";

process.env.AGENTFORGE_SECRETS_KEY = "2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c";
delete process.env.AGENTFORGE_SERVER;

let owner: TenantContext;

beforeAll(async () => {
  owner = await getTenant();
});

afterAll(() => {
  sql.close();
});

describe("Personal: one person, no server mode, the same head render", () => {
  it("a body behind its head serves the head render, and a refresh marks the body with its version", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const store = docVersionStore();
    expect(store.ensureFirstVersion(owner, made.artifactId)).toMatchObject({ ok: true, head: { version: 1 } });
    expect(
      store.appendVersion(owner, made.artifactId, {
        baseVersion: 1,
        author: { kind: "person" },
        edit: (head) =>
          head.kind === "document"
            ? {
                kind: "document",
                spec: replaceSection(head.spec, "intro", {
                  id: "intro",
                  heading: "Introduction",
                  blocks: [{ type: "paragraph", text: "Personal head." }],
                }),
              }
            : head,
      }),
    ).toMatchObject({ ok: true, head: { version: 2 } });

    const rendered = await staleHeadFile(owner, requireArtifact(owner, made.artifactId));
    if (rendered === null) {
      throw new Error("expected a head render");
    }
    expect(await docxBodyText(rendered.bytes)).toContain("Personal head.");

    expect(await refreshHeadBody(owner, made.artifactId)).toEqual({ ok: true, version: 2 });
    const meta = JSON.parse(
      (sql.prepare("SELECT meta FROM artifacts WHERE id = ?").get(made.artifactId) as { meta: string }).meta,
    ) as Record<string, unknown>;
    expect(meta[BODY_VERSION_META_KEY]).toBe(2);
    expect(await staleHeadFile(owner, requireArtifact(owner, made.artifactId))).toBeNull();
  });
});
