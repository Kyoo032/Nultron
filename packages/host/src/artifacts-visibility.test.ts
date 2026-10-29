import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrappingKeyFromSecret, type TenantContext } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { createArtifactStore, type ArtifactStore } from "./artifacts";

const KEY = wrappingKeyFromSecret("c".repeat(64));

function person(userId: string, workspaceId = "desk-a"): TenantContext {
  return { tenantId: "partner", organizationId: "org-a", workspaceId, userId, role: "member" };
}

const ann = person("ann");
const bob = person("bob");
const carol = person("carol", "desk-b");

const INPUT = {
  mode: "documents" as const,
  kind: "draft" as const,
  title: "Plan",
  mime: "text/markdown" as const,
  body: "# Plan\n\nbody",
};

describe("artifact visibility on the hosted app", () => {
  let db: Database.Database;
  let store: ArtifactStore;
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_SERVER = "1";
    db = new Database(":memory:");
    ensureSchema(db);
    store = createArtifactStore(db, () => KEY);
  });

  afterEach(() => {
    db.close();
    if (savedMode === undefined) {
      delete process.env.AGENTFORGE_SERVER;
    } else {
      process.env.AGENTFORGE_SERVER = savedMode;
    }
  });

  it("lets the maker list and read back her own file", () => {
    const made = store.create(ann, INPUT);
    expect(store.list(ann).map((item) => item.id)).toEqual([made.id]);
    expect(store.get(ann, made.id)?.body).toBe("# Plan\n\nbody");
  });

  it("keeps a legacy row with no owner visible to the company", () => {
    db.prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES ('legacy', 'desk-a', 'documents', 'draft', 'Old', 'text/markdown', 'x', '{}', 1, 1, 1)`,
    ).run();
    expect(store.list(bob).map((item) => item.id)).toEqual(["legacy"]);
    expect(store.get(bob, "legacy")).not.toBeNull();
  });

  it("keeps the desk boundary: another desk never sees a file", () => {
    const made = store.create(ann, INPUT);
    expect(store.get(ann, made.id)).not.toBeNull();
    expect(store.list(carol)).toEqual([]);
    expect(store.get(carol, made.id)).toBeNull();
  });

  it("lets the maker delete her own file", () => {
    const made = store.create(ann, INPUT);
    expect(store.get(ann, made.id)).not.toBeNull();
    expect(store.remove(ann, made.id)).toBe(true);
  });
});

describe("artifact visibility on Personal (no server mode)", () => {
  let db: Database.Database;
  let store: ArtifactStore;
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    db = new Database(":memory:");
    ensureSchema(db);
    store = createArtifactStore(db, () => KEY);
  });

  afterEach(() => {
    db.close();
    if (savedMode !== undefined) {
      process.env.AGENTFORGE_SERVER = savedMode;
    }
  });

  it("every desk member reads and deletes as before", () => {
    const made = store.create(ann, INPUT);
    expect(store.list(ann).map((item) => item.id)).toEqual([made.id]);
    expect(store.list(bob).map((item) => item.id)).toEqual([made.id]);
    expect(store.get(bob, made.id)?.body).toBe("# Plan\n\nbody");
    expect(store.remove(bob, made.id)).toBe(true);
  });

  it("still keeps one desk from another", () => {
    store.create(ann, INPUT);
    expect(store.list(carol)).toEqual([]);
  });
});
