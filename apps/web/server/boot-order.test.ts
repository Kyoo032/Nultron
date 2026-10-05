/**
 * SR-25 — a hosted process with a bad environment refuses BEFORE it writes anything.
 *
 * `hosted-mode-guard.test.ts` reads `server.ts` as text and asserts the two guard calls sit above
 * `server.listen(`. That is true, and it is why SR-25 stayed invisible: ESM hoists every `import`
 * above the module body, so `@agentforge/host/http` — and through it `packages/db/src/client.ts`,
 * which does `mkdirSync` of the data dir, applies a queued "Start over" wipe, opens SQLite and runs
 * every migration at module scope — had already been evaluated by the time `main()` ran its guards.
 * Source order proves nothing about evaluation order, so this runs the real entry in a real process
 * and looks at the disk afterwards.
 *
 * What it cannot do is bind a port or reach a network: every case here is refused by a guard before
 * `server.listen`, and the guards read only the environment (no DNS, no portal call). The per-case
 * timeout is the backstop if that ever stops being true.
 *
 * A passing case needs BOTH halves — the refusal text on stderr (so the process really reached the
 * guard, rather than dying on a bad import) and an untouched disk (so nothing ran ahead of it).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(WEB, "server.ts");
/**
 * tsx's own JS entry, run by this Node. Not `node_modules/.bin/tsx`: that is an extensionless POSIX
 * shell shim Windows cannot execute (see `wrap-key-rotation-script.test.ts`).
 */
const TSX_CLI = createRequire(path.join(WEB, "package.json")).resolve("tsx/cli");

/** Cold tsx start plus the module graph; the guard path is fast, the budget is for a slow disk. */
const BOOT_BUDGET_MS = 120_000;

const scratch = mkdtempSync(path.join(tmpdir(), "agentforge-boot-order-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** What a hosted process needs, so a case can take away exactly one thing. */
function hostedEnv(): Record<string, string> {
  return {
    AGENTFORGE_SERVER: "1",
    AGENTFORGE_SECRETS_KEY: randomBytes(32).toString("hex"),
    AGENTFORGE_TRUSTED_ORIGINS: "https://nultron.example.com",
    AGENTFORGE_PORTAL_URL: "https://portal.example.com/api",
    AGENTFORGE_PORTAL_CLIENT_ID: "nultron-web",
    AGENTFORGE_PORTAL_CLIENT_SECRET: "client-secret-value",
  };
}

/** The parent's environment minus everything that selects a mode, a port, a database or a portal. */
function inheritedEnv(): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(AGENTFORGE_|PORTAL_|PORT$|BIND_HOST$|NODE_ENV$|DATABASE_URL$)/.test(name)) {
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

type Boot = { status: number | null; stdout: string; stderr: string; dataDir: string };

/**
 * Boots `server.ts` the way `pnpm start` does (cwd = apps/web), against a data dir of the case's own.
 *
 * Async on purpose: `spawnSync` parks the vitest worker's event loop for the whole boot, and a
 * worker that cannot answer the runner for long enough is reported as an unhandled
 * `Timeout calling "onTaskUpdate"` error.
 */
function boot(name: string, env: Record<string, string>, prepare?: (dataDir: string) => void): Promise<Boot> {
  const dataDir = path.join(scratch, name, "data");
  prepare?.(dataDir);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
      cwd: WEB,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...inheritedEnv(), ...env, AGENTFORGE_DATA_DIR: dataDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // A process that is still alive at the budget did not refuse, which is a failure of its own: it
    // may be listening. Kill it by pid and say so rather than leave it behind.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server.ts was still running after ${BOOT_BUDGET_MS} ms; it did not refuse.\n${stderr}`));
    }, BOOT_BUDGET_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, dataDir });
    });
  });
}

function refused(result: Boot): void {
  expect(result.status, `exit status; stderr was:\n${result.stderr}`).not.toBeNull();
  expect(result.status).not.toBe(0);
}

describe("a refused hosted boot writes nothing", () => {
  it(
    "names the missing wrap key and never creates the data dir or SQLite",
    async () => {
      const { AGENTFORGE_SECRETS_KEY: _omitted, ...withoutKey } = hostedEnv();
      const result = await boot("missing-key", withoutKey);

      refused(result);
      expect(result.stderr).toContain("Hosted mode (AGENTFORGE_SERVER=1) refuses to start");
      expect(result.stderr).toContain("AGENTFORGE_SECRETS_KEY");
      expect(existsSync(result.dataDir), "the data dir must not exist after a refused boot").toBe(false);
      expect(existsSync(path.join(result.dataDir, "agentforge.sqlite"))).toBe(false);
    },
    BOOT_BUDGET_MS + 10_000,
  );

  it(
    "refuses a production build with no server flag before it creates the data dir",
    async () => {
      const result = await boot("production-no-flag", { NODE_ENV: "production" });

      refused(result);
      expect(result.stderr).toContain("AGENTFORGE_SERVER is not set");
      expect(existsSync(result.dataDir), "the data dir must not exist after a refused boot").toBe(false);
    },
    BOOT_BUDGET_MS + 10_000,
  );

  it(
    "leaves a queued Start over wipe and every file in the data dir alone",
    async () => {
      const { AGENTFORGE_SECRETS_KEY: _omitted, ...withoutKey } = hostedEnv();
      const result = await boot("queued-reset", withoutKey, (dataDir) => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(path.join(dataDir, "settings.enc"), "sealed-bytes");
        writeFileSync(
          path.join(dataDir, "reset-pending.json"),
          JSON.stringify({ version: 1, requestedAt: new Date(0).toISOString(), entries: ["settings.enc"] }),
        );
      });

      refused(result);
      expect(result.stderr).toContain("AGENTFORGE_SECRETS_KEY");
      // The wipe deletes `settings.enc` and the marker, and opening SQLite adds the database trio.
      expect(readdirSync(result.dataDir).sort()).toEqual(["reset-pending.json", "settings.enc"]);
    },
    BOOT_BUDGET_MS + 10_000,
  );
});
