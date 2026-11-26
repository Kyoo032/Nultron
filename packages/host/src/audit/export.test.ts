import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { appendAuditEvent } from "./store";
import { exportAuditEvents } from "./export";

const EVENT = {
  tenantId: "t1",
  event: "tool.call" as const,
  actorKind: "user" as const,
  actorId: "u1",
  targetKind: "tool",
  targetId: "web_search",
  outcome: "ok" as const,
};

describe("audit export (AC-2.5)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureSchema(db);
    appendAuditEvent(db, { ...EVENT, at: 1_000 });
    appendAuditEvent(db, { ...EVENT, event: "auth.sign_in", actorId: 'a, "b"', at: 2_000 });
  });

  afterEach(() => {
    db.close();
  });

  it("emits JSONL with a manifest whose SHA-256 is of exactly the file's bytes", () => {
    const exported = exportAuditEvents(db, { tenantId: "t1" }, "jsonl");
    const lines = exported.content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("auth.sign_in");
    expect(exported.manifest.rows).toBe(2);
    expect(exported.manifest.fileSha256).toBe(createHash("sha256").update(exported.content, "utf8").digest("hex"));
  });

  it("emits CSV with a header row and quoted cells, and honours the filters", () => {
    const exported = exportAuditEvents(db, { tenantId: "t1" }, "csv");
    const lines = exported.content.trim().split("\n");
    expect(lines[0]).toMatch(/^seq,id,tenant_id,at,/);
    expect(lines).toHaveLength(3);
    expect(exported.content).toContain('"a, ""b"""');
    expect(exported.manifest.fileSha256).toBe(createHash("sha256").update(exported.content, "utf8").digest("hex"));

    const filtered = exportAuditEvents(db, { tenantId: "t1", event: "auth.sign_in" }, "jsonl");
    expect(filtered.manifest.rows).toBe(1);
  });
});
