/**
 * The command itself, run as a child process the way the integration worker will run it, against a fake host in
 * this process on a loopback port, at real time. Nothing here touches port 3000 or 3200.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realClock } from "./clock";
import { type FakeBehavior, type FakeHost, startFakeHost } from "./fake-host";
import type { VoiceRunFile } from "./report";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.ts");
const run = promisify(execFile);

type Finished = { code: number; stdout: string; stderr: string };

async function runCommand(args: string[]): Promise<Finished> {
  const env = { ...process.env };
  env.AGENTFORGE_VOICE_EVAL_COOKIE = undefined;
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", RUN, ...args], { cwd: HERE, env, timeout: 90_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

let folder: string;
const hosts: FakeHost[] = [];

async function boot(behavior: Partial<FakeBehavior> = {}): Promise<FakeHost> {
  const host = await startFakeHost({ clock: realClock, behavior });
  hosts.push(host);
  return host;
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "voice-eval-test-"));
});

afterAll(async () => {
  await Promise.all(hosts.map((host) => host.close()));
  await rm(folder, { recursive: true, force: true });
});

describe("the command line", () => {
  it("refuses port 3000 and port 3200 before it makes any request", async () => {
    for (const url of ["http://127.0.0.1:3000", "http://localhost:3200", "https://staging.example.com:3000"]) {
      const finished = await runCommand(["--base-url", url]);
      expect(finished.code, url).toBe(2);
      expect(finished.stderr).toContain("refusing to run against port");
      expect(finished.stdout).toBe("");
    }
  });

  it("needs --base-url, and prints help and the case list without a desk", async () => {
    expect((await runCommand([])).code).toBe(2);
    const help = await runCommand(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--base-url");
    expect(help.stdout).toContain("Never port 3000 or 3200");
    const list = await runCommand(["--list"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim().split("\n")).toHaveLength(14);
    expect(list.stdout).toContain("barge-in-stops");
  });

  it("stops with a clear message when voice is not enabled on the desk", async () => {
    const host = await boot({ voiceEnabled: false });
    const finished = await runCommand(["--base-url", host.base]);
    expect(finished.code).toBe(2);
    expect(finished.stderr).toContain("voice is not enabled");
    expect(finished.stderr).toContain("AGENTFORGE_VOICE=on");
    expect(host.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("stops with a clear message when nothing answers", async () => {
    const finished = await runCommand(["--base-url", "http://127.0.0.1:1"]);
    expect(finished.code).toBe(2);
    expect(finished.stderr).toContain("did not answer GET /api/v1/settings");
  });
});

describe("a run against a desk that is right", () => {
  it("prints one table, writes the result file, exits 0, and holds no words or cookies", async () => {
    const host = await boot();
    const out = join(folder, "good.json");
    const finished = await runCommand([
      "--base-url",
      host.base,
      "--case",
      "end-is-idempotent",
      "--case",
      "second-session-replaces",
      "--case",
      "upgrade-needs-origin",
      "--out",
      out,
    ]);
    expect(finished.code, finished.stderr).toBe(0);
    expect(finished.stdout).toMatch(/end-is-idempotent\s+PASS/);
    expect(finished.stdout).toMatch(/second-session-replaces\s+PASS/);
    expect(finished.stdout).toContain("3/3 passed");
    expect(finished.stdout).toContain(`result: ${out}`);
    // Four threads: second-session-replaces opens two sessions, each on its own thread.
    expect(finished.stdout).toContain("cleanup: 4 of 4 thread(s) deleted");

    const file = JSON.parse(await readFile(out, "utf8")) as VoiceRunFile;
    expect(file).toMatchObject({ format: 1, base: host.base, locale: "id", showText: false });
    expect(file.rows.map((row) => row.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(file.desk).toEqual({ model: "fake-talker", runtime: "ai", locale: "id" });
    for (const text of [finished.stdout, finished.stderr, JSON.stringify(file)]) {
      expect(text).not.toContain(host.sessionCookie);
    }
  });

  it("measures a real-time latency case end to end, with the client and host numbers side by side", async () => {
    const host = await boot();
    const out = join(folder, "latency.json");
    const finished = await runCommand(["--base-url", host.base, "--case", "latency-smalltalk", "--repeat", "1", "--out", out]);
    expect(finished.code, `${finished.stdout}\n${finished.stderr}`).toBe(0);
    expect(finished.stdout).toMatch(/latency-smalltalk\s+PASS\s+1\/1\s+client p50 \d+ \/ p90 \d+ ms \(n=1/);
    expect(finished.stdout).toMatch(/host p50 \d+ \/ p90 \d+ ms/);
    const file = JSON.parse(await readFile(out, "utf8")) as VoiceRunFile;
    const client = file.rows[0]?.numbers.clientFirstAudioMs;
    const hostMs = file.rows[0]?.numbers.hostFirstAudioMs;
    // 700 ms of silence plus 250 ms of reply delay in the fake, on a real clock.
    expect(client?.p50).toBeGreaterThan(900);
    expect(client?.p50).toBeLessThan(1_500);
    expect(Math.abs((client?.p50 ?? 0) - (hostMs?.p50 ?? 0))).toBeLessThan(150);
  }, 60_000);

  it("compares with an earlier result file", async () => {
    const host = await boot();
    const first = join(folder, "first.json");
    const second = join(folder, "second.json");
    await runCommand(["--base-url", host.base, "--case", "end-is-idempotent", "--out", first]);
    const finished = await runCommand(["--base-url", host.base, "--case", "end-is-idempotent", "--out", second, "--compare", first]);
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain(`against ${first}:`);
    expect(finished.stdout).toContain("No difference from the earlier run");
  });
});

describe("a run against a desk that is wrong", () => {
  it("exits 1 and says which check failed and why", async () => {
    const host = await boot({ endsOnceOnly: true });
    const finished = await runCommand(["--base-url", host.base, "--case", "end-is-idempotent", "--out", join(folder, "bad.json")]);
    expect(finished.code).toBe(1);
    expect(finished.stdout).toMatch(/end-is-idempotent\s+FAIL/);
    expect(finished.stdout).toContain("end-is-idempotent: failed: the second end answers 200 (HTTP 404)");
  });

  it("exits 1 for a closed gateway gate and calls the cases blocked, never passed", async () => {
    const host = await boot({ refuseH1: "gateway_blocked" });
    const finished = await runCommand(["--base-url", host.base, "--case", "end-is-idempotent", "--case", "turns-saved", "--out", join(folder, "blocked.json")]);
    expect(finished.code).toBe(1);
    expect(finished.stdout).toMatch(/end-is-idempotent\s+BLOCKED_NO_RUNTIME/);
    expect(finished.stdout).toContain("skipped and blocked cases are not passes");
    expect(finished.stdout).not.toMatch(/\bPASS\b/);
  });

  it("calls skipped cases skipped, and exits 0 because nothing failed", async () => {
    const host = await boot({ runtime: "stub" });
    const finished = await runCommand(["--base-url", host.base, "--case", "latency-fact", "--case", "end-is-idempotent", "--out", join(folder, "skip.json")]);
    expect(finished.code).toBe(0);
    expect(finished.stdout).toMatch(/latency-fact\s+SKIPPED_UNAVAILABLE/);
    expect(finished.stdout).toContain("1/2 passed, 0 failed, 1 skipped");
  });
});
