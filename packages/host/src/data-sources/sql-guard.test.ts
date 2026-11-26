import { describe, expect, it } from "vitest";
import { ApiError } from "@agentforge/core";
import { assertReadOnlySelect, dataSourceLimits } from "./sql-guard";

describe("assertReadOnlySelect", () => {
  it("passes a single SELECT through unchanged", () => {
    expect(assertReadOnlySelect(" SELECT id, total FROM orders WHERE total > 10 ")).toBe(
      "SELECT id, total FROM orders WHERE total > 10",
    );
    expect(assertReadOnlySelect("WITH a AS (SELECT 1 AS x) SELECT * FROM a")).toContain("WITH");
  });

  it("refuses writes, DDL, copy and call shapes even inside a write-capable session", () => {
    const bad = [
      "INSERT INTO orders VALUES (1)",
      "UPDATE orders SET total = 0",
      "DELETE FROM orders",
      "DROP TABLE orders",
      "COPY orders TO '/tmp/x'",
      "CALL do_thing()",
      "SELECT set_config('x','y',false)",
      "BEGIN; SELECT 1",
      "PREPARE q AS SELECT 1",
      "SELECT * INTO newt FROM orders", // SELECT INTO creates a table in Postgres
      "SELECT * FROM orders FOR UPDATE", // takes row locks
      "EXPLAIN ANALYZE SELECT 1",
      "GRANT SELECT ON orders TO public",
      "COMMENT ON TABLE orders IS 'x'",
    ];
    for (const sql of bad) {
      expect(() => assertReadOnlySelect(sql), sql).toThrow(ApiError);
    }
  });

  it("refuses every statement-splitting and hiding trick", () => {
    const tricks = [
      "SELECT 1; DROP TABLE orders",
      "SELECT 1 -- harmless\nDROP TABLE orders",
      "SELECT 1 /* hide */ ; SELECT 2",
      "WITH x AS (DELETE FROM orders RETURNING 1) SELECT * FROM x",
      "SELECT $$ DO $$",
      "",
      "   ",
    ];
    for (const sql of tricks) {
      expect(() => assertReadOnlySelect(sql), sql).toThrow(ApiError);
    }
  });

  it("keeps semicolons and dashes inside string literals safe", () => {
    expect(assertReadOnlySelect("SELECT * FROM t WHERE note = 'a;b'")).toContain("'a;b'");
    expect(assertReadOnlySelect("SELECT * FROM t WHERE note = 'x''s -- not a comment'")).toContain("not a comment");
  });
});

describe("dataSourceLimits", () => {
  it("defaults to the W1 caps and only accepts positive env overrides", () => {
    const fresh = { ...process.env };
    expect(dataSourceLimits(fresh).sqlMaxRows).toBe(500);
    expect(dataSourceLimits(fresh).sqlTimeoutMs).toBe(2_000);
    expect(dataSourceLimits(fresh).syncMaxBytes).toBe(25 * 1024 * 1024);
    const custom = { ...fresh, AGENTFORGE_DATA_SQL_MAX_ROWS: "100", AGENTFORGE_DATA_SQL_TIMEOUT_MS: "nope" };
    expect(dataSourceLimits(custom).sqlMaxRows).toBe(100);
    expect(dataSourceLimits(custom).sqlTimeoutMs).toBe(2_000);
  });
});
