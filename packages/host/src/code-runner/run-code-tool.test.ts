/**
 * `run_code` end to end on the host side: desk files in, a sandbox run, desk files out. Most cases use a
 * recording runner so the desk logic is tested alone; two drive the real runner against the fake child.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTool,
  LOCAL_TENANT_ID,
  resetToolRegistry,
  wrappingKeyFromSecret,
  type TenantContext,
} from "@agentforge/core";
import { FileRootError, type DeskPath, type FileAuthor, type FileRoot } from "@agentforge/core/tools/files";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import { killTrackedChildren, trackedChildCount } from "../child-processes";
import { createDeskFileStore, type DeskFileStore } from "../desk-files/file-store";
import { type FakeShip, makeFakeShip } from "./__fixtures__/fake-ship";
import {
  registerCodeTools,
  RUN_CODE_DESCRIPTION,
  runCodeForTenant,
  runCodeTool,
  setCodeToolFileAccessForTests,
} from "./run-code-tool";
import { type SandboxRunRequest, type SandboxRunResult, setSandboxRunnerForTests } from "./run-code";
import { resetShipVerdictForTests, setShipDirForTests } from "./ship";

const KEY = wrappingKeyFromSecret("d".repeat(64));
const agent: FileAuthor = { kind: "agent", runId: "run-7", mode: "chat" };
const person: FileAuthor = { kind: "user", userId: "user-1" };
const path = (value: string): DeskPath => value as DeskPath;

const tenant = (): TenantContext => ({
  tenantId: LOCAL_TENANT_ID,
  organizationId: "org",
  workspaceId: `desk-${crypto.randomUUID()}`,
  userId: "local",
  role: "owner",
});

let db: Database.Database;
let store: DeskFileStore;
let desk: TenantContext;
let root: FileRoot;
let requests: SandboxRunRequest[];
let ship: FakeShip | null = null;

function useRunner(reply: (request: SandboxRunRequest) => SandboxRunResult): void {
  setSandboxRunnerForTests({
    run: async (request) => {
      requests.push(request);
      return reply(request);
    },
    shutdown: () => undefined,
  });
}

const done = (patch: Partial<SandboxRunResult> = {}): SandboxRunResult => ({
  ok: true,
  stdout: "",
  stderr: "",
  outputs: [],
  ...patch,
});

beforeEach(() => {
  db = new Database(":memory:");
  ensureSchema(db);
  store = createDeskFileStore(db, () => KEY);
  desk = tenant();
  root = store.createDeskRoot(desk, person);
  requests = [];
  setCodeToolFileAccessForTests(async () => ({ root: store.createDeskRoot(desk, agent), author: agent }));
});

afterEach(async () => {
  setSandboxRunnerForTests(null);
  setCodeToolFileAccessForTests(null);
  killTrackedChildren("SIGKILL");
  const deadline = Date.now() + 10_000;
  while (trackedChildCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  setShipDirForTests(null);
  resetShipVerdictForTests();
  await ship?.cleanup();
  ship = null;
  db.close();
});

describe("the tool definition", () => {
  it("is keyed run_code, trusted as user content, and registers", () => {
    expect(runCodeTool.key).toBe("run_code");
    expect(runCodeTool.trust).toBe("user_content");
    resetToolRegistry();
    registerCodeTools();
    expect(getTool("run_code")).toBe(runCodeTool);
    resetToolRegistry();
  });

  it("tells the model what it can use and what it cannot", () => {
    for (const phrase of [
      "pandas",
      "numpy",
      "no network",
      "/workspace/out/",
      'outFiles["<name>"]',
      "files",
      "64 KB",
      "100 KB",
      "30 seconds",
      "256 MB",
      "about 20 seconds",
      "timeout, memory, syntax, runtime, too_large, busy or unavailable",
    ]) {
      expect(RUN_CODE_DESCRIPTION.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(runCodeTool.description).toBe(RUN_CODE_DESCRIPTION);
  });

  it("accepts the documented arguments and nothing else", () => {
    const ok = runCodeTool.schema.safeParse({ language: "python", code: "print(1)", files: ["a.csv"] });
    expect(ok.success).toBe(true);
    expect(runCodeTool.schema.safeParse({ language: "javascript", code: "1" }).success).toBe(true);
    expect(runCodeTool.schema.safeParse({ language: "ruby", code: "1" }).success).toBe(false);
    expect(runCodeTool.schema.safeParse({ language: "python", code: "1", timeout: 999 }).success).toBe(false);
    expect(
      runCodeTool.schema.safeParse({ language: "python", code: "1", files: Array(21).fill("a.csv") }).success,
    ).toBe(false);
    expect(runCodeTool.schema.safeParse({ language: "python" }).success).toBe(false);
  });
});

describe("desk files in", () => {
  it("copies each named desk file into the run under its own path", async () => {
    await root.write(path("data.csv"), "a,b\n1,2\n", person);
    await root.write(path("notes/plan.md"), "# plan", person);
    useRunner(() => done({ stdout: "ok" }));
    const result = await runCodeForTenant(
      { language: "python", code: "print(1)", files: ["data.csv", "notes/plan.md", "data.csv"] },
      desk,
    );
    expect(result).toEqual({ ok: true, stdout: "ok", stderr: "", filesWritten: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tenantId: desk.tenantId,
      workspaceId: desk.workspaceId,
      language: "python",
      files: { "data.csv": "a,b\n1,2\n", "notes/plan.md": "# plan" },
    });
  });

  it.each(["../secret.txt", "/etc/hosts", "C:\\Windows\\win.ini", "a//b", ""])(
    "refuses the path %j without running anything",
    async (bad) => {
      useRunner(() => done());
      const result = await runCodeForTenant({ language: "python", code: "1", files: [bad] }, desk);
      expect(result).toMatchObject({ ok: false, reason: "runtime", filesWritten: [] });
      expect(result.stderr).toContain("[run_code] Input file");
      expect(requests).toHaveLength(0);
    },
  );

  it("answers a missing file as a refusal, without running", async () => {
    useRunner(() => done());
    const result = await runCodeForTenant({ language: "python", code: "1", files: ["nope.csv"] }, desk);
    expect(result).toMatchObject({ ok: false, reason: "runtime" });
    expect(result.stderr).toContain('Input file "nope.csv": No file at that path.');
    expect(requests).toHaveLength(0);
  });

  it("does not see another desk's file", async () => {
    await root.write(path("data.csv"), "mine", person);
    const other = tenant();
    useRunner(() => done());
    setCodeToolFileAccessForTests(async () => ({ root: store.createDeskRoot(other, agent), author: agent }));
    const result = await runCodeForTenant({ language: "python", code: "1", files: ["data.csv"] }, other);
    expect(result).toMatchObject({ ok: false, reason: "runtime" });
    expect(requests).toHaveLength(0);
  });

  it("refuses inputs larger than 20 MB together", async () => {
    useRunner(() => done());
    const big = "x".repeat(1_900_000);
    for (let i = 0; i < 12; i += 1) {
      await root.write(path(`big${i}.txt`), big, person);
    }
    const files = Array.from({ length: 12 }, (_, i) => `big${i}.txt`);
    const result = await runCodeForTenant({ language: "python", code: "1", files }, desk);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
    expect(requests).toHaveLength(0);
  });

  it("does not touch the desk at all for a run with no files and no outputs", async () => {
    let touched = false;
    setCodeToolFileAccessForTests(async () => {
      touched = true;
      return { root, author: agent };
    });
    useRunner(() => done({ stdout: "3" }));
    await runCodeForTenant({ language: "javascript", code: "1+2" }, desk);
    expect(touched).toBe(false);
  });
});

describe("desk files out", () => {
  it("saves each output as an agent version and lists the versions", async () => {
    useRunner(() =>
      done({
        outputs: [
          { path: "out/summary.csv", text: "mean\n3\n" },
          { path: "out/notes/a.txt", text: "hi" },
        ],
      }),
    );
    const result = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(result).toEqual({
      ok: true,
      stdout: "",
      stderr: "",
      filesWritten: [
        { path: "out/summary.csv", version: 1 },
        { path: "out/notes/a.txt", version: 1 },
      ],
    });
    expect((await root.read(path("out/summary.csv"))).text).toBe("mean\n3\n");
    const versions = await store.listVersions(desk, path("out/summary.csv"));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ authorKind: "agent", authorId: "run-7", mode: "chat" });
  });

  it("adds a version when a later run changes the file, and none when it does not", async () => {
    let text = "v1";
    useRunner(() => done({ outputs: [{ path: "out/r.txt", text }] }));
    await runCodeForTenant({ language: "python", code: "1" }, desk);
    text = "v2";
    const second = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(second.filesWritten).toEqual([{ path: "out/r.txt", version: 2 }]);
    const third = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(third.filesWritten).toEqual([{ path: "out/r.txt", version: 2 }]);
    expect((await store.listVersions(desk, path("out/r.txt"))).map((v) => v.version)).toEqual([1, 2]);
  });

  it("writes nothing and says why when the run failed", async () => {
    useRunner(() => done({ ok: false, reason: "runtime", stderr: "boom", outputs: [] }));
    const result = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(result).toEqual({ ok: false, stdout: "", stderr: "boom", filesWritten: [], reason: "runtime" });
    expect(await root.list(null)).toEqual([]);
  });

  it("reports a refused save, keeps going with the other files and marks the run not ok", async () => {
    const refusing: FileRoot = {
      ...root,
      write: async (target, content, by) => {
        if (target === "out/b.txt") {
          throw new FileRootError("quota", "This account has no storage space left.");
        }
        return root.write(target, content, by);
      },
    };
    setCodeToolFileAccessForTests(async () => ({ root: refusing, author: agent }));
    useRunner(() =>
      done({
        outputs: [
          { path: "out/a.txt", text: "a" },
          { path: "out/b.txt", text: "b" },
          { path: "out/c.txt", text: "c" },
        ],
      }),
    );
    const result = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_large");
    expect(result.filesWritten.map((f) => f.path)).toEqual(["out/a.txt", "out/c.txt"]);
    expect(result.stderr).toContain("[run_code] Could not save out/b.txt: This account has no storage space left.");
  });

  it("answers unavailable, not an exception, when the desk cannot be opened", async () => {
    setCodeToolFileAccessForTests(async () => {
      throw new Error("database is locked at C:\\secret\\db.sqlite");
    });
    useRunner(() => done({ outputs: [{ path: "out/a.txt", text: "a" }] }));
    const result = await runCodeForTenant({ language: "python", code: "1" }, desk);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", filesWritten: [] });
    expect(result.stderr).not.toContain("secret");
  });
});

describe("through the real runner and a fake child", () => {
  it("reads a desk file in, writes a desk file out, and a second tool call sees version 2", async () => {
    ship = makeFakeShip();
    resetShipVerdictForTests();
    setShipDirForTests(ship.dir);
    setSandboxRunnerForTests(null);
    await root.write(path("data.csv"), "a,b\n1,2\n", person);

    // `files` proves the input arrived; `write:` proves the output left.
    const echoed = await runCodeForTenant({ language: "python", code: "files", files: ["data.csv"] }, desk);
    expect(JSON.parse(echoed.stdout)).toEqual({ "data.csv": "a,b\n1,2\n" });

    const first = await runCodeForTenant({ language: "python", code: "write:out/summary.csv:mean\n1.5" }, desk);
    expect(first).toMatchObject({ ok: true, filesWritten: [{ path: "out/summary.csv", version: 1 }] });
    const second = await runCodeForTenant({ language: "python", code: "write:out/summary.csv:mean\n2.5" }, desk);
    expect(second.filesWritten).toEqual([{ path: "out/summary.csv", version: 2 }]);
    expect((await root.read(path("out/summary.csv"))).text).toBe("mean\n2.5");
  });

  it("answers unavailable through the tool when the ship is not there", async () => {
    setShipDirForTests("C:\\no\\such\\sandbox");
    resetShipVerdictForTests();
    setSandboxRunnerForTests(null);
    const result = await runCodeForTenant({ language: "javascript", code: "1" }, desk);
    expect(result).toMatchObject({ ok: false, reason: "unavailable", filesWritten: [] });
    expect(result.stderr).not.toContain("no\\such");
  });
});
