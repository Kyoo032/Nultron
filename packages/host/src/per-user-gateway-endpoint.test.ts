/**
 * End-to-end verification of per-user operator-assigned API gateway endpoints on one Nultron host:
 *
 *   1. Two users signed into the same Nultron website (even under the same partner tenant) with
 *      different admin-assigned `gatewayEndpoint` values route `resolvedGatewayBaseUrl()`,
 *      `GET /api/v1/settings`, `runGatewayCheck` (`/models` live probe), and `model-cache` strictly
 *      to their own assigned endpoint without cross-contamination.
 *   2. A key valid on Endpoint A passes live check for User A, and fails `invalid_key` if checked
 *      against Endpoint B.
 *   3. When a Nultron admin reassigns User A from Endpoint A to Endpoint B and the portal delivers
 *      the new `gateway_endpoint` on refresh (`recordRotation`), User A's cached Endpoint A verdict
 *      is invalidated immediately and the next check runs against Endpoint B.
 *   4. Regular users cannot set or override `openaiBaseUrl` via `POST /api/v1/settings` — the field
 *      is ignored and reported in `ignoredFields` (strictly Nultron admin only).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tempDir = mkdtempSync(join(tmpdir(), "agentforge-per-user-gw-"));
const originalEnv = {
  AGENTFORGE_DATA_DIR: process.env.AGENTFORGE_DATA_DIR,
  AGENTFORGE_DB_PATH: process.env.AGENTFORGE_DB_PATH,
  AGENTFORGE_SERVER: process.env.AGENTFORGE_SERVER,
  AGENTFORGE_SECRETS_KEY: process.env.AGENTFORGE_SECRETS_KEY,
  AGENTFORGE_RUNTIME: process.env.AGENTFORGE_RUNTIME,
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

process.env.AGENTFORGE_DATA_DIR = tempDir;
process.env.AGENTFORGE_DB_PATH = join(tempDir, "host.db");
process.env.AGENTFORGE_SERVER = "1";
process.env.AGENTFORGE_SECRETS_KEY = "9a4c2e7b1d5f4308a6e1c9b3d7f20458e1a6c3b9d0f42715e8a3c6b1d9f04e72";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

// Load router & tenant-state-db before any test writes settings so server-mode row backend is installed.
const { db, ensurePortalOwner } = await import("@agentforge/db");
const { dispatch } = await import("./router");
const {
  createDrizzleSessionStore,
  createFakePortalClient,
  createMemoryTokenVault,
  createPortalSessionCheck,
  createSession,
  PORTAL_CHECK_INTERVAL_MS,
  sessionCookieName,
} = await import("./auth");
const { loadSettings, saveSettings } = await import("./settings-store");
const { modelCacheSlot, saveModelCache, loadModelCache } = await import("./model-cache");

type MockGateway = {
  readonly baseUrl: string;
  readonly hits: Array<{ path: string; auth: string | undefined }>;
  close(): Promise<void>;
};

async function startMockGateway(acceptedKey: string, modelId: string): Promise<MockGateway> {
  const hits: Array<{ path: string; auth: string | undefined }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization;
    hits.push({ path: req.url ?? "", auth });
    if (req.url === "/v1/models") {
      if (auth === `Bearer ${acceptedKey}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: modelId, object: "model" }] }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid key for this gateway" } }));
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let gwA: MockGateway;
let gwB: MockGateway;

beforeAll(async () => {
  gwA = await startMockGateway("sk-key-for-endpoint-a", "model-alpha");
  gwB = await startMockGateway("sk-key-for-endpoint-b", "model-beta");
});

afterAll(async () => {
  await Promise.allSettled([gwA?.close(), gwB?.close()]);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows SQLite file handles may linger until process exit.
  }
});

describe("per-user admin-assigned API gateway endpoints", () => {
  it("routes each user's settings, live gateway check, and model cache to their own assigned endpoint and enforces admin-only immutability", async () => {
    const sessionStore = createDrizzleSessionStore(db);
    const cookieName = sessionCookieName({ secure: true });

    // Provision two users on the SAME Nultron host and SAME partner tenant (two different orgs,
    // plus a second user inside Org A to prove same-company per-user endpoint isolation too).
    const tenantId = "tnt_nultron_main";
    const orgA = "org_alpha";
    const orgB = "org_beta";
    const userA = "usr_alice";
    const userB = "usr_bob";
    const userA2 = "usr_carol_same_org";

    const provA = await ensurePortalOwner(db, { tenantId, orgId: orgA, userId: userA, role: "owner" });
    const provB = await ensurePortalOwner(db, { tenantId, orgId: orgB, userId: userB, role: "owner" });
    const provA2 = await ensurePortalOwner(db, { tenantId, orgId: orgA, userId: userA2, role: "owner" });

    // Save keys for each company/workspace.
    saveSettings({ openaiApiKey: "sk-key-for-endpoint-a" }, { ...provA, workspaceId: provA.workspaceId });
    saveSettings({ openaiApiKey: "sk-key-for-endpoint-b" }, { ...provB, workspaceId: provB.workspaceId });

    // Create hosted sessions carrying each user's portal-assigned endpoint.
    const now = 1_700_000_000_000;
    const sessionA = createSession({ tenantId, orgId: orgA, userId: userA, gatewayEndpoint: gwA.baseUrl, now });
    const sessionB = createSession({ tenantId, orgId: orgB, userId: userB, gatewayEndpoint: gwB.baseUrl, now });
    // Carol is in Org A (same company as Alice, shares Org A's key `sk-key-for-endpoint-a`),
    // but Nultron admin assigned Carol to Endpoint B!
    const sessionA2 = createSession({ tenantId, orgId: orgA, userId: userA2, gatewayEndpoint: gwB.baseUrl, now });

    await sessionStore.create(sessionA);
    await sessionStore.create(sessionB);
    await sessionStore.create(sessionA2);

    // Verify SQLite round-trip persisted gateway_endpoint cleanly.
    expect((await sessionStore.find(sessionA.id))?.gatewayEndpoint).toBe(gwA.baseUrl);
    expect((await sessionStore.find(sessionB.id))?.gatewayEndpoint).toBe(gwB.baseUrl);
    expect((await sessionStore.find(sessionA2.id))?.gatewayEndpoint).toBe(gwB.baseUrl);

    const noRefreshCheck = createPortalSessionCheck({
      vault: createMemoryTokenVault(),
      portal: createFakePortalClient(),
    });

    const call = (sessionId: string, method: string, path: string, body?: unknown) =>
      dispatch(
        {
          method,
          path,
          query: {},
          params: {},
          headers: { cookie: `${cookieName}=${sessionId}` },
          body,
        },
        { serverMode: true, sessionStore, portalCheck: noRefreshCheck, now: () => now + 1_000 },
      );

    // 1. User A checks gateway -> hits Endpoint A -> OK!
    const checkA = await call(sessionA.id, "POST", "/api/v1/settings/gateway/check");
    expect(checkA.type).toBe("json");
    if (checkA.type === "json") {
      expect(checkA.status).toBe(200);
      const body = checkA.body as { gateway: { status: string; allowed: boolean; endpoint: string; endpointLocked: boolean } };
      expect(body.gateway.status).toBe("ok");
      expect(body.gateway.allowed).toBe(true);
      expect(body.gateway.endpoint).toBe(gwA.baseUrl);
      expect(body.gateway.endpointLocked).toBe(true);
    }
    expect(gwA.hits.some((h) => h.path === "/v1/models" && h.auth === "Bearer sk-key-for-endpoint-a")).toBe(true);

    // 2. User B checks gateway -> hits Endpoint B -> OK!
    const checkB = await call(sessionB.id, "POST", "/api/v1/settings/gateway/check");
    expect(checkB.type).toBe("json");
    if (checkB.type === "json") {
      expect(checkB.status).toBe(200);
      const body = checkB.body as { gateway: { status: string; allowed: boolean; endpoint: string } };
      expect(body.gateway.status).toBe("ok");
      expect(body.gateway.allowed).toBe(true);
      expect(body.gateway.endpoint).toBe(gwB.baseUrl);
    }
    expect(gwB.hits.some((h) => h.path === "/v1/models" && h.auth === "Bearer sk-key-for-endpoint-b")).toBe(true);

    // 3. Carol (same org as Alice, same key `sk-key-for-endpoint-a`, but assigned to Endpoint B)
    //    must fail with `invalid_key` against Endpoint B AND must NOT clobber Alice's `ok` verdict!
    const checkA2 = await call(sessionA2.id, "POST", "/api/v1/settings/gateway/check");
    expect(checkA2.type).toBe("json");
    if (checkA2.type === "json") {
      expect(checkA2.status).toBe(200);
      const body = checkA2.body as { gateway: { status: string; allowed: boolean; endpoint: string } };
      expect(body.gateway.status).toBe("invalid_key");
      expect(body.gateway.allowed).toBe(false);
      expect(body.gateway.endpoint).toBe(gwB.baseUrl);
    }
    // Verify Alice's GET /api/v1/settings still reports `ok` on Endpoint A!
    const settingsA = await call(sessionA.id, "GET", "/api/v1/settings");
    expect(settingsA.type).toBe("json");
    if (settingsA.type === "json") {
      const body = settingsA.body as {
        openaiBaseUrl: string;
        gateway: { status: string; allowed: boolean; endpoint: string };
      };
      expect(body.openaiBaseUrl).toBe(gwA.baseUrl);
      expect(body.gateway.status).toBe("ok");
      expect(body.gateway.allowed).toBe(true);
      expect(body.gateway.endpoint).toBe(gwA.baseUrl);
    }

    // 4. Model caches for Endpoint A and Endpoint B are isolated even inside the same company.
    const scopeA = { tenantId, organizationId: orgA, gatewayEndpoint: gwA.baseUrl };
    const scopeA2 = { tenantId, organizationId: orgA, gatewayEndpoint: gwB.baseUrl };
    expect(modelCacheSlot(scopeA)).not.toBe(modelCacheSlot(scopeA2));
    saveModelCache({ openai: [{ id: "model-alpha", label: "Alpha", provider: "openai", inputModalities: ["text"] }] }, scopeA);
    saveModelCache({ openai: [{ id: "model-beta", label: "Beta", provider: "openai", inputModalities: ["text"] }] }, scopeA2);
    expect(loadModelCache(scopeA).openai?.[0]?.id).toBe("model-alpha");
    expect(loadModelCache(scopeA2).openai?.[0]?.id).toBe("model-beta");

    // 5. Regular user (even an org owner) CANNOT override openaiBaseUrl via POST /api/v1/settings.
    const attemptedOverride = await call(sessionA.id, "POST", "/api/v1/settings", {
      openaiBaseUrl: "https://attacker.example/v1",
      locale: "en",
    });
    expect(attemptedOverride.type).toBe("json");
    if (attemptedOverride.type === "json") {
      expect(attemptedOverride.status).toBe(200);
      const body = attemptedOverride.body as {
        openaiBaseUrl: string;
        gateway: { endpoint: string };
        ignoredFields?: string[];
      };
      expect(body.openaiBaseUrl).toBe(gwA.baseUrl);
      expect(body.gateway.endpoint).toBe(gwA.baseUrl);
      expect(body.ignoredFields).toContain("openaiBaseUrl");
    }
    expect(loadSettings(provA2).openaiBaseUrl).not.toBe("https://attacker.example/v1");

    // 6. Admin reassigns Alice from Endpoint A to Endpoint B; portal delivers gwB on refresh.
    const vault = createMemoryTokenVault();
    await vault.put(sessionA.id, {
      refreshToken: "rt-1",
      accessToken: "at-1",
      deviceId: "dev-1",
    });
    const reassignedPortal = createFakePortalClient({
      tokens: {
        tenantId,
        orgId: orgA,
        userId: userA,
        role: "owner",
        gatewayEndpoint: gwB.baseUrl,
        refreshToken: "rt-2",
        accessToken: "at-2",
      },
    });
    const rotatingCheck = createPortalSessionCheck({ vault, portal: reassignedPortal });
    const afterInterval = now + PORTAL_CHECK_INTERVAL_MS + 5_000;

    // On the very request that triggers the portal refresh, Alice's session switches to gwB and
    // checks her key against gwB — where `sk-key-for-endpoint-a` is rejected!
    const rechecked = await dispatch(
      {
        method: "POST",
        path: "/api/v1/settings/gateway/check",
        query: {},
        params: {},
        headers: { cookie: `${cookieName}=${sessionA.id}` },
      },
      { serverMode: true, sessionStore, portalCheck: rotatingCheck, now: () => afterInterval },
    );
    expect(rechecked.type).toBe("json");
    if (rechecked.type === "json") {
      expect(rechecked.status).toBe(200);
      const body = rechecked.body as { gateway: { status: string; allowed: boolean; endpoint: string } };
      expect(body.gateway.endpoint).toBe(gwB.baseUrl);
      expect(body.gateway.status).toBe("invalid_key");
      expect(body.gateway.allowed).toBe(false);
    }
    // And the persisted SQLite session row now holds Endpoint B!
    expect((await sessionStore.find(sessionA.id))?.gatewayEndpoint).toBe(gwB.baseUrl);
  });
});
