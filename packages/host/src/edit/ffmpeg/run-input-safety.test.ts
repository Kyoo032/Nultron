/**
 * Every ffmpeg and ffprobe run goes through `runFfmpeg`, so the input whitelist and the hosted run ceiling are
 * applied there once, and no recipe, present or future, can forget them (SR-135). The stub below is the only
 * `execFile`; `input-safety.test.ts` holds the helpers and `ffmpeg-input-safety-real.test.ts` the real binary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_RUN_CEILING_MS } from "./input-safety";
import { runFfmpeg, setExecFileForTests } from "./run";

vi.mock("../ffmpeg-binary", () => ({
  resolveFfmpeg: () => ({ found: true, path: "ffmpeg", version: "8.1.3" }),
  resolveFfprobe: () => ({ found: true, path: "ffprobe", version: "8.1.3" }),
}));

type Call = { file: string; args: string[]; timeout?: number };

function recorder(): { calls: Call[]; install: () => void } {
  const calls: Call[] = [];
  return {
    calls,
    install: () =>
      setExecFileForTests((async (file: string, args: readonly string[] | undefined, options: { timeout?: number }) => {
        calls.push({ file, args: [...(args ?? [])], timeout: options.timeout });
        return { stdout: "{}", stderr: "" };
      }) as never),
  };
}

const saved = process.env.AGENTFORGE_SERVER;

afterEach(() => {
  setExecFileForTests(null);
  if (saved === undefined) delete process.env.AGENTFORGE_SERVER;
  else process.env.AGENTFORGE_SERVER = saved;
});

describe("runFfmpeg and the input whitelist", () => {
  it("gives ffmpeg a whitelist before each of its inputs", async () => {
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-i", "a.mp4", "-i", "b.mov", "-f", "null", "-"], { timeoutMs: 5_000 });
    expect(rec.calls[0].args).toEqual([
      "-protocol_whitelist",
      "file,crypto,data",
      "-i",
      "a.mp4",
      "-protocol_whitelist",
      "file,crypto,data",
      "-i",
      "b.mov",
      "-f",
      "null",
      "-",
    ]);
  });

  it("covers the lavfi input and keeps the progress option the caller asked for", async () => {
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "out.mp4"], {
      timeoutMs: 5_000,
      onProgress: () => {},
    });
    expect(rec.calls[0].args.slice(0, 5)).toEqual(["-f", "lavfi", "-protocol_whitelist", "file,crypto,data", "-i"]);
    expect(rec.calls[0].args.slice(-3)).toEqual(["-progress", "pipe:1", "-nostats"]);
  });

  it("gives ffprobe the whitelist first", async () => {
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-v", "error", "-show_format", "clip.mp4"], { timeoutMs: 5_000, bin: "ffprobe" });
    expect(rec.calls[0].file).toBe("ffprobe");
    expect(rec.calls[0].args).toEqual([
      "-protocol_whitelist",
      "file,crypto,data",
      "-v",
      "error",
      "-show_format",
      "clip.mp4",
    ]);
  });

  it("does not let a recipe widen it", async () => {
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-protocol_whitelist", "file,http,https,tcp", "-i", "a.mp4", "o.mp4"], { timeoutMs: 5_000 });
    expect(rec.calls[0].args.join(" ")).not.toMatch(/http|tcp/);
    expect(rec.calls[0].args.filter((arg) => arg === "-protocol_whitelist")).toHaveLength(1);
  });

  it("leaves a run with no input (-version) as it was", async () => {
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-hide_banner", "-version"], { timeoutMs: 5_000 });
    expect(rec.calls[0].args).toEqual(["-hide_banner", "-version"]);
  });
});

describe("runFfmpeg and the hosted run ceiling", () => {
  it("hosted: no run outlives two hours, and a request with no usable timeout gets the ceiling, not none", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-version"], { timeoutMs: 10 ** 10 });
    await runFfmpeg(["-version"], { timeoutMs: Number.NaN });
    await runFfmpeg(["-version"], { timeoutMs: 15_000 });
    expect(rec.calls.map((call) => call.timeout)).toEqual([HOSTED_RUN_CEILING_MS, HOSTED_RUN_CEILING_MS, 15_000]);
  });

  it("a desk is left exactly as asked", async () => {
    delete process.env.AGENTFORGE_SERVER;
    const rec = recorder();
    rec.install();
    await runFfmpeg(["-version"], { timeoutMs: 10 ** 7 });
    expect(rec.calls[0].timeout).toBe(10 ** 7);
  });
});
