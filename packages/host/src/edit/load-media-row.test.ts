import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-load-media-row-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Edit's output lookup", () => {
  it(
    "loads a media row for its own organization and never for another",
    async () => {
      const [{ getTenant }, { db, media }, { loadMediaRow }] = await Promise.all([
        import("../tenant"),
        import("@agentforge/db"),
        import("./wire-generate"),
      ]);
      const tenant = await getTenant({});
      const mediaId = crypto.randomUUID();
      await db.insert(media).values({
        id: mediaId,
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        kind: "image",
        mime: "image/png",
        sizeBytes: 4,
        storagePath: "media/none.png",
        url: `/api/v1/media/${mediaId}/file`,
      });

      expect(await loadMediaRow(mediaId, tenant.organizationId)).not.toBeNull();
      expect(await loadMediaRow(mediaId, `${tenant.organizationId}-other`)).toBeNull();
      expect(await loadMediaRow(crypto.randomUUID(), tenant.organizationId)).toBeNull();
    },
    ROUTER_IMPORT_BUDGET_MS,
  );
});
