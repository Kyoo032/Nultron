/**
 * Regression: `query_data_source` must resolve a source by its display name, not only by the
 * generated `ds-` id — the model never sees the id (Settings shows names only), so an id-only
 * tool could never be aimed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-querytool-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "5b1e9d3c7a2f4086b1d9e5c3a7f20468d1b9e5c3a7f2046851d9e3c7a5b20f4c";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import type { ApiError } from "@agentforge/core";
import { dataSourceQueryTool } from "./query-tool";
import { insertDataSource } from "./store";

const TENANT = { tenantId: "qt-tenant", workspaceId: "qt-desk" } as any;

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("query_data_source source resolution", () => {
  beforeAll(async () => {
    await import("@agentforge/db"); // opening the database ensures the schema
  });

  it("resolves a unique source name as well as its id", async () => {
    insertDataSource({
      tenantId: TENANT.tenantId,
      kind: "postgres",
      name: "Warehouse",
      config: { host: "db.invalid", port: 5432, database: "d", user: "u" },
      secret: { password: "p" },
      secretLast4: null,
      tableAllowlist: ["orders"],
      createdBy: null,
    });
    // The name lookup gets past resolution: the failure is the unreachable database, never
    // `not_found`. The id path behaves the same.
    for (const idOrName of ["Warehouse", "warehouse"]) {
      const failure = await dataSourceQueryTool
        .execute({ sourceId: idOrName, sql: "SELECT 1 FROM orders" }, TENANT)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as ApiError).code).not.toBe("not_found");
    }
    // An unknown name still answers not_found.
    await expect(
      dataSourceQueryTool.execute({ sourceId: "no-such-source", sql: "SELECT 1" }, TENANT),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
