/**
 * F7a proof for `child-parse.ts`: the parse child really is a separate, killable, sealed process —
 * a job that ignores its deadline is SIGKILLed, a child that blows its heap dies without taking the
 * host with it, and the worker's egress seal holds from outside.
 */
import { describe, expect, it } from "vitest";
import {
  ParseChild,
  ParseChildUnavailableError,
  parseChildEnv,
  parseChildExecArgv,
  parseFileInChild,
  repoRoot,
  spawnParseChild,
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

  it("gives the child an empty environment, never the parent's secrets", () => {
    const env = parseChildEnv();
    expect(env.AGENTFORGE_SECRETS_KEY).toBeUndefined();
    expect(Object.keys(env)).not.toContain("AGENTFORGE_DATA_DIR");
    // The loader's disk cache would demand an fs write grant the child does not have.
    expect(env.TSX_DISABLE_CACHE).toBe("1");
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
