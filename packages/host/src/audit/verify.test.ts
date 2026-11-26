import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { appendAuditEvent } from "./store";
import { purgeAuditEvents } from "./purge";
import { verifyAuditChain } from "./verify";

const EVENT = {
  tenantId: "t1",
  event: "tool.call" as const,
  actorKind: "user" as const,
  outcome: "ok" as const,
};

describe("audit verify (AC-2.4, AC-2.8)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("reports ok on an empty desk and on a chain of valid rows", () => {
    expect(verifyAuditChain(db).ok).toBe(true);
    appendAuditEvent(db, EVENT);
    appendAuditEvent(db, EVENT);
    appendAuditEvent(db, EVENT);
    const result = verifyAuditChain(db);
    expect(result).toEqual({ ok: true, checked: 3 });
  });

  it("names the first row whose stored hash no longer matches", () => {
    appendAuditEvent(db, EVENT);
    appendAuditEvent(db, EVENT);
    // Tampering needs the trigger out of the way first — a fact worth the test doing on purpose:
    // an attacker who can drop the trigger still cannot hide, because the re-walked hash disagrees.
    db.exec("DROP TRIGGER audit_events_no_update");
    db.prepare("UPDATE audit_events SET event = 'auth.sign_in' WHERE seq = 1").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(1);
  });

  it("still verifies the surviving tail after a checkpointed purge", () => {
    for (let index = 0; index < 5; index += 1) {
      appendAuditEvent(db, EVENT);
    }
    expect(purgeAuditEvents(db, 3)).toEqual({ purged: 3 });
    const result = verifyAuditChain(db);
    expect(result).toEqual({ ok: true, checked: 2 });
    // A tail that was re-pointed after the purge still fails loudly.
    db.exec("DROP TRIGGER audit_events_no_update");
    db.prepare("UPDATE audit_events SET prev_hash = '0' WHERE seq = 4").run();
    expect(verifyAuditChain(db).firstBadSeq).toBe(4);
  });
});
