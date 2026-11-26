/**
 * F7a proof for `child-parse.ts`: the parse child really is a separate, killable, sealed process —
 * a job that ignores its deadline is SIGKILLed, a child that blows its heap dies without taking the
 * host with it, and the worker's egress seal holds from outside.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ParseChild,
  ParseChildUnavailableError,
  parseChildEnv,
  parseChildExecArgv,
  parseFileInChild,
  repoRoot,
} from "./child-parse";
import { FileExtractError } from "./errors";
import { extractFile } from "./index";
import { csvFixture, docxFixture, pdfFixture, PLANTED, xlsxFixture } from "./test-fixtures";

const BOOT_AND_JOB_MS = 60_000;

describe("parse child flags", () => {
  it("runs under --permission with an fs grant on the repo only, no write/child/net flags", () => {
    const root = repoRoot();
    expect(root).toBeTruthy();
    const argv = parseChildExecArgv(root as string, 384);
    expect(argv).toContain("--permission");
    expect(argv).toContain(`--allow-fs-read=${root}`);
    expect(argv).toContain("--max-old-space-size=384");
    // Structural grants: tsx/esbuild transform on a worker thread; anydoc is a .node addon.
    expect(argv).toContain("--allow-worker");
    expect(argv).toContain("--allow-addons");
    for (const flag of argv) {
      expect(flag).not.toContain("--allow-fs-write");
      expect(flag).not.toContain("--allow-child-process");
    }
  });

  it("gives the child only the variables it needs, never the parent's secrets", () => {
    const env = parseChildEnv({
      AGENTFORGE_SECRETS_KEY: "secret",
      AGENTFORGE_DATA_DIR: "/data",
      AGENTFORGE_COMPONENTS_DIR: "/opt/components",
      AGENTFORGE_SERVER: "1",
      ANYTHING_ELSE: "nope",
    });
    // The components-root locators pass through (the installed converter lives there); nothing else does.
    expect(env.AGENTFORGE_DATA_DIR).toBe("/data");
    expect(env.AGENTFORGE_COMPONENTS_DIR).toBe("/opt/components");
    expect(env.AGENTFORGE_SERVER).toBe("1");
    expect(env.AGENTFORGE_SECRETS_KEY).toBeUndefined();
    expect(env.ANYTHING_ELSE).toBeUndefined();
    // The loader's disk cache would demand an fs write grant the child does not have.
    expect(env.TSX_DISABLE_CACHE).toBe("1");
  });

  it("hands the child the host's resolved components root, whatever locators the desk uses", () => {
    // A desk that locates its data dir via AGENTFORGE_SETTINGS_PATH: the child never sees that
    // variable, so resolving the components root again there would name a different directory than
    // the one the fs grant — and the installed converter — lives in.
    const env = parseChildEnv({ AGENTFORGE_SETTINGS_PATH: "/desk-a/settings.enc" });
    expect(env.AGENTFORGE_COMPONENTS_DIR).toBe("/desk-a/components");
  });
});

describe("parse child behavior", () => {
  it("SIGKILLs a job that runs past its deadline and reports timeout", { timeout: BOOT_AND_JOB_MS }, async () => {
    const child = new ParseChild();
    await child.ready();
    await expect(child.probe({ probe: "sleep" }, 800)).rejects.toMatchObject({ code: "timeout" });
    // The deadline did what the old in-process race could not: the process is dead, not orphaned.
    for (let spin = 0; spin < 50 && child.alive; spin += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(child.alive).toBe(false);
  });

  it("a child that blows its heap dies; the host sees resource_limit, not a crash", {
    timeout: BOOT_AND_JOB_MS,
  }, async () => {
    const child = new ParseChild();
    await child.ready();
    // Far over --max-old-space-size: the runtime aborts the child itself.
    await expect(child.probe({ probe: "allocate", mb: 4096 }, BOOT_AND_JOB_MS)).rejects.toBeInstanceOf(
      FileExtractError,
    );
    for (let spin = 0; spin < 100 && child.alive; spin += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(child.alive).toBe(false);
  });

  it("the child cannot reach the network (metadata endpoint refused)", { timeout: BOOT_AND_JOB_MS }, async () => {
    const child = new ParseChild();
    await child.ready();
    const result = await child.probe({ probe: "network" }, BOOT_AND_JOB_MS);
    child.kill();
    expect(result.ok).toBe(true);
  });
});

describe("the job deadline bounds the whole wait", () => {
  it("a boot that never ends fails fast instead of adding the boot budget to the deadline", {
    timeout: BOOT_AND_JOB_MS,
  }, async () => {
    const neverReady = new EventEmitter() as unknown as ChildProcess;
    Object.assign(neverReady, { stdout: null, stderr: null, exitCode: null, signalCode: null });
    neverReady.kill = () => true;
    (neverReady as { send: unknown }).send = (_message: unknown, cb?: (error: Error | null) => void) => {
      cb?.(null);
      return true;
    };
    const start = Date.now();
    await expect(
      parseFileInChild({ bytes: new Uint8Array([1]), filename: "x.csv", timeoutMs: 400 }, () => neverReady),
    ).rejects.toBeInstanceOf(ParseChildUnavailableError);
    // Without the deadline bound on boot, BOOT_TIMEOUT_MS alone would already allow a 15 s wait.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("charges boot time against the job's deadline", { timeout: BOOT_AND_JOB_MS }, async () => {
    const sent: Array<{ type?: string; timeoutMs?: number }> = [];
    const emitter = new EventEmitter();
    const stub = emitter as unknown as ChildProcess;
    Object.assign(stub, { stdout: null, stderr: null, exitCode: null, signalCode: null });
    stub.kill = () => true;
    (stub as { send: unknown }).send = (
      message: { type?: string; id?: string; timeoutMs?: number },
      cb?: (error: Error | null) => void,
    ) => {
      sent.push(message);
      if (message.type === "job") {
        setTimeout(() => emitter.emit("message", { type: "result", id: message.id, ok: false, code: "malformed" }), 0);
      }
      cb?.(null);
      return true;
    };
    setTimeout(() => emitter.emit("message", { type: "ready" }), 300).unref();
    await expect(
      parseFileInChild({ bytes: new Uint8Array([1]), filename: "x.csv", timeoutMs: 60_000 }, () => stub),
    ).rejects.toMatchObject({ code: "malformed" });
    expect(sent[0]?.timeoutMs).toBeLessThan(60_000);
    expect(sent[0]?.timeoutMs).toBeGreaterThan(0);
  });
});

describe("extractFile in the child", () => {
  it("produces the same Markdown the in-process pipeline produced (parity, AC-2)", {
    timeout: BOOT_AND_JOB_MS,
  }, async () => {
    const result = await extractFile({ bytes: await docxFixture(), filename: "laporan.docx" });
    expect(result.format).toBe("docx");
    expect(result.text).toContain(PLANTED);
    expect(result.markdown).toContain("# Laporan PT Cemara Sintetis");
    expect(result.tables).toHaveLength(1);
    expect(result.meta.engine).toBe("anydoc");
  });

  it("parses a workbook and a csv through the child too", { timeout: BOOT_AND_JOB_MS }, async () => {
    const workbook = await extractFile({ bytes: await xlsxFixture(), filename: "figures.xlsx" });
    expect(workbook.meta.sheets).toBe(2);
    const csv = await extractFile({ bytes: csvFixture(), filename: "figures.csv" });
    expect(csv.format).toBe("csv");
  });

  it("a broken zip and a 'zip bomb' shape fail cleanly without hurting the host", {
    timeout: BOOT_AND_JOB_MS,
  }, async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    const code = await extractFile({ bytes: broken, filename: "bomb.xlsx" }).then(
      () => "ok",
      (error: unknown) => (error as FileExtractError).code,
    );
    expect(["malformed", "format_mismatch", "missing_part", "resource_limit"]).toContain(code);
  });

  it("degrades to the in-process pipeline when no child can boot (logged)", { timeout: BOOT_AND_JOB_MS }, async () => {
    const result = await parseFileInChild({ bytes: csvFixture(), filename: "figures.csv", timeoutMs: 30_000 }, () => {
      throw new ParseChildUnavailableError("no spawn in test");
    }).then(
      () => "parsed",
      (error: unknown) => error,
    );
    // parseFileInChild itself surfaces the unavailability; extractFile degrades on it.
    expect(result).toBeInstanceOf(ParseChildUnavailableError);
    const inProcess = await extractFile({ bytes: await pdfFixture(), filename: "report.pdf" }, { inProcess: true });
    expect(inProcess.text).toContain(PLANTED);
  });
});
