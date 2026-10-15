import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { replaceSection } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import "../tenant-storage-db";
import { getTenant } from "../tenant";
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

describe("Personal: one person, no server mode", () => {
  it("makes version 1, appends, lists, opens and attributes like the hosted app", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const store = docVersionStore();
    expect(store.ensureFirstVersion(owner, made.artifactId)).toMatchObject({
      version: 1,
      author: { kind: "person", userId: owner.userId },
    });
    const appended = store.appendVersion(owner, made.artifactId, {
      baseVersion: 1,
      author: { kind: "person" },
      edit: (head) =>
        head.kind === "document"
          ? { kind: "document", spec: replaceSection(head.spec, "close", { id: "close", blocks: [] }) }
          : head,
    });
    expect(appended).toMatchObject({ ok: true, head: { version: 2, changedSectionIds: ["close"] } });
    expect(store.listVersions(owner, made.artifactId)?.map((version) => version.version)).toEqual([2, 1]);
    const head = store.getVersion(owner, made.artifactId, 2)?.spec;
    expect(head?.kind === "document" ? head.spec.sections.find((part) => part.id === "close")?.blocks : null).toEqual(
      [],
    );
    expect(store.sectionAuthors(owner, made.artifactId)?.close).toEqual({
      version: 2,
      author: { kind: "person", userId: owner.userId },
    });
  });
});
