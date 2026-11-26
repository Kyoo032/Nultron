/**
 * The real engines: Pyodide (numpy, pandas) and QuickJS in hardened child processes. Slow (a cold Python
 * start is 11 to 25 s) and it needs the ship directory, so it only runs when AGENTFORGE_SANDBOX_DIR points
 * at one:
 *
 *   AGENTFORGE_SANDBOX_DIR=<ship dir> npx vitest run src/code-runner/sandbox.integration.test.ts
 *
 * Without the variable the whole file is reported as skipped, with this explanation, and nothing else in
 * the suite depends on it. It proves what the fake child cannot: the file round trip with pandas, a
 * fresh namespace in a warm child, the wall-clock kill, the memory cap, and every escape of the
 * 2026-10-03 prototype matrix refused.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeLanguage } from "@agentforge/core";
import { killTrackedChildren } from "../child-processes";
import { createSandboxRunner, type SandboxRunner, type SandboxRunRequest } from "./run-code";
import { resetShipVerdictForTests, setShipDirForTests } from "./ship";

const SHIP = process.env.AGENTFORGE_SANDBOX_DIR?.trim();
const suite = SHIP ? describe : describe.skip;
const LONG = 180_000;
const PARENT_SECRET = "parent-secret-must-not-reach-the-guest-7f3a";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

const request = (
  language: CodeLanguage,
  code: string,
  files: Record<string, string> = {},
  workspaceId = "it-desk",
): SandboxRunRequest => ({ tenantId: "it-tenant", workspaceId, language, code, files });

type Listener = { port: number; hits: string[]; close(): Promise<void> };

async function listen(): Promise<Listener> {
  const hits: string[] = [];
  const server = net.createServer((socket) => {
    hits.push("TCP");
    socket.on("data", (chunk) => hits.push(String(chunk).split("\r\n")[0] ?? ""));
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** `E01 | label | blocked: ...` lines of the escape batteries, keyed by id. */
function parseBattery(stdout: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Z]\d+[a-z]?) \| .* \| (blocked|ESCAPED)/.exec(line);
    if (match?.[1] && match[2]) {
      rows.set(match[1], match[2]);
    }
  }
  return rows;
}

suite("the real sandbox (Pyodide and QuickJS)", { timeout: LONG }, () => {
  let runner: SandboxRunner;
  let listener: Listener;
  const savedSecret = process.env.WRAP_KEY_TEST;

  beforeAll(async () => {
    process.env.WRAP_KEY_TEST = PARENT_SECRET;
    process.env.AGENTFORGE_SECRETS_KEY = PARENT_SECRET;
    setShipDirForTests(null);
    resetShipVerdictForTests();
    listener = await listen();
    runner = createSandboxRunner();
  });

  afterAll(async () => {
    runner.shutdown();
    killTrackedChildren("SIGKILL");
    await listener.close();
    delete process.env.AGENTFORGE_SECRETS_KEY;
    if (savedSecret === undefined) {
      delete process.env.WRAP_KEY_TEST;
    } else {
      process.env.WRAP_KEY_TEST = savedSecret;
    }
  });

  describe("Python", () => {
    it("starts cold, reads a desk file with pandas and writes a result back", async () => {
      const started = Date.now();
      const result = await runner.run(
        request(
          "python",
          [
            "import os",
            "import pandas as pd",
            "df = pd.read_csv('data.csv')",
            "os.makedirs('/workspace/out', exist_ok=True)",
            "df.describe().to_csv('/workspace/out/summary.csv')",
            "print('mean b =', df.b.mean())",
          ].join("\n"),
          { "data.csv": "a,b\n1,2\n3,4\n" },
        ),
      );
      console.info(`python cold start + pandas round trip: ${Date.now() - started} ms`);
      expect(result.stderr).toBe("");
      expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining("mean b = 3.0") });
      expect(result.outputs.map((file) => file.path)).toEqual(["out/summary.csv"]);
      expect(result.outputs[0]?.text).toContain("mean,2.0,3.0");
    });

    it("answers the next run from the warm child, in a fresh namespace and an empty /workspace", async () => {
      await runner.run(
        request("python", "leaked = 5\nopen('/workspace/leftover.txt', 'w').write('hi')\nprint('partial', end='')"),
      );
      const started = Date.now();
      const result = await runner.run(
        request("python", "import os\nprint('leaked' in globals(), sorted(os.listdir('/workspace')), __name__)"),
      );
      console.info(`python warm run: ${Date.now() - started} ms`);
      expect(result.stdout).toBe("False [] __main__");
      expect(result.ok).toBe(true);
    });

    it("shows the value of the last expression, and nested input paths work", async () => {
      const result = await runner.run(
        request("python", "open('/workspace/notes/plan.md').read().upper()", { "notes/plan.md": "go" }),
      );
      expect(result).toMatchObject({ ok: true, stdout: "GO" });
    });

    it("leaves a file the run did not change out of the outputs", async () => {
      const result = await runner.run(
        request("python", "print(open('/workspace/out/old.txt').read())", { "out/old.txt": "from an earlier run" }),
      );
      expect(result.outputs).toEqual([]);
    });

    it("classifies a syntax error and hides the interpreter's own frames", async () => {
      const result = await runner.run(request("python", "def f(:\n  pass"));
      expect(result).toMatchObject({ ok: false, reason: "syntax" });
      expect(result.stderr).toContain("SyntaxError");
      expect(result.stderr).toContain('File "<exec>"');
      expect(result.stderr).not.toMatch(/_pyodide|python3\d+\.zip/);
    });

    it("classifies a runtime error and keeps the child warm", async () => {
      const result = await runner.run(request("python", "def f():\n    return 1 / 0\nf()"));
      expect(result).toMatchObject({ ok: false, reason: "runtime" });
      expect(result.stderr).toContain("ZeroDivisionError: division by zero");
      expect(result.outputs).toEqual([]);
      const after = await runner.run(request("python", "print('still here')"));
      expect(after.stdout).toBe("still here");
    });

    it("skips a binary output, an oversize output and extra files, and names them", async () => {
      const result = await runner.run(
        request(
          "python",
          [
            "import os",
            "os.makedirs('/workspace/out', exist_ok=True)",
            "open('/workspace/out/blob.bin', 'wb').write(bytes([255, 254, 0, 1]))",
            "open('/workspace/out/huge.txt', 'w').write('x' * (3 * 1024 * 1024))",
            "for i in range(22):",
            "    open(f'/workspace/out/f{i:02d}.txt', 'w').write(str(i))",
          ].join("\n"),
        ),
      );
      expect(result.ok).toBe(true);
      expect(result.outputs).toHaveLength(20);
      expect(result.stderr).toContain("Skipped out/blob.bin: not valid UTF-8 text");
      expect(result.stderr).toContain("Skipped out/huge.txt: larger than 2 MB");
      expect(result.stderr).toContain("more than 20 files");
    });

    it("answers too_large when the run leaves more than 64 MB in /workspace", async () => {
      const result = await runner.run(
        request(
          "python",
          "import os\nos.makedirs('/workspace/out', exist_ok=True)\nopen('/workspace/out/big.dat', 'wb').write(b'x' * (70 * 1024 * 1024))",
        ),
      );
      expect(result).toMatchObject({ ok: false, reason: "too_large", outputs: [] });
    });

    it("treats sys.exit, exit() and os._exit as the end of the run, not of the child", async () => {
      const before = await runner.run(request("python", "import os\nprint(os.getpid())"));
      const exits: Array<[string, boolean, string]> = [
        ["import sys\nsys.exit(3)", false, "SystemExit: 3"],
        ["raise SystemExit(2)", false, "SystemExit: 2"],
        ["import sys\nsys.exit('bad input')", false, "bad input"],
        ["import sys\nprint('before')\nsys.exit(0)", true, ""],
        ["exit()", true, ""],
        ["import os\nos._exit(0)", true, ""],
      ];
      for (const [code, ok, note] of exits) {
        const result = await runner.run(request("python", code));
        expect(result.ok, code).toBe(ok);
        expect(result.stderr, code).toContain(note);
        if (!ok) {
          expect(result.reason, code).toBe("runtime");
        }
      }
      const after = await runner.run(request("python", "import os\nprint(os.getpid())"));
      expect(after.stdout).toBe(before.stdout);
    });

    it("does not hand the parent's environment to the guest", async () => {
      const result = await runner.run(request("python", "import os\nprint(sorted(os.environ.items()))"));
      expect(result.stdout).not.toContain(PARENT_SECRET);
      expect(result.stdout).not.toMatch(/AGENTFORGE|WRAP_KEY/);
    });
  });

  describe("every escape of the prototype matrix is refused", () => {
    // Blocked rows of the final matrix (docs/internal/mode-harness-tools-plan.md, Appendix A2). The rows that
    // report only that an internal handle exists (E03b, E04, E04b, B00, B01b) say nothing about reach.
    const MUST_BE_BLOCKED = [
      "E01",
      "E02",
      "E03",
      "E05",
      "E05b",
      "E05c",
      "E06",
      "E06b",
      "E06c",
      "E06d",
      "E08",
      "E09",
      "E10",
      "E10b",
      "E11",
      "E11b",
      "E13",
      "E15b",
      "E16",
      "E17",
      "E20",
      "E21",
      "A01",
      "A02",
      "A03",
      "A04",
      "A05",
      "A06",
      "B01",
      "B03",
      "B05",
    ];

    it("blocks the synchronous battery: js.process, run_js, Function-constructor imports, sockets, host files, mountNodeFS", async () => {
      const skipSystem = 'lambda: os.system("whoami")';
      const replaced = fixture("escape-battery.py")
        .replaceAll("__LISTENER_PORT__", String(listener.port))
        .replace(skipSystem, 'lambda: (_ for _ in ()).throw(RuntimeError("os.system is tested on its own below"))');
      const result = await runner.run(request("python", replaced));
      expect(result.ok, result.stderr).toBe(true);
      const rows = parseBattery(result.stdout);
      expect(rows.size).toBeGreaterThan(25);
      const escaped = MUST_BE_BLOCKED.filter((id) => rows.get(id) === "ESCAPED");
      expect(escaped).toEqual([]);
      expect(result.stdout).not.toContain(PARENT_SECRET);
    });

    it("blocks the asynchronous battery: pyfetch, loadPackage(url), Function-constructor import of node:fs and node:net", async () => {
      const result = await runner.run(
        request("python", fixture("escape-battery-async.py").replaceAll("__LISTENER_PORT__", String(listener.port))),
      );
      expect(result.ok, result.stderr).toBe(true);
      const rows = parseBattery(result.stdout);
      const escaped = MUST_BE_BLOCKED.filter((id) => rows.get(id) === "ESCAPED");
      expect(escaped).toEqual([]);
      expect(rows.get("A01")).toBe("blocked");
      expect(rows.get("A03")).toBe("blocked");
      expect(rows.get("B05")).toBe("blocked");
    });

    it("reached the loopback listener zero times", () => {
      expect(listener.hits).toEqual([]);
    });

    it("stops a program that calls os.system: the permission model ends the child, the model gets a fixed sentence", async () => {
      const result = await runner.run(request("python", "import os\nos.system('whoami')\nprint('after system')"));
      expect(result).toMatchObject({ ok: false, reason: "runtime" });
      expect(result.stderr).toContain("not allowed");
      expect(result.stdout).not.toContain("after system");
      expect(result.stderr).not.toMatch(/ERR_ACCESS_DENIED|--allow-child-process|node:internal/);
      const after = await runner.run(request("python", "print('new child works')"));
      expect(after.stdout).toBe("new child works");
    });

    it("cannot import a host module or a process from JavaScript either", async () => {
      const result = await runner.run(
        request(
          "javascript",
          [
            "const seen = [typeof require, typeof process, typeof fetch, typeof WebSocket, typeof globalThis.process];",
            "try { seen.push(typeof Function('return this')().process); } catch (e) { seen.push('Function:' + e.name); }",
            "try { seen.push(eval('typeof process')); } catch (e) { seen.push('eval:' + e.name); }",
            "seen.join(',')",
          ].join("\n"),
        ),
      );
      expect(result.ok).toBe(true);
      expect(result.stdout).not.toMatch(/object|function/);
      expect(result.stdout).toContain("undefined");
    });
  });

  describe("limits", () => {
    it("kills a Python infinite loop at the wall clock and boots a fresh child afterwards", async () => {
      const short = createSandboxRunner({ runTimeoutMs: 5000 });
      try {
        await short.run(request("python", "print('boot')", {}, "limits-desk"));
        const started = Date.now();
        const stuck = await short.run(request("python", "while True: pass", {}, "limits-desk"));
        const took = Date.now() - started;
        console.info(`python infinite loop killed after ${took} ms`);
        expect(stuck).toMatchObject({ ok: false, reason: "timeout" });
        expect(took).toBeLessThan(9000);
        const after = await short.run(request("python", "print('alive')", {}, "limits-desk"));
        expect(after).toMatchObject({ ok: true, stdout: "alive" });
      } finally {
        short.shutdown();
      }
    });

    it("stops a Python memory bomb at the 256 MB wasm cap", async () => {
      const result = await runner.run(
        request("python", "a = []\nwhile True:\n    a.append(bytearray(10**7))", {}, "bomb-desk"),
      );
      expect(result).toMatchObject({ ok: false, reason: "memory" });
      expect(result.stderr).toContain("more memory than the sandbox allows");
    });

    it("keeps a Python MemoryError the guest catches an ordinary result", async () => {
      const result = await runner.run(
        request(
          "python",
          "a = []\ntry:\n    while True:\n        a.append(bytearray(10**7))\nexcept MemoryError:\n    print('caught', len(a) * 10, 'MB')",
          {},
          "bomb-desk",
        ),
      );
      expect(result.stdout).toMatch(/^caught \d+ MB$/);
    });
  });

  describe("JavaScript", () => {
    const js = (code: string, files: Record<string, string> = {}) =>
      runner.run(request("javascript", code, files, "js-desk"));

    it("runs, logs and shows the last value", async () => {
      expect(await js("console.log('hi'); [1, 2, 3].map((n) => n * 2)")).toMatchObject({
        ok: true,
        stdout: "hi\n[2,4,6]",
      });
    });

    it("reads desk files and writes outFiles back as out/<name>", async () => {
      const result = await js(
        [
          "const rows = files['data.csv'].trim().split(String.fromCharCode(10)).slice(1).map((l) => l.split(',').map(Number));",
          "outFiles['sum.txt'] = String(rows.reduce((a, [x, y]) => a + x + y, 0));",
          "outFiles['out/second.txt'] = 'two';",
          "rows.length",
        ].join("\n"),
        { "data.csv": "a,b\n1,2\n3,4\n" },
      );
      expect(result).toMatchObject({ ok: true, stdout: "2" });
      expect(result.outputs).toEqual([
        { path: "out/second.txt", text: "two" },
        { path: "out/sum.txt", text: "10" },
      ]);
    });

    it("starts every run in a fresh context", async () => {
      await js("globalThis.leaked = 1; outFiles['a.txt'] = 'a'");
      const result = await js("typeof globalThis.leaked + ' ' + Object.keys(outFiles).length");
      expect(result.stdout).toBe("undefined 0");
    });

    it("classifies syntax and runtime errors", async () => {
      expect(await js("function (")).toMatchObject({ ok: false, reason: "syntax" });
      const failed = await js("null.x");
      expect(failed).toMatchObject({ ok: false, reason: "runtime" });
      expect(failed.stderr).toContain("TypeError");
    });

    it("stops an infinite loop at its deadline", async () => {
      const short = createSandboxRunner({ runTimeoutMs: 4000 });
      try {
        const started = Date.now();
        const result = await short.run(request("javascript", "while (true) {}", {}, "js-loop"));
        console.info(`javascript infinite loop stopped after ${Date.now() - started} ms`);
        expect(result).toMatchObject({ ok: false, reason: "timeout" });
        expect(Date.now() - started).toBeLessThan(8000);
      } finally {
        short.shutdown();
      }
    });

    it("kills a native hang the interrupt handler cannot reach, at the wall clock", async () => {
      const short = createSandboxRunner({ runTimeoutMs: 4000 });
      try {
        const result = await short.run(
          request("javascript", "const a = []; a[4294967294] = 1; a.sort(); 1", {}, "js-hang"),
        );
        expect(result).toMatchObject({ ok: false, reason: "timeout" });
      } finally {
        short.shutdown();
      }
    });

    it("stops a memory bomb", async () => {
      const result = await js("const a = []; while (true) a.push(new Array(1000).fill(1))");
      expect(result).toMatchObject({ ok: false, reason: "memory" });
    });

    it("survives deep recursion and keeps working", async () => {
      const result = await js("function f(n) { return f(n + 1) + 1 } try { f(0) } catch (e) { 'caught ' + e.message }");
      expect(result).toMatchObject({ ok: true, stdout: "caught stack overflow" });
      expect(await js("1 + 1")).toMatchObject({ ok: true, stdout: "2" });
    });

    it("runs thirty runs in a row in one warm child without growing", async () => {
      for (let i = 0; i < 30; i += 1) {
        const result = await js(
          `const a = []; for (let i = 0; i < 10000; i++) a.push({ i }); outFiles['n.txt'] = String(a.length); a.length`,
        );
        expect(result).toMatchObject({ ok: true, stdout: "10000" });
      }
    });
  });
});
