import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { AUDIT_GENESIS_HASH, appendAuditEvent, auditRowHash, listAuditEvents } from "./store";

const EVENT = {
  tenantId: "t1",
  event: "tool.call" as const,
  actorKind: "user" as const,
  actorId: "u1",
  targetKind: "tool",
  targetId: "web_search",
  outcome: "ok" as const,
  durationMs: 12,
};

describe("audit store (AC-2.1, AC-2.2)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("appends a row whose prev_hash points at the previous row, starting from the genesis", () => {
    const first = appendAuditEvent(db, EVENT);
    const second = appendAuditEvent(db, { ...EVENT, event: "auth.sign_in" });
    expect(first).toBe(1);
    expect(second).toBe(2);
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as Array<{
      prev_hash: string;
      row_hash: string;
    }>;
    expect(rows[0]!.prev_hash).toBe(AUDIT_GENESIS_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.row_hash);
    // The stored hash is the hash of the stored fields — recompute it off the row itself.
    const stored = db.prepare("SELECT * FROM audit_events WHERE seq = 1").get() as Record<string, unknown>;
    const { row_hash, ...fields } = stored;
    expect(row_hash).toBe(auditRowHash(fields as never));
  });

  it("refuses UPDATE and DELETE at the storage layer, no matter who asks", () => {
    appendAuditEvent(db, EVENT);
    expect(() => db.prepare("UPDATE audit_events SET event = 'x'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow();
  });

  it("filters by time, actor, agent, event and outcome, and pages by cursor", () => {
    appendAuditEvent(db, { ...EVENT, at: 1_000 });
    appendAuditEvent(db, { ...EVENT, event: "auth.sign_in", actorId: "u2", outcome: "denied", at: 2_000 });
    appendAuditEvent(db, { ...EVENT, event: "tool.call", agentId: "agent-7", outcome: "failed", at: 3_000 });

    expect(listAuditEvents(db, { tenantId: "t1", event: "tool.call" })).toHaveLength(2);
    expect(listAuditEvents(db, { tenantId: "t1", actor: "u2" })).toHaveLength(1);
    expect(listAuditEvents(db, { tenantId: "t1", agent: "agent-7" })).toHaveLength(1);
    expect(listAuditEvents(db, { tenantId: "t1", outcome: "denied" })).toHaveLength(1);
    expect(listAuditEvents(db, { tenantId: "t1", from: 1_500, to: 2_500 })).toHaveLength(1);
    // Newest first, and the cursor resumes where the page ended.
    const page1 = listAuditEvents(db, { tenantId: "t1", limit: 2 });
    expect(page1.map((row) => row.seq)).toEqual([3, 2]);
    const page2 = listAuditEvents(db, { tenantId: "t1", limit: 2, cursor: page1.at(-1)!.seq });
    expect(page2.map((row) => row.seq)).toEqual([1]);
    // Another tenant's rows are never listed.
    appendAuditEvent(db, { ...EVENT, tenantId: "t2" });
    expect(listAuditEvents(db, { tenantId: "t1" })).toHaveLength(3);
  });
});
