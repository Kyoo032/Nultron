import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, purgeTenantRows, sql } from "@agentforge/db";
import { sqliteFilePath } from "@agentforge/db/vault-key";
import type { TenantContext } from "@agentforge/core";
import { artifactStore } from "../artifacts";
import { replaceSection, restyle, type Section } from "../doc-model";
import { createDocumentForTenant } from "../doc-tools/create-document";
import { readEditableSpec, type EditableSpec } from "../doc-tools/doc-meta";
import { sampleDocInput } from "../doc-tools/doc-tools-fixtures";
import { addProjectMember, createProject, removeProjectMember } from "../projects/service";
import { setFileProject } from "../projects/store";
import { tenantStorageReport } from "../tenant-storage";
import "../tenant-storage-db";
import { readTenantArtifactUse } from "../tenant-storage-store";
import { getTenant } from "../tenant";
import { newSectionId } from "./section-ids";
import { createDocVersionStore, docVersionStore } from "./store";
import type { AppendVersionInput } from "./types";

process.env.AGENTFORGE_SECRETS_KEY = "9c2e4a6b8d0f1a3c5e7b9d1f3a5c7e9b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a1c";
process.env.AGENTFORGE_SERVER = "1";

const TENANT = "doc-versions-partner";

let alice: TenantContext;
let ben: TenantContext;
let cara: TenantContext;
let dina: TenantContext;
let erik: TenantContext;

async function person(orgId: string, userId: string, role: "owner" | "member"): Promise<TenantContext> {
  await ensurePortalOwner(db, { tenantId: TENANT, orgId, userId, role });
  return getTenant({ session: { id: `session-${userId}`, tenantId: TENANT, orgId, userId } });
}

async function workspaceDocument(): Promise<{ projectId: string; artifactId: string }> {
  const project = createProject(alice, { name: `Room ${Math.random()}` });
  addProjectMember(alice, project.id, "ben");
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice);
  if (!made.ok) {
    throw new Error(made.message);
  }
  setFileProject(alice, made.artifactId, project.id);
  return { projectId: project.id, artifactId: made.artifactId };
}

function section(id: string, text: string): Section {
  return { id, heading: id, blocks: [{ type: "paragraph", text }] };
}

function rewrite(id: string, text: string, baseVersion: number): AppendVersionInput {
  return {
    baseVersion,
    author: { kind: "person" },
    edit: (head) => {
      if (head.kind !== "document") {
        throw new Error("a document");
      }
      return { kind: "document", spec: replaceSection(head.spec, id, section(id, text)) };
    },
  };
}

function textOf(spec: EditableSpec | undefined, id: string): string | undefined {
  if (spec?.kind !== "document") {
    return undefined;
  }
  const block = spec.spec.sections.find((part) => part.id === id)?.blocks[0];
  return block?.type === "paragraph" ? block.text : undefined;
}

function versionCount(artifactId: string): number {
  return (sql.prepare("SELECT COUNT(*) AS n FROM doc_versions WHERE artifact_id = ?").get(artifactId) as { n: number })
    .n;
}

beforeAll(async () => {
  alice = await person("org-1", "alice", "owner");
  ben = await person("org-1", "ben", "member");
  cara = await person("org-1", "cara", "member");
  dina = await person("org-1", "dina", "member");
  erik = await person("org-2", "erik", "owner");
});

afterAll(() => {
  delete process.env.AGENTFORGE_SERVER;
  sql.close();
});

describe("version 1 is made from the saved spec", () => {
  it("records every section, the maker as author, and opens to the saved spec", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    expect(store.ensureFirstVersion(ben, artifactId)).toMatchObject({
      ok: true,
      head: {
        version: 1,
        kind: "document",
        changedSectionIds: ["intro", "numbers", "close"],
        baseVersion: null,
        note: null,
        author: { kind: "person", userId: "alice" },
      },
    });
    const saved = readEditableSpec(
      artifactStore().get(alice, artifactId) as NonNullable<ReturnType<ReturnType<typeof artifactStore>["get"]>>,
    );
    expect(store.getVersion(alice, artifactId, 1)?.spec).toEqual(saved);
    expect(store.ensureFirstVersion(alice, artifactId)).toMatchObject({ ok: true, head: { version: 1 } });
    expect(versionCount(artifactId)).toBe(1);
  });

  it("two calls on two connections make exactly one version 1", async () => {
    const { artifactId } = await workspaceDocument();
    const second = new Database(sqliteFilePath());
    second.pragma("foreign_keys = ON");
    second.pragma("busy_timeout = 5000");
    try {
      const one = createDocVersionStore({ db: sql });
      const two = createDocVersionStore({ db: second });
      const results = await Promise.all([
        Promise.resolve().then(() => one.ensureFirstVersion(alice, artifactId)),
        Promise.resolve().then(() => two.ensureFirstVersion(ben, artifactId)),
      ]);
      expect(results.map((result) => (result.ok ? result.head.version : null))).toEqual([1, 1]);
      expect(results.map((result) => (result.ok ? result.head.author : null))).toEqual([
        { kind: "person", userId: "alice" },
        { kind: "person", userId: "alice" },
      ]);
      expect(versionCount(artifactId)).toBe(1);
      expect(() =>
        second
          .prepare(
            "INSERT INTO doc_versions (id, workspace_id, artifact_id, version, spec, kind, changed_section_ids, author_kind, author_user_id, asked_by_user_id, created_at) VALUES ('dup', ?, ?, 1, '{}', 'document', '[]', 'person', 'ben', 'ben', 1)",
          )
          .run(alice.workspaceId, artifactId),
      ).toThrow(/UNIQUE/);
    } finally {
      second.close();
    }
  });

  it("answers null for a saved file with no editable spec", () => {
    const plain = artifactStore().create(alice, {
      mode: "documents",
      kind: "draft",
      title: "notes",
      mime: "text/markdown",
      body: "# Notes",
    });
    expect(docVersionStore().ensureFirstVersion(alice, plain.id)).toEqual({ ok: false, reason: "not_editable" });
    expect(docVersionStore().appendVersion(alice, plain.id, rewrite("intro", "x", 1))).toEqual({
      ok: false,
      reason: "not_editable",
    });
  });
});

describe("appending a version", () => {
  it("writes max + 1, moves the head, and keeps who changed what", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    const second = store.appendVersion(ben, artifactId, { ...rewrite("numbers", "Ben's numbers", 1), note: "figures" });
    expect(second).toMatchObject({
      ok: true,
      created: true,
      head: {
        version: 2,
        changedSectionIds: ["numbers"],
        baseVersion: 1,
        note: "figures",
        author: { kind: "person", userId: "ben" },
      },
    });
    const third = store.appendVersion(alice, artifactId, {
      ...rewrite("close", "The agent's close", 2),
      author: { kind: "agent", agentId: "documents" },
    });
    expect(third).toMatchObject({
      ok: true,
      head: { version: 3, author: { kind: "agent", agentId: "documents", askedByUserId: "alice" } },
    });

    const head = readEditableSpec(
      artifactStore().get(ben, artifactId) as NonNullable<ReturnType<ReturnType<typeof artifactStore>["get"]>>,
    );
    expect(textOf(head ?? undefined, "numbers")).toBe("Ben's numbers");
    expect(textOf(head ?? undefined, "close")).toBe("The agent's close");
    expect(store.getVersion(ben, artifactId, 3)?.spec).toEqual(head);
    expect(textOf(store.getVersion(ben, artifactId, 1)?.spec, "numbers")).toBeUndefined();

    expect(store.sectionAuthors(ben, artifactId)).toEqual({
      intro: { version: 1, author: { kind: "person", userId: "alice" } },
      numbers: { version: 2, author: { kind: "person", userId: "ben" } },
      close: { version: 3, author: { kind: "agent", agentId: "documents", askedByUserId: "alice" } },
    });
    expect(store.listVersions(ben, artifactId)?.map((version) => version.version)).toEqual([3, 2, 1]);
  });

  it("refuses a section changed since the base, and merges an edit to another section onto the head", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    store.ensureFirstVersion(alice, artifactId);
    expect(store.appendVersion(ben, artifactId, rewrite("numbers", "Ben", 1))).toMatchObject({ ok: true });
    expect(store.appendVersion(alice, artifactId, rewrite("numbers", "Alice", 1))).toEqual({
      ok: false,
      reason: "section_changed",
      sectionIds: ["numbers"],
    });
    expect(store.appendVersion(alice, artifactId, rewrite("intro", "Alice's intro", 1))).toMatchObject({
      ok: true,
      head: { version: 3, changedSectionIds: ["intro"], baseVersion: 1 },
    });
    const head = store.getVersion(alice, artifactId, 3)?.spec;
    expect(textOf(head, "numbers")).toBe("Ben");
    expect(textOf(head, "intro")).toBe("Alice's intro");
  });

  it("adds a section with a host id, restyles without changing a section, and writes nothing for a no-op", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    let added = "";
    const grown = store.appendVersion(alice, artifactId, {
      baseVersion: 1,
      author: { kind: "person" },
      edit: (head) => {
        if (head.kind !== "document") {
          throw new Error("a document");
        }
        added = newSectionId(head);
        return { kind: "document", spec: { ...head.spec, sections: [...head.spec.sections, section(added, "New")] } };
      },
    });
    expect(grown).toMatchObject({ ok: true, head: { version: 2, changedSectionIds: [added] } });
    const styled = store.appendVersion(alice, artifactId, {
      baseVersion: 2,
      author: { kind: "person" },
      edit: (head) => (head.kind === "document" ? { kind: "document", spec: restyle(head.spec, "modern") } : head),
    });
    expect(styled).toMatchObject({ ok: true, head: { version: 3, changedSectionIds: [] } });
    expect(
      store.appendVersion(alice, artifactId, { baseVersion: 3, author: { kind: "person" }, edit: (head) => head }),
    ).toMatchObject({
      ok: true,
      created: false,
      head: { version: 3 },
    });
    expect(store.sectionAuthors(alice, artifactId)?.[added]).toEqual({
      version: 2,
      author: { kind: "person", userId: "alice" },
    });
  });

  it("refuses a base outside the history and a change of kind", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    expect(store.appendVersion(alice, artifactId, rewrite("intro", "x", 0))).toEqual({ ok: false, reason: "bad_base" });
    expect(store.appendVersion(alice, artifactId, rewrite("intro", "x", 9))).toEqual({ ok: false, reason: "bad_base" });
    expect(
      store.appendVersion(alice, artifactId, {
        baseVersion: 1,
        author: { kind: "person" },
        edit: () => ({
          kind: "workbook",
          spec: { kind: "workbook", title: "B", theme: "plain", sheets: [] },
        }),
      }),
    ).toEqual({ ok: false, reason: "kind_changed" });
  });
});

describe("the cap runs on append, and spares a protected base", () => {
  it("keeps the newest two and the protected version, and the authors survive the fold", async () => {
    const { artifactId } = await workspaceDocument();
    let clock = Date.UTC(2026, 0, 1);
    const store = createDocVersionStore({
      db: sql,
      now: () => clock,
      cap: { keepNewest: 2, keepDays: 30 },
      protectedVersions: () => new Set([2]),
    });
    store.ensureFirstVersion(alice, artifactId);
    for (const [index, id] of ["intro", "numbers", "close", "intro"].entries()) {
      clock += 40 * 24 * 60 * 60 * 1000;
      expect(
        store.appendVersion(index % 2 === 0 ? ben : alice, artifactId, rewrite(id, `v${index + 2}`, index + 1)),
      ).toMatchObject({
        ok: true,
      });
    }
    expect(store.listVersions(alice, artifactId)?.map((version) => version.version)).toEqual([5, 4, 2]);
    expect(store.sectionAuthors(alice, artifactId)).toEqual({
      intro: { version: 5, author: { kind: "person", userId: "alice" } },
      numbers: { version: 3, author: { kind: "person", userId: "alice" } },
      close: { version: 4, author: { kind: "person", userId: "ben" } },
    });
    expect(store.appendVersion(ben, artifactId, rewrite("numbers", "late", 2))).toEqual({
      ok: false,
      reason: "section_changed",
      sectionIds: ["numbers"],
    });
  });
});

describe("who may read the versions: the Workspace member rule", () => {
  it("a member reads them; a non-member, another company and a removed member get nothing", async () => {
    const { projectId, artifactId } = await workspaceDocument();
    addProjectMember(alice, projectId, "dina");
    const store = docVersionStore();
    expect(store.ensureFirstVersion(dina, artifactId)).toMatchObject({ ok: true, head: { version: 1 } });
    expect(store.appendVersion(ben, artifactId, rewrite("intro", "Ben", 1))).toMatchObject({ ok: true });
    removeProjectMember(alice, projectId, "dina");

    expect(store.listVersions(ben, artifactId)?.map((version) => version.version)).toEqual([2, 1]);
    expect(textOf(store.getVersion(ben, artifactId, 2)?.spec, "intro")).toBe("Ben");
    for (const stranger of [cara, erik, dina]) {
      expect(store.ensureFirstVersion(stranger, artifactId), stranger.userId).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(store.listVersions(stranger, artifactId), stranger.userId).toBeNull();
      expect(store.getVersion(stranger, artifactId, 2), stranger.userId).toBeNull();
      expect(store.sectionAuthors(stranger, artifactId), stranger.userId).toBeNull();
      expect(store.appendVersion(stranger, artifactId, rewrite("intro", "no", 2)), stranger.userId).toEqual({
        ok: false,
        reason: "not_found",
      });
    }
    expect(versionCount(artifactId)).toBe(2);
  });
});

describe("versions go with their file", () => {
  it("deleting the file deletes its versions", async () => {
    const { artifactId } = await workspaceDocument();
    docVersionStore().ensureFirstVersion(alice, artifactId);
    expect(versionCount(artifactId)).toBe(1);
    expect(artifactStore().remove(alice, artifactId)).toBe(true);
    expect(versionCount(artifactId)).toBe(0);
  });

  it("erasing the company deletes them, and another company's stay", async () => {
    const { artifactId } = await workspaceDocument();
    docVersionStore().ensureFirstVersion(alice, artifactId);
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, erik);
    if (!made.ok) {
      throw new Error(made.message);
    }
    docVersionStore().ensureFirstVersion(erik, made.artifactId);
    const otherTenant = "doc-versions-other";
    await ensurePortalOwner(db, { tenantId: otherTenant, orgId: "org-x", userId: "xena", role: "owner" });
    const xena = await getTenant({
      session: { id: "session-xena", tenantId: otherTenant, orgId: "org-x", userId: "xena" },
    });
    const kept = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, xena);
    if (!kept.ok) {
      throw new Error(kept.message);
    }
    docVersionStore().ensureFirstVersion(xena, kept.artifactId);

    purgeTenantRows(sql, TENANT);
    expect(versionCount(artifactId)).toBe(0);
    expect(versionCount(made.artifactId)).toBe(0);
    expect(versionCount(kept.artifactId)).toBe(1);
  });
});

const LIMIT_ENV = "AGENTFORGE_TENANT_STORAGE_BYTES";

function withCeiling<T>(bytes: number, run: () => T): T {
  const before = process.env[LIMIT_ENV];
  process.env[LIMIT_ENV] = String(bytes);
  try {
    return run();
  } finally {
    if (before === undefined) {
      delete process.env[LIMIT_ENV];
    } else {
      process.env[LIMIT_ENV] = before;
    }
  }
}

function artifactRow(artifactId: string): unknown {
  return sql.prepare("SELECT meta, updated_at, title FROM artifacts WHERE id = ?").get(artifactId);
}

describe("the storage ceiling: version rows count, and a write over it is refused as a value", () => {
  beforeAll(async () => {
    alice = await person("org-1", "alice", "owner");
    ben = await person("org-1", "ben", "member");
  });

  it("a first version the ceiling cannot hold is refused, and nothing is written", async () => {
    const { artifactId } = await workspaceDocument();
    const used = (await tenantStorageReport(TENANT)).usedBytes;
    const before = artifactRow(artifactId);
    withCeiling(used + 1, () => {
      expect(docVersionStore().ensureFirstVersion(alice, artifactId)).toEqual({ ok: false, reason: "quota" });
      expect(docVersionStore().appendVersion(ben, artifactId, rewrite("intro", "over", 1))).toEqual({
        ok: false,
        reason: "quota",
      });
    });
    expect(versionCount(artifactId)).toBe(0);
    expect(artifactRow(artifactId)).toEqual(before);
  });

  it("over a full ceiling a no-op and the saved head still answer, and a changed append is refused", async () => {
    const { artifactId } = await workspaceDocument();
    const store = docVersionStore();
    expect(store.ensureFirstVersion(alice, artifactId)).toMatchObject({ ok: true, head: { version: 1 } });
    const used = (await tenantStorageReport(TENANT)).usedBytes;
    const before = artifactRow(artifactId);
    withCeiling(used, () => {
      expect(store.ensureFirstVersion(alice, artifactId)).toMatchObject({ ok: true, head: { version: 1 } });
      expect(
        store.appendVersion(ben, artifactId, { baseVersion: 1, author: { kind: "person" }, edit: (head) => head }),
      ).toMatchObject({ ok: true, created: false, head: { version: 1 } });
      expect(store.appendVersion(ben, artifactId, rewrite("intro", "over", 1))).toEqual({
        ok: false,
        reason: "quota",
      });
    });
    expect(versionCount(artifactId)).toBe(1);
    expect(artifactRow(artifactId)).toEqual(before);
  });

  it("inside the caller's own transaction a refusal rolls back only the store's writes", async () => {
    const { artifactId } = await workspaceDocument();
    const used = (await tenantStorageReport(TENANT)).usedBytes;
    const result = withCeiling(used + 1, () =>
      sql
        .transaction(() => {
          const refused = docVersionStore().appendVersion(alice, artifactId, rewrite("intro", "nested", 1));
          sql.prepare("UPDATE artifacts SET title = ? WHERE id = ?").run("caller kept", artifactId);
          return refused;
        })
        .immediate(),
    );
    expect(result).toEqual({ ok: false, reason: "quota" });
    expect(versionCount(artifactId)).toBe(0);
    expect(sql.prepare("SELECT title FROM artifacts WHERE id = ?").get(artifactId)).toEqual({ title: "caller kept" });
  });

  it("the storage use counts the bytes of every version row the store writes", async () => {
    const { artifactId } = await workspaceDocument();
    const before = readTenantArtifactUse(TENANT).bytes;
    const store = docVersionStore();
    expect(store.ensureFirstVersion(alice, artifactId)).toMatchObject({ ok: true });
    expect(store.appendVersion(ben, artifactId, rewrite("numbers", "Ben's numbers", 1))).toMatchObject({
      ok: true,
      created: true,
    });
    const stored = sql.prepare("SELECT spec FROM doc_versions WHERE artifact_id = ?").all(artifactId) as Array<{
      spec: string;
    }>;
    const expected = stored.reduce((sum, row) => sum + Buffer.byteLength(row.spec, "utf8"), 0);
    expect(stored).toHaveLength(2);
    expect(expected).toBeGreaterThan(0);
    expect(readTenantArtifactUse(TENANT).bytes - before).toBe(expected);
  });
});
