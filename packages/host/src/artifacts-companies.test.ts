import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-artifacts-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostBytesResult, HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "artifacts-partner";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let bob: Person;

async function provision(orgId: string, userId: string): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role: "owner" });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function request(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...over,
  };
}

function call(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): Promise<HostResult> {
  return dispatch(request(person, method, path, over), { serverMode: true, sessionStore });
}

async function outcome(result: HostResult): Promise<{ status: number; code?: string }> {
  if (result.type === "json") {
    const body = (result as HostJsonResult).body as { error?: { code?: string } };
    return { status: result.status, code: body.error?.code };
  }
  return { status: result.status };
}

function artifactIds(result: HostResult): string[] {
  expect(result.type).toBe("json");
  const body = (result as HostJsonResult).body as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

async function makeArtifact(person: Person, title: string): Promise<string> {
  const { artifactStore } = await import("./artifacts");
  const record = artifactStore().create(person.tenant, {
    mode: "documents",
    kind: "draft",
    title,
    mime: "text/markdown",
    body: `# ${title}\n\nbody`,
    meta: {},
  });
  return record.id;
}

const PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

async function makeMedia(person: Person): Promise<string> {
  const { saveMedia } = await import("./media");
  const saved = await saveMedia(person.tenant, new File([PNG], "pixel.png", { type: "image/png" }));
  return saved.id;
}

describe("generated files on the hosted app: two companies, real sessions", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice");
    bob = await provision("org-b", "bob");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a person's artifact is listed for its maker and not for another company", async () => {
    const id = await makeArtifact(alice, "Alice plan");

    expect(artifactIds(await call(alice, "GET", "/api/v1/artifacts"))).toContain(id);
    expect(artifactIds(await call(bob, "GET", "/api/v1/artifacts"))).not.toContain(id);

    const own = await call(alice, "GET", `/api/v1/artifacts/${id}`, { params: { artifactId: id } });
    expect(own.type).toBe("json");
    expect(own.status).toBe(200);
  });

  it("another company neither lists nor reads a person's artifact file, and the maker reads its bytes", async () => {
    const id = await makeArtifact(alice, "Alice brief");

    expect(artifactIds(await call(bob, "GET", "/api/v1/artifacts"))).not.toContain(id);
    expect(
      await outcome(await call(bob, "GET", `/api/v1/artifacts/${id}/file`, { params: { artifactId: id } })),
    ).toEqual({ status: 404, code: "not_found" });
    const own = await call(alice, "GET", `/api/v1/artifacts/${id}/file`, { params: { artifactId: id } });
    expect(own.type).toBe("bytes");
    expect(new TextDecoder().decode((own as HostBytesResult).bytes)).toContain("Alice brief");
  });

  it("another company's media id is a 404", async () => {
    const id = await makeMedia(alice);
    const other = await call(bob, "GET", `/api/v1/media/${id}/file`, {
      params: { mediaId: id },
    });
    expect(await outcome(other)).toEqual({ status: 404, code: "not_found" });
  });
});
