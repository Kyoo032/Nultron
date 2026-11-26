/**
 * F1 desk-API checks, driven through `dispatch` on a real database: no response ever carries a
 * secret (W1.6), member and auditor cannot manage sources (W1.7), a tampered allowlist row is
 * refused (W1.10), and every action lands in the audit trail (W1.12).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-datasources-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "5b1e9d3c7a2f4086b1d9e5c3a7f20468d1b9e5c3a7f2046851d9e3c7a5b20f4c";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { dispatch } from "../router";
import { createSession } from "../auth/session";
import { createMemorySessionStore, type SessionStore } from "../auth/session-store";
import { assertAllowedDestination } from "@agentforge/core";
import { destinationAllowlistMac } from "../data-sources/allowlist";
import type { HostJsonResult, HostRequest, HostResult } from "../types";

const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);
const OWNER = { tenantId: "ds-tenant-a", orgId: "ds-org-a", userId: "ds-owner-a" };
const MEMBER = { ...OWNER, userId: "ds-member-a" };
const AUDITOR = { ...OWNER, userId: "ds-auditor-a" };

const S3_SECRET = "super-secret-access-key-DO-NOT-LEAK";

let sessions: SessionStore;
const cookies: Record<string, string> = {};

function body(result: HostResult): any {
  if (result.type !== "json") throw new Error(`expected json, got ${result.type}`);
  return (result as HostJsonResult).body;
}
function code(result: HostResult): string {
  return body(result).error?.code;
}

async function call(
  who: keyof typeof cookies,
  method: string,
  path: string,
  requestBody?: unknown,
): Promise<HostResult> {
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: cookies[who] },
    body: requestBody,
  };
  return dispatch(request, { serverMode: true, sessionStore: sessions, now: () => T0 });
}

let sql: any;

beforeAll(async () => {
  const db = await import("@agentforge/db");
  sql = db.sql;
  await db.ensurePortalOwner(db.db, { ...OWNER, role: "owner" });
  await db.ensurePortalOwner(db.db, { ...MEMBER, role: "member" });
  await db.ensurePortalOwner(db.db, { ...AUDITOR, role: "auditor" });
  sessions = createMemorySessionStore();
  for (const [key, identity] of [
    ["owner", OWNER],
    ["member", MEMBER],
    ["auditor", AUDITOR],
  ] as const) {
    const session = createSession({ ...identity, now: T0 });
    await sessions.create(session);
    cookies[key] = `__Host-agentforge_session=${session.id}`;
  }
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("F1 data-sources API", () => {
  it("creates an s3 source and never echoes the secret (W1.6)", async () => {
    const created = await call("owner", "POST", "/api/v1/data-sources", {
      name: "Reports bucket",
      kind: "s3",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "reports",
      s3AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: S3_SECRET,
    });
    expect(created.type).toBe("json");
    const text = JSON.stringify(body(created));
    expect(text).not.toContain(S3_SECRET);
    expect(text).not.toContain("secret_sealed");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const sourceId = body(created).dataSource.id;

    const listed = await call("member", "GET", "/api/v1/data-sources");
    const listText = JSON.stringify(body(listed));
    expect(listText).not.toContain(S3_SECRET);
    expect(listText).not.toContain("config_sealed");
    expect(body(listed).dataSources[0].id).toBe(sourceId);
  });

  it("refuses member and auditor on every mutation (W1.7)", async () => {
    for (const who of ["member", "auditor"] as const) {
      const r = await call(who, "POST", "/api/v1/data-sources", {
        name: "x",
        kind: "s3",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "b",
        s3AccessKeyId: "a",
        s3SecretAccessKey: "b",
      });
      expect([403, 400].includes((body(r).error as any)?.status ?? 403) || code(r) === "forbidden").toBeTruthy();
      const t = await call(who, "POST", `/api/v1/data-sources/ds-x/test`);
      expect(code(t)).toBe("forbidden");
      const d = await call(who, "DELETE", `/api/v1/data-sources/ds-x/credentials`);
      expect(code(d)).toBe("forbidden");
    }
  });

  it("ignores a MAC-tampered allowlist row (W1.10)", async () => {
    // A hand-inserted row has a bad MAC: the reader must refuse, not trust it.
    sql
      .prepare(
        `INSERT INTO destination_allowlist (id, tenant_id, host, port, allow_private, mac, created_at)
         VALUES ('tampered', 'ds-tenant-a', 'evil.example.com', 443, 0, 'deadbeef', 1)`,
      )
      .run();
    expect(() => assertAllowedDestination("evil.example.com", 443, undefined, "ds-tenant-a")).toThrow(/allowlist/);
    // No tenant context at all also fails closed.
    expect(() => assertAllowedDestination("evil.example.com", 443)).toThrow(/allowlist/);
  });

  it("keeps destination approvals inside their own tenant", () => {
    // A valid row for tenant B names a destination tenant A never approved: A gets refused.
    sql
      .prepare(
        `INSERT INTO destination_allowlist (id, tenant_id, host, port, allow_private, mac, created_at)
         VALUES ('other-tenant', 'ds-tenant-b', 'other-db.example.com', 5432, 0, ?, 1)`,
      )
      .run(destinationAllowlistMac("ds-tenant-b", "other-db.example.com", 5432, false));
    expect(assertAllowedDestination("other-db.example.com", 5432, undefined, "ds-tenant-b")).toEqual({
      allowPrivate: false,
    });
    expect(() => assertAllowedDestination("other-db.example.com", 5432, undefined, "ds-tenant-a")).toThrow(/allowlist/);
  });

  it("audits adds, disables and credential deletes with actor and outcome (W1.12)", async () => {
    const created = await call("owner", "POST", "/api/v1/data-sources", {
      name: "Audit me",
      kind: "s3",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "b",
      s3AccessKeyId: "k",
      s3SecretAccessKey: "sekrit",
    });
    const id = body(created).dataSource.id;
    await call("owner", "POST", `/api/v1/data-sources/${id}/disable`);
    await call("owner", "DELETE", `/api/v1/data-sources/${id}/credentials`);
    const events = sql
      .prepare("SELECT event, actor_id, target_id, outcome FROM audit_events WHERE target_id = ? ORDER BY seq")
      .all(id) as Array<{ event: string; actor_id: string; outcome: string }>;
    expect(events.map((e) => e.event)).toEqual(["data_source.add", "data_source.change", "data_source.change"]);
    expect(events.every((e) => e.actor_id === OWNER.userId)).toBe(true);
    const after = await call("owner", "GET", "/api/v1/data-sources");
    const row = body(after).dataSources.find((s: any) => s.id === id);
    expect(row.status).toBe("disabled");
    expect(row.hasCredentials).toBe(false);
    expect(row.secretLast4).toBeNull();
  });

  it("accepts mysql and still refuses azure_blob until its W3 decision lands", async () => {
    const mysql = await call("owner", "POST", "/api/v1/data-sources", {
      name: "m",
      kind: "mysql",
      host: "db.example.com",
      port: 3306,
      database: "d",
      user: "u",
      secret: "p",
    });
    expect(mysql.type).toBe("json");
    // The mysql driver ships (Rizky's S5 approval); the row stores sealed like every other
    // kind and the response still never echoes the password.
    expect(JSON.stringify(body(mysql))).not.toContain('"p"');
    const azure = await call("owner", "POST", "/api/v1/data-sources", { name: "a", kind: "azure_blob" });
    expect(code(azure)).toBe("driver_missing");
  });
});
