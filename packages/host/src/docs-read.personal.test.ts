import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { createDocumentForTenant } from "./doc-tools/create-document";
import { sampleDocInput } from "./doc-tools/doc-tools-fixtures";
import { getTenant } from "./tenant";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

process.env.AGENTFORGE_SECRETS_KEY = "2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c";
delete process.env.AGENTFORGE_SERVER;

let owner: TenantContext;
let dispatch: typeof import("./router").dispatch;

beforeAll(async () => {
  owner = await getTenant();
  ({ dispatch } = await import("./router"));
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(() => {
  sql.close();
});

describe("Personal: a first GET on a document writes version 1, as before", () => {
  it("GET /docs on a document nobody has opened writes version 1 and lists it", async () => {
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const artifactId = made.artifactId;
    const result = await dispatch(
      {
        method: "GET",
        path: `/api/v1/docs/${artifactId}`,
        query: {},
        params: { artifactId },
        headers: {},
      },
      { serverMode: false },
    );
    expect(result.status).toBe(200);
    expect(
      sql.prepare("SELECT version FROM doc_versions WHERE artifact_id = ? ORDER BY version").all(artifactId),
    ).toEqual([{ version: 1 }]);
  });
});
