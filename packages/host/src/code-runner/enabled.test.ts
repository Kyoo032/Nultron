/**
 * The `run_code` kill switch. `AGENTFORGE_CODE_RUNS` decides whether the sandbox is offered at all: on for
 * Personal and webdev by default, off on the hosted server until the operator turns it on, because the
 * sandbox has not been proven inside the Docker image yet. When it is off the model never sees the tool
 * (the run's disabled-tools list carries it) and the tool refuses if something calls it anyway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildToolSecretScope,
  getDisabledTools,
  LOCAL_TENANT_ID,
  runWithToolSecrets,
  type TenantContext,
} from "@agentforge/core";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { resetSettingsCacheForTests } from "../settings-store";
import { registerTenantStateSql, resetTenantStateSqlForTests } from "../tenant-state-store";
import { codeRunsEnabled, RUN_CODE_TOOL_KEY, withCodeRunPolicy } from "./enabled";
import { runCodeTool } from "./run-code-tool";
import { type SandboxRunRequest, setSandboxRunnerForTests } from "./run-code";

const HOSTED = { AGENTFORGE_SERVER: "1" };

describe("codeRunsEnabled", () => {
  it("is on for Personal and webdev when the variable is unset or blank", () => {
    expect(codeRunsEnabled({})).toBe(true);
    expect(codeRunsEnabled({ AGENTFORGE_CODE_RUNS: "" })).toBe(true);
    expect(codeRunsEnabled({ AGENTFORGE_CODE_RUNS: "   " })).toBe(true);
  });

  it("is off in server mode until the operator sets it", () => {
    expect(codeRunsEnabled(HOSTED)).toBe(false);
    expect(codeRunsEnabled({ ...HOSTED, AGENTFORGE_CODE_RUNS: "" })).toBe(false);
  });

  it.each(["on", "ON", " On ", "1", "true", "TRUE"])("reads %j as on, even in server mode", (value) => {
    expect(codeRunsEnabled({ ...HOSTED, AGENTFORGE_CODE_RUNS: value })).toBe(true);
    expect(codeRunsEnabled({ AGENTFORGE_CODE_RUNS: value })).toBe(true);
  });

  it.each(["off", "OFF", " Off ", "0", "false", "FALSE"])("reads %j as off, even on Personal", (value) => {
    expect(codeRunsEnabled({ AGENTFORGE_CODE_RUNS: value })).toBe(false);
    expect(codeRunsEnabled({ ...HOSTED, AGENTFORGE_CODE_RUNS: value })).toBe(false);
  });

  it.each(["of", "yes", "enabled", "2"])("fails closed on %j: a kill switch a typo leaves on is not one", (value) => {
    expect(codeRunsEnabled({ AGENTFORGE_CODE_RUNS: value })).toBe(false);
    expect(codeRunsEnabled({ ...HOSTED, AGENTFORGE_CODE_RUNS: value })).toBe(false);
  });
});

describe("withCodeRunPolicy", () => {
  it("hands back the very same settings when code runs are on", () => {
    const settings = { disabledTools: ["web_search"] };
    expect(withCodeRunPolicy(settings, {})).toBe(settings);
  });

  it("adds run_code to the disabled tools when they are off, and keeps what the owner already disabled", () => {
    const settings = { openaiApiKey: "sk-test", disabledTools: ["web_search"] };
    const next = withCodeRunPolicy(settings, HOSTED);
    expect(next.disabledTools).toEqual(["web_search", RUN_CODE_TOOL_KEY]);
    expect(next.openaiApiKey).toBe("sk-test");
  });

  it("does not mutate its input", () => {
    const disabledTools = ["web_search"];
    const settings = Object.freeze({ disabledTools: Object.freeze(disabledTools) as string[] });
    const next = withCodeRunPolicy(settings, HOSTED);
    expect(next).not.toBe(settings);
    expect(disabledTools).toEqual(["web_search"]);
  });

  it("covers settings that list no disabled tools at all", () => {
    expect(withCodeRunPolicy<{ disabledTools?: string[] }>({}, HOSTED).disabledTools).toEqual([RUN_CODE_TOOL_KEY]);
  });

  it("does not list run_code twice", () => {
    const settings = { disabledTools: [RUN_CODE_TOOL_KEY] };
    expect(withCodeRunPolicy(settings, HOSTED).disabledTools).toEqual([RUN_CODE_TOOL_KEY]);
  });
});

describe("the tool and the settings a run reads", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENTFORGE_SERVER", "AGENTFORGE_CODE_RUNS", "AGENTFORGE_SETTINGS_PATH", "AGENTFORGE_SECRETS_KEY"];
  const tenant: TenantContext = {
    tenantId: LOCAL_TENANT_ID,
    organizationId: "org",
    workspaceId: "desk-code-switch",
    userId: "local",
    role: "owner",
  };
  let requests: SandboxRunRequest[];
  let sqlite: Database.Database;

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), "af-code-switch-"));
    process.env.AGENTFORGE_SETTINGS_PATH = dir;
    process.env.AGENTFORGE_SECRETS_KEY = "b".repeat(64);
    delete process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_CODE_RUNS;
    // Server mode keeps a tenant's settings in rows; a throwaway in-memory database stands in for them.
    sqlite = new Database(":memory:");
    ensureSchema(sqlite);
    sqlite
      .prepare("INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(LOCAL_TENANT_ID, LOCAL_TENANT_ID, LOCAL_TENANT_ID, "active", Date.now());
    registerTenantStateSql(sqlite as unknown as Parameters<typeof registerTenantStateSql>[0]);
    resetSettingsCacheForTests();
    requests = [];
    setSandboxRunnerForTests({
      run: async (request) => {
        requests.push(request);
        return { ok: true, stdout: "ran", stderr: "", outputs: [] };
      },
      shutdown: () => undefined,
    });
  });

  afterEach(() => {
    setSandboxRunnerForTests(null);
    resetTenantStateSqlForTests();
    resetSettingsCacheForTests();
    sqlite.close();
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const disabledForARun = async (): Promise<string[]> => {
    const { loadSettings } = await import("../settings-store");
    return runWithToolSecrets(buildToolSecretScope(loadSettings(tenant)), () => getDisabledTools());
  };

  it("Personal default: the run does not disable run_code and the tool runs", async () => {
    expect(await disabledForARun()).not.toContain(RUN_CODE_TOOL_KEY);
    const result = (await runCodeTool.execute({ language: "python", code: "print(1)" }, tenant)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("server mode default: every run's disabled tools carry run_code, so the model is never offered it", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    expect(await disabledForARun()).toContain(RUN_CODE_TOOL_KEY);
  });

  it("server mode with AGENTFORGE_CODE_RUNS=on offers it again", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_CODE_RUNS = "on";
    expect(await disabledForARun()).not.toContain(RUN_CODE_TOOL_KEY);
  });

  it("Personal with AGENTFORGE_CODE_RUNS=off hides it", async () => {
    process.env.AGENTFORGE_CODE_RUNS = "off";
    expect(await disabledForARun()).toContain(RUN_CODE_TOOL_KEY);
  });

  it("the tool refuses with reason unavailable and never reaches the sandbox when code runs are off", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const result = (await runCodeTool.execute({ language: "python", code: "print(1)" }, tenant)) as {
      ok: boolean;
      reason?: string;
      stderr: string;
      filesWritten: unknown[];
    };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unavailable");
    expect(result.stderr).toContain("[run_code]");
    expect(result.filesWritten).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("the tool runs on the hosted server once AGENTFORGE_CODE_RUNS=on", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_CODE_RUNS = "on";
    const result = (await runCodeTool.execute({ language: "javascript", code: "1" }, tenant)) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });
});
