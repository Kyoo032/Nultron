import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditEventInput } from "@agentforge/core";
import { COLUMNS_FOR_TEST } from "./store";

/**
 * AC-2.7 — "metadata only" is a property of the schema, not of the emitters' good intentions:
 * the table has no column that could hold a byte of content, and the strict input schema drops
 * anything one tries to slip in under another name.
 */
describe("audit content prohibition", () => {
  it("the table's columns carry identifiers, counts, decisions and hashes only", () => {
    for (const column of COLUMNS_FOR_TEST) {
      expect(column).not.toMatch(/content|body|text|message|prompt|payload|value|secret/i);
    }
  });

  it("the migration's CREATE TABLE names the same columns — no column slipped in unlisted", () => {
    const sql = readFileSync(new URL("../../../db/drizzle/0026_audit_events.sql", import.meta.url), "utf8");
    for (const column of COLUMNS_FOR_TEST) {
      expect(sql).toContain(column);
    }
    expect(sql).not.toMatch(/content|body|message|prompt|payload/i);
  });

  it("the input schema refuses a content-shaped extra key on every event name", () => {
    const base = { tenantId: "t1", event: "tool.call" as const, actorKind: "user" as const };
    for (const key of ["content", "body", "text", "message", "prompt", "value", "sql"]) {
      expect(auditEventInput.safeParse({ ...base, [key]: "anything" }).success).toBe(false);
    }
  });
});
