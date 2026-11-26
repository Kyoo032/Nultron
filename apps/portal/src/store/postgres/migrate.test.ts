/**
 * The migration runner against a genuinely empty database: the five files the backend team owns,
 * then ours, then the same run again.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../testing/pg";
import { listMigrations, runMigrations } from "./migrate";

let database: TestDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase({ fromTemplate: false });
  pool = new pg.Pool({ connectionString: database.url, max: 2 });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

async function migrate(): Promise<{ applied: readonly string[]; skipped: readonly string[] }> {
  const client = await pool.connect();
  try {
    return await runMigrations(client);
  } finally {
    client.release();
  }
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1) AS ok`,
    [name],
  );
  return rows[0].ok;
}

describe("runMigrations", () => {
  it("reads the backend team's files from docs/internal/portal/migrations, not a copy", async () => {
    const files = await listMigrations();
    const shared = files.filter((file) => file.source === "docs").map((file) => file.id);
    expect(shared).toEqual([
      "0001_extensions_and_roles.sql",
      "0002_core_tables.sql",
      "0003_billing_and_usage.sql",
      "0004_rls.sql",
      "0005_functions.sql",
    ]);
    for (const file of files.filter((candidate) => candidate.source === "docs")) {
      expect(file.path).toContain("docs");
      expect(file.path).toContain("portal");
    }
  });

  it("applies every file once, then skips them all on a second run", async () => {
    const first = await migrate();
    expect(first.applied).toContain("0002_core_tables.sql");
    expect(first.applied).toContain("0006_browser_login.sql");
    expect(first.applied).toContain("0007_tenant_resolvers.sql");
    expect(first.applied).toContain("0011_invites.sql");
    expect(first.applied).toContain("0012_password_signin.sql");
    expect(first.applied).toContain("0013_password_grace.sql");
    expect(first.skipped).toHaveLength(0);

    const second = await migrate();
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toEqual(first.applied);

    const third = await migrate();
    expect(third.applied).toHaveLength(0);
  });

  it("creates the tables the login flow reads", async () => {
    for (const table of [
      "tenants",
      "tenant_config",
      "orgs",
      "users",
      "devices",
      "sessions",
      "refresh_tokens",
      "device_codes",
      "login_otps",
      "audit_log",
      "oauth_clients",
      "auth_codes",
      "invites",
      "user_credentials",
      "user_oidc_identities",
      "oidc_login_states",
    ]) {
      expect(await tableExists(table), table).toBe(true);
    }
  });

  it("keeps its bookkeeping out of public, where 0004 re-owns every table", async () => {
    expect(await tableExists("migrations")).toBe(false);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM portal_meta.migrations`,
    );
    // Counted from the directories rather than pinned to a number, so adding a migration is not
    // also a test edit. 0008 arriving is what showed that the pin was the brittle half.
    expect(rows[0].n).toBe((await listMigrations()).length);
  });

  it("installs 0005's functions and 0007's resolvers", async () => {
    const { rows } = await pool.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname = ANY($1::text[])`,
      [
        [
          "count_active_users",
          "login_precheck",
          "rotate_refresh_token",
          "revoke_session_chain",
          "expire_device_codes",
          "prune_login_otps",
          "resolve_tenant_by_slug",
          "resolve_tenant_for_refresh",
          "resolve_tenant_for_username",
        ],
      ],
    );
    expect(rows).toHaveLength(9);
  });

  /**
   * `0001_extensions_and_roles.sql:53-55` describes the role the portal should log in as and
   * leaves creating it to someone else: `CREATE ROLE portal_app_login LOGIN ... IN ROLE portal_app`.
   * Nobody did, so the portal connected as the migration role, which in compose is the cluster
   * superuser. 0010 creates it, with nothing but `portal_app` membership. Roles are cluster-wide,
   * so this reads attributes, never the password another suite may have set meanwhile.
   */
  it("creates portal_app_login as 0001 describes it: a LOGIN member of portal_app and nothing more", async () => {
    const { rows } = await pool.query<{
      login: boolean;
      superuser: boolean;
      bypass: boolean;
      createrole: boolean;
      createdb: boolean;
      app: boolean;
      admin: boolean;
    }>(
      `SELECT r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              r.rolcreaterole AS createrole, r.rolcreatedb AS createdb,
              pg_has_role(r.oid, 'portal_app', 'MEMBER') AS app,
              pg_has_role(r.oid, 'portal_admin', 'MEMBER') AS admin
         FROM pg_roles r WHERE r.rolname = 'portal_app_login'`,
    );
    expect(rows).toEqual([
      { login: true, superuser: false, bypass: false, createrole: false, createdb: false, app: true, admin: false },
    ]);
  });

  it("installs 0017's OIDC shape: per-tenant bindings, sso_required, the state resolver", async () => {
    // The binding key carries the tenant: the same (issuer, subject) may bind a seat per tenant.
    const { rows: pk } = await pool.query<{ column: string }>(
      `SELECT a.attname AS column
         FROM pg_constraint c
         JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS ord(attnum, n) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.attnum
        WHERE c.conrelid = 'user_oidc_identities'::regclass AND c.contype = 'p'
        ORDER BY ord.n`,
    );
    expect(pk.map((row) => row.column)).toEqual(["tenant_id", "issuer", "subject"]);

    const { rows: col } = await pool.query<{ default: string | null; nullable: boolean }>(
      `SELECT column_default AS "default", is_nullable = 'YES' AS nullable
         FROM information_schema.columns
        WHERE table_name = 'orgs' AND column_name = 'sso_required'`,
    );
    expect(col).toEqual([{ default: "false", nullable: false }]);

    // The callback's way into a tenant scope: an unknown or expired state resolves to NULL.
    const { rows: state } = await pool.query<{ tenant_id: string | null }>(
      `SELECT resolve_tenant_for_oidc_state($1) AS tenant_id`,
      [Buffer.alloc(32)],
    );
    expect(state).toEqual([{ tenant_id: null }]);
  });

  it("widens users_role_chk to the auditor seat (0015)", async () => {
    const { rows } = await pool.query<{ check: string }>(
      `SELECT pg_get_constraintdef(oid) AS check FROM pg_constraint WHERE conname = 'users_role_chk'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].check).toContain("'auditor'");
    for (const role of ["owner", "admin", "member"]) {
      expect(rows[0].check).toContain(`'${role}'`);
    }
  });

  it("puts no password in a migration file, as 0001 requires of login roles", async () => {
    for (const file of (await listMigrations()).filter((candidate) => candidate.source === "portal")) {
      const sql = await readFile(file.path, "utf8");
      expect(sql, file.id).not.toMatch(/PASSWORD\s+'/i);
      expect(sql, file.id).not.toMatch(/PASSWORD\s+\$/i);
    }
  });

  it("re-applies cleanly when the tracking rows are lost but the schema is not", async () => {
    // A database restored from a dump that did not carry portal_meta. Every file claims to be
    // safe to re-run; this is the claim being tested rather than trusted.
    await pool.query(`DELETE FROM portal_meta.migrations`);
    const again = await migrate();
    expect(again.applied).toHaveLength((await listMigrations()).length);
    expect(await tableExists("tenants")).toBe(true);
  });

  it("refuses to run when an applied file has been edited", async () => {
    await pool.query(`UPDATE portal_meta.migrations SET checksum = 'tampered' WHERE id = $1`, [
      "0002_core_tables.sql",
    ]);
    await expect(migrate()).rejects.toThrow(/has changed since it was applied/);
    // Put it back, so the file stays usable for anything that runs after this one.
    await pool.query(`DELETE FROM portal_meta.migrations WHERE id = $1`, ["0002_core_tables.sql"]);
    await migrate();
  });
});
