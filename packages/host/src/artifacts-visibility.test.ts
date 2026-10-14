/**
 * Who sees an artifact (SR-175, Rizky 2026-10-14): on the hosted app a file a person makes on their
 * own is visible only to them; a file put into a collective project is visible to the company; a
 * legacy row with no owner stays company-visible, as it was made. Personal has one person per desk
 * and must behave exactly as before.
 *
 * This is the store, on an in-memory database. The same rules through the real router, with real
 * sessions and two companies, are in `artifacts-companies.test.ts`.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrappingKeyFromSecret, type TenantContext } from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { SHARED_ARTIFACT_SQL, createArtifactStore, isSharedForViewer, type ArtifactStore } from "./artifacts";

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

  it("stamps the maker as owner on save", () => {
    const made = store.create(ann, INPUT);
    const row = db.prepare("SELECT owner_user_id, project_id FROM artifacts WHERE id = ?").get(made.id);
    expect(row).toEqual({ owner_user_id: "ann", project_id: null });
  });

  it("shows a person's own file to that person only", () => {
    const made = store.create(ann, INPUT);
    expect(store.list(ann).map((item) => item.id)).toEqual([made.id]);
    expect(store.get(ann, made.id)?.body).toBe("# Plan\n\nbody");
    expect(store.list(bob)).toEqual([]);
    expect(store.get(bob, made.id)).toBeNull();
  });

  it("keeps a file in a project private to its maker until F1 makes projects shareable (K-D19)", () => {
    const made = store.create(ann, INPUT);
    db.prepare("UPDATE artifacts SET project_id = 'proj-1' WHERE id = ?").run(made.id);
    expect(store.list(bob)).toEqual([]);
    expect(store.get(bob, made.id)).toBeNull();
    expect(store.get(ann, made.id)).not.toBeNull();
  });

  it("grants nothing from a project id that no project row backs, in SQL or in the JavaScript twin", () => {
    const row = { project_id: "proj-1", workspace_id: "desk-a" };
    expect(isSharedForViewer(row, bob)).toBe(false);
    expect(isSharedForViewer({ project_id: null, workspace_id: "desk-a" }, bob)).toBe(false);
    expect(SHARED_ARTIFACT_SQL).toContain("FROM projects p");
    expect(SHARED_ARTIFACT_SQL).toContain("p.visibility = 'workspace'");
  });

  it("keeps a legacy row with no owner visible to the company", () => {
    db.prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES ('legacy', 'desk-a', 'documents', 'draft', 'Old', 'text/markdown', 'x', '{}', 1, 1, 1)`,
    ).run();
    expect(store.list(bob).map((item) => item.id)).toEqual(["legacy"]);
    expect(store.get(bob, "legacy")).not.toBeNull();
  });

  it("keeps the desk boundary: another desk never sees it, even in a project", () => {
    const made = store.create(ann, INPUT);
    db.prepare("UPDATE artifacts SET project_id = 'proj-1' WHERE id = ?").run(made.id);
    expect(store.list(carol)).toEqual([]);
    expect(store.get(carol, made.id)).toBeNull();
  });

  it("lets only the owner delete a private file", () => {
    const made = store.create(ann, INPUT);
    expect(store.remove(bob, made.id)).toBe(false);
    expect(store.get(ann, made.id)).not.toBeNull();
    expect(store.remove(ann, made.id)).toBe(true);
  });

  it("answers a teammate's delete of a project file that is still private as not found", () => {
    const made = store.create(ann, INPUT);
    db.prepare("UPDATE artifacts SET project_id = 'proj-1' WHERE id = ?").run(made.id);
    expect(store.remove(bob, made.id)).toBe(false);
    expect(store.get(ann, made.id)).not.toBeNull();
    expect(store.remove(ann, made.id)).toBe(true);
  });

  it("a legacy row with no owner is deleted by a company owner or admin, never by a member (SR-176)", () => {
    db.prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES ('legacy', 'desk-a', 'documents', 'draft', 'Old', 'text/markdown', 'x', '{}', 1, 1, 1)`,
    ).run();
    // The row stays company-visible, as it was made, but a member's delete is the answer for a missing id.
    expect(store.remove(bob, "legacy")).toBe(false);
    expect(store.get(bob, "legacy")).not.toBeNull();
    expect(store.remove({ ...bob, role: "admin" }, "legacy")).toBe(true);
    expect(store.get(bob, "legacy")).toBeNull();
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

  it("writes no owner, and every desk member reads and deletes as before", () => {
    const made = store.create(ann, INPUT);
    const row = db.prepare("SELECT owner_user_id FROM artifacts WHERE id = ?").get(made.id) as {
      owner_user_id: string | null;
    };
    expect(row.owner_user_id).toBeNull();
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
