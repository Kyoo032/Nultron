/**
 * What a hosted tenant's saved artifacts hold, as the quota reads it.
 *
 * The number is a sum over rows, and the cost of reading it is the whole reason the query is shaped as
 * it is: a deck row carries megabytes of body with `size_bytes` after it, so reading the column from the
 * row walks the body's overflow pages. These cases pin the answer (own desks only, every desk, every
 * row) and the plan (the covering index, never the table).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, ensureSchema, sql } from "@agentforge/db";
import "./tenant-storage-db";
import { getTenant } from "./tenant";
import { readTenantArtifactUse, TENANT_ARTIFACT_USE_SQL, TENANT_VERSION_USE_SQL } from "./tenant-storage-store";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const ALPHA = { id: "use-session-a", tenantId: "use-tenant-a", orgId: "use-org-a", userId: "use-user-a" };
const BETA = { id: "use-session-b", tenantId: "use-tenant-b", orgId: "use-org-b", userId: "use-user-b" };

let alphaDesk = "";
let betaDesk = "";

function addArtifact(workspaceId: string, id: string, sizeBytes: number): void {
  sql
    .prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES (?, ?, 'presentations', 'draft', 't', 'x', 'b', '{}', ?, 1, 1)`,
    )
    .run(id, workspaceId, sizeBytes);
}

function addVersion(id: string, workspaceId: string, artifactId: string, version: number, spec: string): void {
  sql
    .prepare(
      `INSERT INTO doc_versions (id, workspace_id, artifact_id, version, spec, kind, changed_section_ids, base_version, note,
         author_kind, author_user_id, agent_id, asked_by_user_id, folded_authors, created_at)
       VALUES (?, ?, ?, ?, ?, 'document', '[]', NULL, NULL, 'person', 'use-user-a', NULL, 'use-user-a', NULL, 1)`,
    )
    .run(id, workspaceId, artifactId, version, spec);
}

beforeAll(async () => {
  // The database was opened as a desk. A hosted process opens it with the size index, so open it again
  // as one (`ensureSchema` is idempotent) before the plan is read.
  process.env.AGENTFORGE_SERVER = "1";
  try {
    ensureSchema(sql);
  } finally {
    delete process.env.AGENTFORGE_SERVER;
  }
  for (const person of [ALPHA, BETA]) {
    await ensurePortalOwner(db, {
      tenantId: person.tenantId,
      orgId: person.orgId,
      userId: person.userId,
      role: "owner",
    });
  }
  alphaDesk = (await getTenant({ session: ALPHA })).workspaceId;
  betaDesk = (await getTenant({ session: BETA })).workspaceId;
});

afterEach(() => {
  sql.prepare("DELETE FROM doc_versions").run();
  sql.prepare("DELETE FROM artifacts").run();
  sql.prepare("DELETE FROM workspaces WHERE id = 'use-second-desk'").run();
});

afterAll(() => {
  sql.close();
});

describe("readTenantArtifactUse", () => {
  it("is zero for a tenant that has saved nothing", () => {
    expect(readTenantArtifactUse(ALPHA.tenantId)).toEqual({ bytes: 0, count: 0 });
    expect(readTenantArtifactUse("no-such-tenant")).toEqual({ bytes: 0, count: 0 });
  });

  it("sums every row of the tenant's desks, and nothing of any other tenant", () => {
    sql
      .prepare(
        "INSERT INTO workspaces (id, organization_id, name, slug, created_at) VALUES ('use-second-desk', ?, 'Second', 'second', 1)",
      )
      .run(ALPHA.orgId);
    addArtifact(alphaDesk, "a-1", 300);
    addArtifact(alphaDesk, "a-2", 200);
    addArtifact("use-second-desk", "a-3", 50);
    addArtifact(betaDesk, "b-1", 4000);
    expect(readTenantArtifactUse(ALPHA.tenantId)).toEqual({ bytes: 550, count: 3 });
    expect(readTenantArtifactUse(BETA.tenantId)).toEqual({ bytes: 4000, count: 1 });
  });

  it("counts a row written before size_bytes existed (zero) as a row of no bytes", () => {
    addArtifact(alphaDesk, "old", 0);
    addArtifact(alphaDesk, "new", 10);
    expect(readTenantArtifactUse(ALPHA.tenantId)).toEqual({ bytes: 10, count: 2 });
  });

  it("is answered from the covering index alone, so a megabyte-sized row is never opened", () => {
    const plan = (sql.prepare(`EXPLAIN QUERY PLAN ${TENANT_ARTIFACT_USE_SQL}`).all("t") as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("SEARCH artifacts USING COVERING INDEX artifacts_ws_size_idx");
    // A bare `SCAN artifacts` (or a search by the mode index) would read the row, and with it the body.
    expect(plan).not.toMatch(/SCAN artifacts(?! USING COVERING)/);
    expect(plan).not.toContain("artifacts_ws_mode_idx");
  });

  it("adds the bytes of every version spec to the tenant's use, and counts a version as no artifact row", () => {
    const first = JSON.stringify({ text: "é漢😀 rapat" });
    const second = JSON.stringify({ text: "revisi" });
    expect(Buffer.byteLength(first, "utf8")).toBeGreaterThan(first.length);
    addArtifact(alphaDesk, "v-art", 300);
    addVersion("v-1", alphaDesk, "v-art", 1, first);
    addVersion("v-2", alphaDesk, "v-art", 2, second);
    expect(readTenantArtifactUse(ALPHA.tenantId)).toEqual({
      bytes: 300 + Buffer.byteLength(first, "utf8") + Buffer.byteLength(second, "utf8"),
      count: 1,
    });
  });

  it("keeps another tenant's version specs out of this tenant's use", () => {
    addArtifact(betaDesk, "v-beta", 40);
    addVersion("v-b1", betaDesk, "v-beta", 1, "x".repeat(1000));
    addArtifact(alphaDesk, "v-alpha", 5);
    addVersion("v-a1", alphaDesk, "v-alpha", 1, "y".repeat(7));
    expect(readTenantArtifactUse(ALPHA.tenantId)).toEqual({ bytes: 12, count: 1 });
    expect(readTenantArtifactUse(BETA.tenantId)).toEqual({ bytes: 1040, count: 1 });
  });

  it("reads the version specs through the document index, never a full scan of the table", () => {
    const plan = (sql.prepare(`EXPLAIN QUERY PLAN ${TENANT_VERSION_USE_SQL}`).all("t") as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("doc_versions_ws_artifact_idx");
    expect(plan).not.toMatch(/SCAN doc_versions(?! USING)/);
  });
});
