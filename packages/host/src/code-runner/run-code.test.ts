import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeLanguage } from "@agentforge/core";
import { killTrackedChildren, trackedChildCount } from "../child-processes";
import { type FakeShip, makeFakeShip, type FakeShipOptions } from "./__fixtures__/fake-ship";
import { spawnSandboxChild } from "./child-process";
import { createCodeLimiter } from "./code-limiter";
import { MAX_CODE_BYTES, MAX_INPUT_FILES, MAX_STREAM_BYTES } from "./limits";
import { createChildPool } from "./pool";
import { createSandboxRunner, type SandboxRunRequest, type SandboxRunner } from "./run-code";
import { resetShipVerdictForTests, setShipDirForTests } from "./ship";

let ship: FakeShip | null = null;
let runner: SandboxRunner | null = null;
const SECRET_NAME = "AGENTFORGE_SECRETS_KEY";
const savedSecret = process.env[SECRET_NAME];

type Options = {
  readonly ship?: FakeShipOptions;
  readonly serverMode?: boolean;
  readonly runTimeoutMs?: number;
  readonly bootTimeoutMs?: number;
  readonly queueWaitMs?: number;
  readonly hostedWarmTotal?: number;
  readonly maxRuns?: number;
  readonly maxPerTenant?: number;
};

function start(options: Options = {}): SandboxRunner {
  ship = makeFakeShip(options.ship);
  resetShipVerdictForTests();
  setShipDirForTests(ship.dir);
  const serverMode = options.serverMode ?? false;
  const dir = ship.dir;
  runner = createSandboxRunner({
    runTimeoutMs: options.runTimeoutMs,
    limiter: createCodeLimiter({
      serverMode,
      maxRuns: options.maxRuns,
      maxPerTenant: options.maxPerTenant,
      queueWaitMs: options.queueWaitMs ?? 3000,
    }),
    pool: createChildPool({
      serverMode,
      hostedWarmTotal: options.hostedWarmTotal,
      spawn: (language) => spawnSandboxChild({ shipDir: dir, language, bootTimeoutMs: options.bootTimeoutMs }),
    }),
  });
  return runner;
}

const request = (
  code: string,
  patch: Partial<SandboxRunRequest> & { language?: CodeLanguage } = {},
): SandboxRunRequest => ({
  tenantId: "tenant-a",
  workspaceId: "desk-1",
  language: "python",
  code,
  files: {},
  ...patch,
});

beforeEach(() => {
  process.env[SECRET_NAME] = "parent-secret-do-not-leak";
});

/** A killed child still holds its working directory for a moment on Windows; wait for it to go. */
async function waitForNoChildren(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (trackedChildCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  runner?.shutdown();
  runner = null;
  killTrackedChildren("SIGKILL");
  await waitForNoChildren();
  setShipDirForTests(null);
  resetShipVerdictForTests();
  await ship?.cleanup();
  ship = null;
  if (savedSecret === undefined) {
    delete process.env[SECRET_NAME];
  } else {
    process.env[SECRET_NAME] = savedSecret;
  }
});

describe("a run", () => {
  it("returns the child's output and registers the child with the shell", async () => {
    const sandbox = start();
    const result = await sandbox.run(request("echo:hello"));
    expect(result).toEqual({ ok: true, stdout: "hello", stderr: "", outputs: [] });
    expect(trackedChildCount()).toBeGreaterThanOrEqual(1);
  });

  it("shows the value of the last expression after the output", async () => {
    const result = await start().run(request("value:42"));
    expect(result.stdout).toBe("printed\n42");
  });

  it("passes input files to the child by their relative paths", async () => {
    const result = await start().run(request("files", { files: { "data/a.csv": "1,2", "b.txt": "x" } }));
    expect(JSON.parse(result.stdout)).toEqual({ "data/a.csv": "1,2", "b.txt": "x" });
  });

  it("runs JavaScript through its own child", async () => {
    const result = await start().run(request("echo:js", { language: "javascript" }));
    expect(result).toMatchObject({ ok: true, stdout: "js" });
  });
});

describe("the child is a sandbox", () => {
  it("does not inherit the parent's environment", async () => {
    const result = await start().run(request("env"));
    const seen = JSON.parse(result.stdout) as { keys: string[]; secret: string };
    expect(seen.secret).toBe("absent");
    expect(result.stdout).not.toContain("parent-secret-do-not-leak");
    expect(seen.keys.filter((key) => /KEY|SECRET|TOKEN|AGENTFORGE|PASSWORD/i.test(key))).toEqual([]);
  });

  it("is started with the permission model, no code generation from strings and an old-space cap", async () => {
    const sandbox = start();
    const result = await sandbox.run(request("argv"));
    const flags = JSON.parse(result.stdout) as string[];
    expect(flags).toContain("--permission");
    expect(flags).toContain(`--allow-fs-read=${ship?.dir}`);
    expect(flags).toContain("--disallow-code-generation-from-strings");
    expect(flags).toContain("--max-old-space-size=128");
    // No write, child-process or worker grants.
    expect(flags.filter((flag) => /allow-(fs-write|child-process|worker|addons|wasi)/.test(flag))).toEqual([]);
  });

  it("can read its own ship directory and nothing above it, and cannot start a program", async () => {
    const sandbox = start();
    const fsResult = await sandbox.run(request("fs-escape"));
    expect(JSON.parse(fsResult.stdout)).toEqual({ inside: "READ", outside: "ERR_ACCESS_DENIED" });
    const spawnResult = await sandbox.run(request("spawn-escape"));
    expect(spawnResult.stdout).toBe("ERR_ACCESS_DENIED");
  });
});

describe("warm children", () => {
  it("answers the second run of the same tenant, desk and language from the same process", async () => {
    const sandbox = start();
    const first = await sandbox.run(request("pid"));
    const second = await sandbox.run(request("pid"));
    expect(second.stdout).toBe(first.stdout);
  });

  it("never lets two tenants share a process", async () => {
    const sandbox = start({ serverMode: true, hostedWarmTotal: 2 });
    const a = await sandbox.run(request("pid", { tenantId: "tenant-a" }));
    const b = await sandbox.run(request("pid", { tenantId: "tenant-b" }));
    const aAgain = await sandbox.run(request("pid", { tenantId: "tenant-a" }));
    expect(b.stdout).not.toBe(a.stdout);
    expect(aAgain.stdout).toBe(a.stdout);
  });

  it("never lets two desks of one tenant share a process", async () => {
    const sandbox = start({ serverMode: true });
    const one = await sandbox.run(request("pid", { workspaceId: "desk-1" }));
    const two = await sandbox.run(request("pid", { workspaceId: "desk-2" }));
    expect(two.stdout).not.toBe(one.stdout);
  });
});

describe("a run that goes wrong discards its child", () => {
  it("kills a run that outlasts the wall clock, answers timeout and boots a new child next time", async () => {
    const sandbox = start({ runTimeoutMs: 500 });
    const before = await sandbox.run(request("pid"));
    const started = Date.now();
    const stuck = await sandbox.run(request("hang"));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stuck).toMatchObject({ ok: false, reason: "timeout", outputs: [] });
    expect(stuck.stderr).toContain("30 seconds");
    const after = await sandbox.run(request("pid"));
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("answers a permission crash with a fixed sentence and no process text", async () => {
    const sandbox = start();
    const before = await sandbox.run(request("pid"));
    const crashed = await sandbox.run(request("crash"));
    expect(crashed).toMatchObject({ ok: false, reason: "runtime" });
    expect(crashed.stderr).toContain("not allowed");
    expect(crashed.stderr).not.toMatch(/node:internal|ERR_ACCESS_DENIED|use --allow/);
    const after = await sandbox.run(request("pid"));
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("answers a V8 heap crash as memory", async () => {
    const result = await start().run(request("oom"));
    expect(result).toMatchObject({ ok: false, reason: "memory" });
    expect(result.stderr).toContain("more memory than the sandbox allows");
  });

  it("answers a guest MemoryError as memory and does not reuse the child", async () => {
    const sandbox = start();
    const before = await sandbox.run(request("pid"));
    const result = await sandbox.run(request("error:MemoryError:MemoryError"));
    expect(result).toMatchObject({ ok: false, reason: "memory" });
    const after = await sandbox.run(request("pid"));
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("does not reuse a child that asks to be discarded", async () => {
    const sandbox = start();
    const first = await sandbox.run(request("discard"));
    expect(first.ok).toBe(true);
    const pidAfter = await sandbox.run(request("pid"));
    const pidAgain = await sandbox.run(request("pid"));
    expect(pidAgain.stdout).toBe(pidAfter.stdout);
  });

  it("answers too_large for an oversize workspace and does not reuse the child", async () => {
    const sandbox = start();
    const before = await sandbox.run(request("pid"));
    const result = await sandbox.run(request("tooLarge"));
    expect(result).toMatchObject({ ok: false, reason: "too_large", outputs: [] });
    const after = await sandbox.run(request("pid"));
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("keeps a child that only raised an ordinary exception", async () => {
    const sandbox = start();
    const before = await sandbox.run(request("pid"));
    const failed = await sandbox.run(request("error:KeyError:KeyError: 'b'"));
    expect(failed).toMatchObject({ ok: false, reason: "runtime" });
    const after = await sandbox.run(request("pid"));
    expect(after.stdout).toBe(before.stdout);
  });

  it("classifies a syntax error and scrubs the host from the exception text", async () => {
    const sandbox = start();
    const result = await sandbox.run(
      request(
        `error:SyntaxError:Traceback (most recent call last):\n  File "<exec>", line 1\nSyntaxError: invalid syntax at file:///C:/Users/someone/x.mjs`,
      ),
    );
    expect(result).toMatchObject({ ok: false, reason: "syntax" });
    expect(result.stderr).toContain('File "<exec>", line 1');
    expect(result.stderr).not.toMatch(/someone|file:\/\//);
  });
});

describe("the output files", () => {
  it("returns new text files under out/", async () => {
    const result = await start().run(request("write:out/summary.csv:a,b\n1,2"));
    expect(result.outputs).toEqual([{ path: "out/summary.csv", text: "a,b\n1,2" }]);
  });

  it("skips a binary file and a file with a NUL, and names them", async () => {
    const sandbox = start();
    const binary = await sandbox.run(request("binary"));
    expect(binary.outputs).toEqual([]);
    expect(binary.stderr).toContain("[run_code] Skipped out/blob.bin: not valid UTF-8 text");
    const nul = await sandbox.run(request("nul"));
    expect(nul.outputs).toEqual([]);
    expect(nul.stderr).toContain("Skipped out/nul.txt");
  });

  it("returns only valid out/ paths and names the rest", async () => {
    const result = await start().run(request("badname"));
    expect(result.outputs).toEqual([{ path: "out/ok.txt", text: "fine" }]);
    expect(result.stderr).toContain("Skipped out/../escape.txt: not a valid file name");
    expect(result.stderr).toContain("Skipped notout.txt: not a valid file name");
  });

  it("keeps the first 20 of 25 files and names the other five", async () => {
    const result = await start().run(request("many"));
    expect(result.outputs).toHaveLength(20);
    expect(result.outputs[0]?.path).toBe("out/f00.txt");
    expect(result.stderr.match(/Skipped out\/f\d\d\.txt: more than 20 files/g)).toHaveLength(5);
  });

  it("skips a file over 2 MB", async () => {
    const result = await start().run(request("big"));
    expect(result.outputs).toEqual([]);
    expect(result.stderr).toContain("Skipped out/big.txt: larger than 2 MB");
  });

  it("saves nothing when the run failed, and says so", async () => {
    const result = await start().run(request("partial-fail"));
    expect(result).toMatchObject({ ok: false, reason: "runtime", outputs: [] });
    expect(result.stderr).toContain("none of the files it wrote were saved");
  });
});

describe("caps on what the model sees", () => {
  it("cuts stdout and stderr at 64 KB each", async () => {
    const result = await start().run(request("noise"));
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(result.stdout).toContain("Output cut at 64 KB");
    expect(result.stderr).toContain("Output cut at 64 KB");
  });
});

describe("limits on the request", () => {
  it("refuses code over 100 KB without starting anything", async () => {
    const sandbox = start();
    const before = trackedChildCount();
    const result = await sandbox.run(request("x".repeat(MAX_CODE_BYTES + 1)));
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(trackedChildCount()).toBe(before);
  });

  it("refuses more than 20 input files", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_INPUT_FILES + 1 }, (_, i) => [`f${i}.txt`, "x"]));
    expect(await start().run(request("echo", { files }))).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("refuses more than 20 MB of input", async () => {
    const files = { "a.txt": "x".repeat(11 * 1024 * 1024), "b.txt": "x".repeat(10 * 1024 * 1024) };
    expect(await start().run(request("echo", { files }))).toMatchObject({ ok: false, reason: "too_large" });
  });
});

describe("concurrency", () => {
  it("answers busy to a second run while the first holds the only slot", async () => {
    const sandbox = start({ queueWaitMs: 100 });
    const slow = sandbox.run(request("sleep:1500"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = await sandbox.run(request("echo"));
    expect(second).toMatchObject({ ok: false, reason: "busy" });
    expect((await slow).ok).toBe(true);
  });

  it("allows hosted one run at a time, whichever tenant asks", async () => {
    const sandbox = start({ serverMode: true, queueWaitMs: 100 });
    const a = sandbox.run(request("sleep:1200", { tenantId: "tenant-a" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const b = await sandbox.run(request("echo", { tenantId: "tenant-b" }));
    expect(b.reason).toBe("busy");
    expect((await a).ok).toBe(true);
  });

  it("allows hosted tenants the configured runs, capped per tenant and in all", async () => {
    const sandbox = start({ serverMode: true, maxRuns: 2, maxPerTenant: 1, hostedWarmTotal: 2, queueWaitMs: 100 });
    const a = sandbox.run(request("sleep:1200", { tenantId: "tenant-a" }));
    const b = sandbox.run(request("sleep:1200", { tenantId: "tenant-b" }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const c = await sandbox.run(request("echo", { tenantId: "tenant-c" }));
    const aAgain = await sandbox.run(request("echo", { tenantId: "tenant-a" }));
    expect(c.reason).toBe("busy");
    expect(aAgain.reason).toBe("busy");
    expect((await a).ok && (await b).ok).toBe(true);
  });

  it("production wiring: the pool follows AGENTFORGE_MAX_CODE_RUNS so the operator override admits the runs", async () => {
    ship = makeFakeShip();
    resetShipVerdictForTests();
    setShipDirForTests(ship.dir);
    const saved = {
      server: process.env.AGENTFORGE_SERVER,
      maxRuns: process.env.AGENTFORGE_MAX_CODE_RUNS,
    };
    process.env.AGENTFORGE_SERVER = "true";
    process.env.AGENTFORGE_MAX_CODE_RUNS = "2";
    try {
      // No injected limiter or pool: both are built from the environment, as in production.
      runner = createSandboxRunner({});
      const a = runner.run(request("sleep:1200", { tenantId: "tenant-a" }));
      const b = runner.run(request("sleep:1200", { tenantId: "tenant-b" }));
      await new Promise((resolve) => setTimeout(resolve, 800));
      // Both runs hold a child at once: before the fix the pool's one-child cap answered the second `busy`.
      expect(trackedChildCount()).toBeGreaterThanOrEqual(2);
      expect((await a).ok && (await b).ok).toBe(true);
    } finally {
      if (saved.server === undefined) {
        delete process.env.AGENTFORGE_SERVER;
      } else {
        process.env.AGENTFORGE_SERVER = saved.server;
      }
      if (saved.maxRuns === undefined) {
        delete process.env.AGENTFORGE_MAX_CODE_RUNS;
      } else {
        process.env.AGENTFORGE_MAX_CODE_RUNS = saved.maxRuns;
      }
    }
  });
});

describe("when the sandbox is not there", () => {
  it("answers unavailable when the ship directory is missing", async () => {
    const sandbox = start();
    setShipDirForTests(`${ship?.dir}-missing`);
    resetShipVerdictForTests();
    const result = await sandbox.run(request("echo"));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.stderr).not.toContain(ship?.dir ?? "?");
  });

  it("answers unavailable, naming no file, when a pinned file was tampered with", async () => {
    const sandbox = start();
    appendFileSync(ship?.pinnedFile ?? "", " ");
    const result = await sandbox.run(request("echo"));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.stderr).not.toMatch(/pyodide-lock|MANIFEST|sha256/i);
  });

  it("answers unavailable for a language the ship does not carry", async () => {
    const sandbox = start({ ship: { manifest: "none" } });
    expect(await sandbox.run(request("echo", { language: "python" }))).toMatchObject({ reason: "unavailable" });
    expect(await sandbox.run(request("echo", { language: "javascript" }))).toMatchObject({ ok: true });
  });

  it.each(["fatal", "exit"] as const)("answers unavailable when the child cannot boot (%s)", async (boot) => {
    const result = await start({ ship: { boot } }).run(request("echo"));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("gives up on a child that never says ready, after the boot timeout", async () => {
    const started = Date.now();
    const result = await start({ ship: { boot: "hang" }, bootTimeoutMs: 600 }).run(request("echo"));
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
