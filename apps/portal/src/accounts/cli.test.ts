/**
 * The operator's command as an operator runs it: a real process, `scripts/account.ts` under `tsx`, a real
 * Postgres, the environment a deployment gives the portal container, and nothing typed. This is what
 * `sh webapp-deploy/scripts/portal.sh account ...` runs inside the container (`portal-entry.sh` builds the
 * two DSNs from portal.env and then execs exactly this), so it is the closest this repo can get to the
 * wrapper without a container.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRoleUrl, createTestDatabase, type TestDatabase } from "../testing/pg";

const PORTAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

let database: TestDatabase;
let dataDir: string;
let env: Record<string, string>;

beforeAll(async () => {
  database = await createTestDatabase();
  dataDir = mkdtempSync(join(tmpdir(), "portal-account-cli-"));
  // The machine's own environment (tsx needs its temp folder and the like), minus anything that is the
  // portal's, so a variable in the operator's shell cannot change what these cases mean.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("PORTAL_") &&
        entry[0] !== "DATABASE_URL" &&
        entry[0] !== "NODE_ENV",
    ),
  );
  env = {
    ...inherited,
    PORTAL_DATA_DIR: dataDir,
    // What `portal-entry.sh` builds: the schema owner for migrations, `portal_app`'s member for serving.
    PORTAL_MIGRATE_DATABASE_URL: database.url,
    PORTAL_DATABASE_URL: await appRoleUrl(database),
    PORTAL_SIGNIN_MODE: "password",
  };
}, 180_000);

afterAll(async () => {
  await database?.drop();
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function run(script: string, args: string[], overrides: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...env, ...overrides };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  const result = spawnSync(process.execPath, [TSX, `scripts/${script}.ts`, ...args], {
    cwd: PORTAL_ROOT,
    env: merged as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** The first tenant, org and owner, made the way a deployment makes them. */
function seed() {
  return run("seed", ["--email", "owner@cli.test", "--tenant", "clitest", "--org-slug", "kyo", "--seat-cap", "3"]);
}

describe("scripts/account.ts", () => {
  it("prints its usage without touching the database", () => {
    const result = run("account", ["--help"], {
      PORTAL_DATABASE_URL: undefined,
      PORTAL_MIGRATE_DATABASE_URL: undefined,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("create");
    expect(result.out).toContain("reset-password");
    expect(result.out).toContain("PORTAL_SIGNIN_MODE=password");
  }, 120_000);

  it("refuses to run on a portal that is not in password mode, before it connects to anything", () => {
    const result = run("account", ["list"], { PORTAL_SIGNIN_MODE: undefined });
    expect(result.code).toBe(3);
    expect(result.err).toContain("not in password mode");
    expect(result.out).toBe("");
  }, 120_000);

  it("is usage for a command it does not know, with exit code 2", () => {
    const result = run("account", ["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Unknown command");
  }, 120_000);

  it("makes a person, prints the initial password once, and never prints it again", () => {
    const seeded = seed();
    expect(seeded.code, seeded.err).toBe(0);

    const created = run("account", [
      "create",
      "--tenant",
      "clitest",
      "--username",
      "cli.alice",
      "--email",
      "alice@cli.test",
      "--role",
      "admin",
    ]);
    expect(created.code, created.err).toBe(0);
    const password = /^password\s+(\S+)$/m.exec(created.out)?.[1] ?? "";
    expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{4}(-[A-HJ-NP-Za-km-np-z2-9]{4}){4}$/);
    expect(created.out).toContain("shown once");
    // Nothing the command wrote to the error stream carries it either.
    expect(created.err).not.toContain(password);

    const listed = run("account", ["list", "--tenant", "clitest"]);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain("cli.alice");
    expect(listed.out).toContain("alice@cli.test");
    expect(listed.out).toContain("must change");
    // The owner `seed` made is on record with no password yet.
    expect(listed.out).toContain("owner@cli.test");
    expect(listed.out).toContain("no password");
    expect(listed.out).not.toContain(password);
    expect(listed.out).toMatch(/seats 2 of 3 on record/);
  }, 180_000);

  it("refuses with a reason and a non-zero exit code, and writes nothing", () => {
    const taken = run("account", [
      "create",
      "--tenant",
      "clitest",
      "--username",
      "cli.alice",
      "--email",
      "someone.else@cli.test",
    ]);
    expect(taken.code).toBe(4);
    expect(taken.err).toContain("already taken");
    expect(taken.out).toBe("");

    // The cap is three: the owner, Alice, and one more. The fourth is refused.
    expect(
      run("account", ["create", "--tenant", "clitest", "--username", "cli.bob", "--email", "bob@cli.test"]).code,
    ).toBe(0);
    const full = run("account", [
      "create",
      "--tenant",
      "clitest",
      "--username",
      "cli.carol",
      "--email",
      "carol@cli.test",
    ]);
    expect(full.code).toBe(5);
    expect(full.err).toContain("no seat left");

    const missing = run("account", ["reset-password", "--tenant", "clitest", "--username", "nobody.here"]);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("Nobody in this tenant");
  }, 180_000);

  it("resets a password to a different one, and disables and enables a person", () => {
    const reset = run("account", ["reset-password", "--tenant", "clitest", "--username", "cli.alice"]);
    expect(reset.code, reset.err).toBe(0);
    expect(/^password\s+(\S+)$/m.exec(reset.out)?.[1]).toMatch(/^[A-HJ-NP-Za-km-np-z2-9-]{24}$/);

    const disabled = run("account", ["disable", "--tenant", "clitest", "--email", "bob@cli.test"]);
    expect(disabled.code, disabled.err).toBe(0);
    expect(disabled.out).toContain("disabled and signed out everywhere");
    expect(run("account", ["list", "--tenant", "clitest"]).out).toMatch(/cli\.bob\s+bob@cli\.test\s+member\s+disabled/);
    const enabled = run("account", ["enable", "--tenant", "clitest", "--username", "cli.bob"]);
    expect(enabled.code, enabled.err).toBe(0);
  }, 180_000);

  it("is how invite and otp are turned away on this portal", () => {
    const invite = run("invite", ["--email", "x@cli.test", "--tenant", "clitest"]);
    expect(invite.code).toBe(3);
    expect(invite.err).toContain("username and a password");
    const otp = run("otp", ["x@cli.test"], { PORTAL_ALLOW_MANUAL_OTP: "1" });
    expect(otp.code).toBe(3);
    expect(otp.err).toContain("username and a password");
  }, 180_000);
});
