/**
 * The default desk access of `run_code`: the real desk store and the real author (`currentAgentAuthor`),
 * so a file a run writes is attributed to the run that wrote it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import type { DeskPath } from "@agentforge/core/tools/files";
import { deskFileStore } from "../desk-files/store";
import "../tenant-storage-db";
import { resetObjectStoreForTests } from "../tenant-storage";
import { withToolRun } from "../tool-run-context";
import { setSandboxRunnerForTests } from "./run-code";
import { runCodeForTenant } from "./run-code-tool";

process.env.AGENTFORGE_SECRETS_KEY = "5b1e0c9d3a7f4286b0d1e8c35a9f27640d8e13b6c94a05f7e2d81a3c6b49f058";

let tenant: TenantContext;

beforeAll(async () => {
  const owner = await ensurePortalOwner(db, {
    tenantId: "code-tenant",
    orgId: "code-org",
    userId: "code-user",
    role: "owner",
  });
  tenant = {
    tenantId: "code-tenant",
    organizationId: "code-org",
    workspaceId: owner.workspaceId,
    userId: "code-user",
    role: "owner",
  };
});

afterEach(() => {
  setSandboxRunnerForTests(null);
  resetObjectStoreForTests();
});

describe("run_code on the real desk store", () => {
  it("saves a run's file as an agent version carrying the run id and mode", async () => {
    setSandboxRunnerForTests({
      run: async () => ({ ok: true, stdout: "", stderr: "", outputs: [{ path: "out/answer.txt", text: "42" }] }),
      shutdown: () => undefined,
    });
    const result = await withToolRun({ runId: "run-code-1", mode: "data" }, () =>
      runCodeForTenant({ language: "python", code: "print(42)" }, tenant),
    );
    expect(result.filesWritten).toEqual([{ path: "out/answer.txt", version: 1 }]);
    const versions = await deskFileStore().listVersions(tenant, "out/answer.txt" as DeskPath);
    expect(versions[0]).toMatchObject({ authorKind: "agent", authorId: "run-code-1", mode: "data" });
  });
});
