import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-shell-setting-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SHELL;

import { DEFAULT_SHELL, resolvedShell } from "./shell-setting";
import type { HostJsonResult, HostRequest } from "./types";

const { dispatch } = await import("./router");

function pingRequest(): HostRequest {
  return { method: "GET", path: "/api/v1/ping", query: {}, params: {}, headers: {} };
}

async function pingShell(): Promise<unknown> {
  const result = await dispatch(pingRequest(), { serverMode: false });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  expect(result.status).toBe(200);
  return ((result as HostJsonResult).body as { shell?: unknown }).shell;
}

beforeAll(async () => {
  expect(await pingShell()).toBe("opc");
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  delete process.env.AGENTFORGE_SHELL;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("resolvedShell", () => {
  it("is opc when nothing is set", () => {
    expect(DEFAULT_SHELL).toBe("opc");
    expect(resolvedShell({})).toBe("opc");
  });

  it("is enterprise only for the word enterprise, in any case and with spaces", () => {
    expect(resolvedShell({ AGENTFORGE_SHELL: "enterprise" })).toBe("enterprise");
    expect(resolvedShell({ AGENTFORGE_SHELL: "  Enterprise " })).toBe("enterprise");
    expect(resolvedShell({ AGENTFORGE_SHELL: "ENTERPRISE" })).toBe("enterprise");
  });

  it("is opc for the word opc and for anything else", () => {
    for (const value of ["opc", "OPC", "", "   ", "sme", "enterprise2", "1", "true", "chat-first"]) {
      expect(resolvedShell({ AGENTFORGE_SHELL: value }), JSON.stringify(value)).toBe("opc");
    }
  });
});

describe("the ping", () => {
  it("answers shell opc by default, as the desk and the published app always were", async () => {
    expect(await pingShell()).toBe("opc");
  });

  it("answers shell enterprise when AGENTFORGE_SHELL says so", async () => {
    process.env.AGENTFORGE_SHELL = "enterprise";
    expect(await pingShell()).toBe("enterprise");
  });

  it("falls back to opc for a value it does not know", async () => {
    process.env.AGENTFORGE_SHELL = "desktop";
    expect(await pingShell()).toBe("opc");
  });
});
