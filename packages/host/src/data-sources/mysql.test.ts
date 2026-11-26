/**
 * F1: the MySQL connector takes the same path Postgres does — destination allowlist +
 * resolve-and-pin, the shared `assertReadOnlySelect` guard and table allowlist, then a
 * read-only transaction with a server-side timeout and row cap. These tests pin the dispatch
 * contract (mysql routes like postgres; s3 and disabled rows refuse before any socket opens)
 * without needing a live MySQL.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-mysql-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "5b1e9d3c7a2f4086b1d9e5c3a7f20468d1b9e5c3a7f2046851d9e3c7a5b20f4c";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import type { ApiError } from "@agentforge/core";
import { getDataSource, insertDataSource, markSourceStatus } from "./store";
import { mysqlConfig } from "./mysql";
import { runSourceQuery } from "./sql-query";

const TENANT = "mysql-tenant";

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("mysql connector (F1 W1)", () => {
  beforeAll(async () => {
    await import("@agentforge/db");
  });

  it("round-trips the sealed mysql config", () => {
    const row = insertDataSource({
      tenantId: TENANT,
      kind: "mysql",
      name: "Warehouse MySQL",
      config: { host: "db.internal", port: 3306, database: "d", user: "u" },
      secret: { password: "p" },
      secretLast4: "2345",
      tableAllowlist: ["orders"],
      createdBy: null,
    });
    const config = mysqlConfig(row);
    expect(config).toMatchObject({ host: "db.internal", port: 3306, database: "d", user: "u" });
  });

  it("routes mysql through the shared query door, refusing s3 and disabled rows", async () => {
    const mysql = insertDataSource({
      tenantId: TENANT,
      kind: "mysql",
      name: "m2",
      config: { host: "db.invalid", port: 3306, database: "d", user: "u" },
      secret: { password: "p" },
      secretLast4: null,
      tableAllowlist: ["orders"],
      createdBy: null,
    });
    const s3 = insertDataSource({
      tenantId: TENANT,
      kind: "s3",
      name: "s3",
      config: { endpoint: "https://s3.example.com", region: "us-east-1", bucket: "b" },
      secret: { s3AccessKeyId: "k", s3SecretAccessKey: "s" },
      secretLast4: null,
      tableAllowlist: ["orders"],
      createdBy: null,
    });
    // s3 is not a SQL kind: refused before any socket opens.
    await expect(runSourceQuery(s3, "SELECT 1 FROM orders")).rejects.toMatchObject({
      code: "invalid_request",
    });
    // mysql reaches the connector: the failure is the destination/pin/connect step, never the
    // kind dispatch or the guard (the host name is unroutable by construction).
    const failure = (await runSourceQuery(mysql, "SELECT 1 FROM orders").catch((e: unknown) => e)) as ApiError;
    expect(["invalid_request", "sql_read_only", "table_not_allowed"]).not.toContain(failure.code);
    // A disabled mysql row refuses before reaching the driver.
    markSourceStatus(TENANT, mysql.id, "disabled");
    await expect(runSourceQuery(getDataSource(TENANT, mysql.id), "SELECT 1 FROM orders")).rejects.toMatchObject({
      code: "invalid_request",
    });
    // And the shared guard still fires for mysql: a write never reaches the socket.
    const active = insertDataSource({
      tenantId: TENANT,
      kind: "mysql",
      name: "m3",
      config: { host: "db.invalid", port: 3306, database: "d", user: "u" },
      secret: { password: "p" },
      secretLast4: null,
      tableAllowlist: ["orders"],
      createdBy: null,
    });
    await expect(runSourceQuery(active, "DELETE FROM orders")).rejects.toMatchObject({ code: "sql_read_only" });
    await expect(runSourceQuery(active, "SELECT 1 FROM salaries")).rejects.toMatchObject({
      code: "table_not_allowed",
    });
  });
});
