import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { harnessSpecFor, type CodeLanguage, type GatewayGatePayload, type TenantContext } from "@agentforge/core";
import {
  collectSelfCheck,
  createSelfCheckTool,
  defaultSelfCheckDeps,
  selfCheckTool,
  type SelfCheckDeps,
} from "./self-check-tool";
import { withToolRun } from "./tool-run-context";

const languages = (...items: CodeLanguage[]): ReadonlySet<CodeLanguage> => new Set(items);

const tenant: TenantContext = {
  tenantId: "tenant-secret-id-123",
  organizationId: "org-secret-id-456",
  workspaceId: "ws-secret-id-789",
  userId: "user-secret-id-000",
  role: "owner",
};

const openGate: GatewayGatePayload = {
  status: "ok",
  allowed: true,
  grace: false,
  endpoint: "https://api.example.test/v1",
  endpointLocked: true,
  checkedAt: "2026-10-06T00:00:00.000Z",
  lastOkAt: "2026-10-06T00:00:00.000Z",
  message: "C:\\Users\\someone\\secret.txt",
};

function deps(overrides: Partial<SelfCheckDeps> = {}): SelfCheckDeps {
  return {
    serverMode: () => false,
    gate: () => openGate,
    codeRunsEnabled: () => true,
    ship: async () => ({
      ok: true,
      dir: "C:\\Program Files\\Nultron\\sandbox",
      languages: languages("python", "javascript"),
    }),
    ffmpeg: async () => ({ found: true, path: "C:\\tools\\ffmpeg.exe", version: "7.1" }),
    ffprobe: async () => ({ found: true, path: "C:\\tools\\ffprobe.exe", version: "7.1" }),
    notOffered: () => [],
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_CODE_RUNS;
});

describe("collectSelfCheck", () => {
  it("reports the facts of a desk where everything is in place", async () => {
    const report = await collectSelfCheck(tenant, deps());
    expect(report).toEqual({
      ok: true,
      server_mode: false,
      gateway: { status: "ok", allowed: true, grace: false },
      code_runs: { enabled: true, sandbox: "ready", python: true, javascript: true },
      media_tools: { ffmpeg: true, ffprobe: true },
      tools_not_offered: [],
      run_limits: null,
    });
  });

  it("reports a hosted server with code runs off, no key, and no ffmpeg", async () => {
    const report = await collectSelfCheck(
      tenant,
      deps({
        serverMode: () => true,
        gate: () => ({ ...openGate, status: "needs_key", allowed: false }),
        codeRunsEnabled: () => false,
        ffmpeg: async () => ({ found: false, path: null, version: null, reason: "not found in C:\\tools" }),
        ffprobe: async () => ({ found: false, path: null, version: null }),
        notOffered: () => ["run_code"],
      }),
    );
    expect(report).toMatchObject({
      server_mode: true,
      gateway: { status: "needs_key", allowed: false },
      code_runs: { enabled: false },
      media_tools: { ffmpeg: false, ffprobe: false },
      tools_not_offered: ["run_code"],
    });
  });

  it("does not check the sandbox where code runs are off: no hashing of its files for a tool nobody can call", async () => {
    let shipChecks = 0;
    const report = await collectSelfCheck(
      tenant,
      deps({
        codeRunsEnabled: () => false,
        ship: async () => {
          shipChecks += 1;
          return { ok: true, dir: "/x", languages: languages("python", "javascript") };
        },
      }),
    );
    expect(shipChecks).toBe(0);
    expect(report.code_runs).toEqual({ enabled: false, sandbox: "not_checked", python: false, javascript: false });
  });

  it("checks the sandbox once where code runs are on", async () => {
    let shipChecks = 0;
    await collectSelfCheck(
      tenant,
      deps({
        ship: async () => {
          shipChecks += 1;
          return { ok: false, why: "missing" };
        },
      }),
    );
    expect(shipChecks).toBe(1);
  });

  it("says plainly when the sandbox is missing, unusable, or has one language", async () => {
    const missing = await collectSelfCheck(tenant, deps({ ship: async () => ({ ok: false, why: "missing" }) }));
    expect(missing.code_runs).toEqual({ enabled: true, sandbox: "missing", python: false, javascript: false });
    const broken = await collectSelfCheck(tenant, deps({ ship: async () => ({ ok: false, why: "mismatch" }) }));
    expect(broken.code_runs.sandbox).toBe("unusable");
    const half = await collectSelfCheck(
      tenant,
      deps({ ship: async () => ({ ok: true, dir: "/x", languages: languages("javascript") }) }),
    );
    expect(half.code_runs).toEqual({ enabled: true, sandbox: "ready", python: false, javascript: true });
  });

  it("copies out of the gate and the probes only what the model needs, never a path, a message or a time", async () => {
    const report = await collectSelfCheck(tenant, deps());
    const text = JSON.stringify(report);
    for (const hidden of ["api.example.test", "C:\\", "ffmpeg.exe", "7.1", "someone", "2026-10-06", "Program Files"]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("carries no tenant, organization, workspace or user id", async () => {
    const text = JSON.stringify(await collectSelfCheck(tenant, deps()));
    for (const id of [tenant.tenantId, tenant.organizationId, tenant.workspaceId, tenant.userId]) {
      expect(text).not.toContain(id);
    }
  });

  it("reads this run's limits from its mode's harness spec", async () => {
    const report = await withToolRun({ runId: "run-1", mode: "chat" }, () => collectSelfCheck(tenant, deps()));
    const budget = harnessSpecFor("chat").budget;
    expect(report.run_limits).toEqual({
      max_steps: budget.maxSteps,
      max_tool_calls: budget.maxToolCalls,
      per_tool: budget.perTool ?? {},
    });
  });

  it("has no limits to report outside a run, or for a mode it does not know", async () => {
    expect((await collectSelfCheck(tenant, deps())).run_limits).toBeNull();
    const unknown = await withToolRun({ runId: "run-2", mode: "not-a-mode" }, () => collectSelfCheck(tenant, deps()));
    expect(unknown.run_limits).toBeNull();
  });

  it("still answers when a probe throws: that fact is reported as not available", async () => {
    const report = await collectSelfCheck(
      tenant,
      deps({
        ffmpeg: async () => {
          throw new Error("spawn failed at C:\\secret\\ffmpeg.exe");
        },
        ship: async () => {
          throw new Error("EACCES /home/app/sandbox");
        },
      }),
    );
    expect(report.media_tools.ffmpeg).toBe(false);
    expect(report.code_runs.sandbox).toBe("unusable");
    expect(JSON.stringify(report)).not.toMatch(/secret|EACCES|\/home\/app/);
  });
});

describe("selfCheckTool", () => {
  /**
   * The real gate, settings and environment reads, with the two slow probes (the sandbox's file hashes and
   * the PATH walk for ffmpeg) replaced, so this suite adds no load to the host run.
   */
  const realDesk = () =>
    createSelfCheckTool({
      ...defaultSelfCheckDeps,
      ship: async () => ({ ok: false, why: "missing" }),
      ffmpeg: async () => ({ found: false }),
      ffprobe: async () => ({ found: false }),
    });

  it("is a read-only internal tool that takes no arguments", () => {
    expect(selfCheckTool.key).toBe("self_check");
    expect(selfCheckTool.trust).toBe("internal");
    expect(selfCheckTool.schema.safeParse({}).success).toBe(true);
    expect(selfCheckTool.schema.safeParse({ path: "/etc/passwd" }).success).toBe(false);
  });

  it("answers from the real desk with no path of the machine in it", async () => {
    const report = await realDesk().execute({}, tenant);
    const text = JSON.stringify(report);
    for (const place of [
      homedir(),
      tmpdir(),
      process.cwd(),
      tenant.tenantId,
      process.platform === "win32" ? "C:\\" : "/home",
    ]) {
      expect(text.includes(place), place).toBe(false);
    }
    expect(report).toMatchObject({ ok: true });
  });

  it("tells a Personal desk from the hosted server, and code runs on from off", async () => {
    const tool = realDesk();
    const personal = (await tool.execute({}, tenant)) as {
      server_mode: boolean;
      code_runs: { enabled: boolean; sandbox: string };
    };
    expect(personal.server_mode).toBe(false);
    expect(personal.code_runs).toMatchObject({ enabled: true, sandbox: "missing" });

    process.env.AGENTFORGE_SERVER = "1";
    const hosted = (await tool.execute({}, tenant)) as {
      server_mode: boolean;
      code_runs: { enabled: boolean; sandbox: string };
    };
    expect(hosted.server_mode).toBe(true);
    expect(hosted.code_runs).toMatchObject({ enabled: false, sandbox: "not_checked" });

    process.env.AGENTFORGE_CODE_RUNS = "on";
    const hostedOn = (await tool.execute({}, tenant)) as { code_runs: { enabled: boolean; sandbox: string } };
    expect(hostedOn.code_runs).toMatchObject({ enabled: true, sandbox: "missing" });
  });
});
