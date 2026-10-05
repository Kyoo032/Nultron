import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type FileAuthor, type FileRoot, invokeTool } from "@agentforge/core";
import { readFileTool, searchFilesTool, setFileRootResolver } from "@agentforge/core/tools/files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveProposal } from "./decisions";
import { createFolderRoot } from "./folder-root";
import { mountFilePath } from "./mount-record";
import { mountFolder, unmountFolder } from "./mount-service";
import { isFolderRefusal } from "./refusal";
import { DESK_A, makeSandbox, openProposalsFixture, type ProposalsFixture, type Sandbox } from "./test-support";

const AGENT: FileAuthor = { kind: "agent", runId: "run-1", mode: "chat" };

let box: Sandbox;
let fx: ProposalsFixture;
let root: FileRoot;

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isFolderRefusal(error)) {
      return error.code;
    }
    throw error;
  }
  return "no refusal";
}

function trySymlink(target: string, link: string, type: "file" | "dir" | "junction"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  box = makeSandbox();
  fx = openProposalsFixture();
  await mountFolder(DESK_A, box.folder, { store: fx.store });
  const made = await createFolderRoot(DESK_A, AGENT, { store: fx.store });
  if ("ok" in made) {
    throw new Error(`root was refused: ${made.code}`);
  }
  root = made;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(mountFilePath(), { force: true });
  fx.db.close();
  box.dispose();
});

describe("reading", () => {
  it("reads a text file with its hash and size", async () => {
    box.put("notes/hello.txt", "hello\n");
    expect(await root.read("notes/hello.txt" as never)).toEqual({
      path: "notes/hello.txt",
      text: "hello\n",
      sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      bytes: 6,
    });
  });

  it("answers not_found for a missing file and bad_path for a folder", async () => {
    box.put("a/b.txt", "x");
    expect(await refusalCode(root.read("nope.txt" as never))).toBe("not_found");
    expect(await refusalCode(root.read("a" as never))).toBe("bad_path");
  });

  it.each(["../outside/x.txt", "/etc/passwd", "a\\b", "C:/x", "a/../b"])("refuses the path %s", async (input) => {
    expect(await refusalCode(root.read(input as never))).toBe("bad_path");
  });

  it.each([
    ".env",
    ".ENV",
    ".env.local",
    "deploy/server.pem",
    "k/tls.key",
    "id_rsa",
    "id_ed25519.pub",
    ".npmrc",
    ".netrc",
    ".git/config",
    "x/.ssh/config",
  ])("refuses %s as denied", async (rel) => {
    box.put(rel, "SECRET=1");
    expect(await refusalCode(root.read(rel as never))).toBe("denied");
  });

  it("reads a file of exactly 2 MB and refuses one byte more", async () => {
    box.put("ok.txt", "a".repeat(2 * 1024 * 1024));
    box.put("big.txt", "a".repeat(2 * 1024 * 1024 + 1));
    expect((await root.read("ok.txt" as never)).bytes).toBe(2 * 1024 * 1024);
    expect(await refusalCode(root.read("big.txt" as never))).toBe("too_large");
  });

  it("refuses binary files and invalid UTF-8 as denied", async () => {
    box.put("image.bin", Buffer.from([0x89, 0x50, 0x00, 0x47]));
    box.put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await refusalCode(root.read("image.bin" as never))).toBe("denied");
    expect(await refusalCode(root.read("latin1.txt" as never))).toBe("denied");
  });

  it("keeps a byte-order mark in the text so a write-back is byte-exact", async () => {
    box.put("bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
    expect((await root.read("bom.txt" as never)).text).toBe("\ufeffhi");
  });

  it("reads inside node_modules when asked by path", async () => {
    box.put("node_modules/pkg/index.js", "module.exports = 1;");
    expect((await root.read("node_modules/pkg/index.js" as never)).text).toBe("module.exports = 1;");
  });
});

describe("containment by real path", () => {
  it("refuses a link inside the folder that points outside it", async ({ skip }) => {
    writeFileSync(path.join(box.outside, "secret.txt"), "outside secret");
    const made = trySymlink(box.outside, path.join(box.folder, "escape"), "junction");
    if (!made) {
      skip("the OS refused to create this kind of link");
    }
    expect(await refusalCode(root.read("escape/secret.txt" as never))).toBe("denied");
    expect(await refusalCode(root.write("escape/new.txt" as never, "x", AGENT))).toBe("denied");
    const listed = await root.list(null);
    expect(listed.map((entry) => entry.path)).toEqual([]);
  });

  it("refuses a file link that points outside the folder", async ({ skip }) => {
    const secret = path.join(box.outside, "secret.txt");
    writeFileSync(secret, "outside secret");
    if (!trySymlink(secret, path.join(box.folder, "leak.txt"), "file")) {
      // Windows without developer mode cannot create file links; the junction test above covers it.
      skip("the OS refused to create this kind of link");
    }
    expect(await refusalCode(root.read("leak.txt" as never))).toBe("denied");
    expect(await root.list(null)).toEqual([]);
  });

  it("refuses a link inside the folder that points at a denied name", async ({ skip }) => {
    box.put(".env", "SECRET=1");
    if (!trySymlink(path.join(box.folder, ".env"), path.join(box.folder, "innocent.txt"), "file")) {
      skip("the OS refused to create this kind of link");
    }
    expect(await refusalCode(root.read("innocent.txt" as never))).toBe("denied");
  });

  it("follows a link that stays inside the folder", async ({ skip }) => {
    box.put("real/data.txt", "fine");
    if (!trySymlink(path.join(box.folder, "real"), path.join(box.folder, "alias"), "junction")) {
      skip("the OS refused to create this kind of link");
    }
    expect((await root.read("alias/data.txt" as never)).text).toBe("fine");
  });

  it("refuses to write through a broken link rather than replacing it", async ({ skip }) => {
    if (!trySymlink(path.join(box.outside, "nowhere.txt"), path.join(box.folder, "dangling.txt"), "file")) {
      skip("the OS refused to create this kind of link");
    }
    expect(await refusalCode(root.write("dangling.txt" as never, "x", AGENT))).toBe("denied");
  });
});

describe("listing", () => {
  it("lists files recursively in name order and leaves out denied names and noise", async () => {
    box.put("b.txt", "bb");
    box.put("a.txt", "a");
    box.put("src/main.ts", "export {};");
    box.put(".env", "S=1");
    box.put("keys/site.pem", "pem");
    box.put(".git/config", "[core]");
    box.put("node_modules/pkg/index.js", "x");
    box.put("dist/out.js", "x");
    box.put("build/out.js", "x");
    box.put(".next/cache", "x");
    box.put(".turbo/log", "x");
    const entries = await root.list(null);
    expect(entries.map((entry) => [entry.path, entry.kind, entry.bytes])).toEqual([
      ["a.txt", "file", 1],
      ["b.txt", "file", 2],
      ["src/main.ts", "file", 10],
    ]);
    expect(entries.every((entry) => entry.updatedAt > 0)).toBe(true);
  });

  it("filters by glob and by directory", async () => {
    box.put("docs/a.md", "a");
    box.put("docs/deep/b.md", "b");
    box.put("src/c.ts", "c");
    expect((await root.list(null, "*.md")).map((entry) => entry.path)).toEqual(["docs/a.md", "docs/deep/b.md"]);
    expect((await root.list("docs" as never)).map((entry) => entry.path)).toEqual(["docs/a.md", "docs/deep/b.md"]);
    expect((await root.list(null, "src/**")).map((entry) => entry.path)).toEqual(["src/c.ts"]);
  });

  it("refuses a missing directory and a file given as a directory", async () => {
    box.put("f.txt", "x");
    expect(await refusalCode(root.list("missing" as never))).toBe("not_found");
    expect(await refusalCode(root.list("f.txt" as never))).toBe("bad_path");
    expect(await refusalCode(root.list(".git" as never))).toBe("denied");
  });

  it("stops at 5000 entries", async () => {
    const dir = path.join(box.folder, "many");
    mkdirSync(dir);
    for (let index = 0; index < 5010; index += 1) {
      writeFileSync(path.join(dir, `f${index}.txt`), "");
    }
    expect(await root.list(null)).toHaveLength(5000);
  }, 60_000);
});

describe("searching", () => {
  it("finds lines case-sensitively with their numbers, as the desk root does", async () => {
    box.put("a.txt", "one\nTwo Needle\r\nthree\nneedle again");
    box.put("src/b.ts", "no match here");
    expect(await root.search("NEEDLE")).toEqual([]);
    expect(await root.search("Needle")).toEqual([{ path: "a.txt", line: 2, text: "Two Needle" }]);
    expect(await root.search("needle")).toEqual([{ path: "a.txt", line: 4, text: "needle again" }]);
  });

  it("matches a pattern made of spaces, because a pattern is any substring", async () => {
    box.put("a.txt", "none\n  indented\n");
    expect((await root.search("  ")).map((hit) => hit.line)).toEqual([2]);
  });

  it("treats the pattern as plain text, not a regular expression", async () => {
    box.put("a.txt", "a.c\nabc");
    expect((await root.search("a.c")).map((hit) => hit.line)).toEqual([1]);
  });

  it("skips denied files, noise folders and binary files", async () => {
    box.put(".env", "needle");
    box.put("node_modules/p/i.js", "needle");
    box.put("blob.bin", Buffer.from("needle\u0000\u0001"));
    box.put("ok.txt", "needle");
    expect((await root.search("needle")).map((hit) => hit.path)).toEqual(["ok.txt"]);
  });

  it("narrows by glob and cuts a long line", async () => {
    box.put("a.md", `needle ${"x".repeat(500)}`);
    box.put("b.txt", "needle");
    const hits = await root.search("needle", "*.md");
    expect(hits.map((hit) => hit.path)).toEqual(["a.md"]);
    expect(hits[0].text).toHaveLength(300);
  });

  it("returns one hit past the 200 cap, so the tool can tell exactly 200 from more", async () => {
    box.put("many.txt", "needle\n".repeat(500));
    box.put("exact.txt", "needle\n".repeat(200));
    expect(await root.search("needle", "many.txt")).toHaveLength(201);
    expect(await root.search("needle", "exact.txt")).toHaveLength(200);
  });

  it("stops reading at 50 MB", async () => {
    const line = `${"a".repeat(1024 * 1024 - 1)}\n`;
    const block = line.repeat(2);
    for (let index = 0; index < 25; index += 1) {
      box.put(`f${String(index).padStart(2, "0")}.txt`, index === 0 ? `needle\n${block.slice(7)}` : block);
    }
    box.put("f25.txt", "needle");
    const hits = await root.search("needle");
    expect(hits.map((hit) => hit.path)).toEqual(["f00.txt"]);
  }, 60_000);

  it("refuses an empty pattern and one over 200 characters", async () => {
    expect(await refusalCode(root.search(""))).toBe("bad_pattern");
    expect(await refusalCode(root.search("x".repeat(201)))).toBe("bad_pattern");
  });
});

describe("writing makes proposals and never touches the disk", () => {
  it("proposes a change to an existing file and leaves it as it was", async () => {
    const file = box.put("a.txt", "old");
    const outcome = await root.write("a.txt" as never, "new", AGENT);
    expect(outcome.status).toBe("pending_approval");
    expect(readFileSync(file, "utf8")).toBe("old");
    if (outcome.status !== "pending_approval") {
      return;
    }
    expect(
      fx.db
        .prepare("SELECT workspace_id, run_id, path, kind, before_sha256, status, decided_at FROM file_proposals")
        .all(),
    ).toEqual([
      {
        workspace_id: "desk-a",
        run_id: "run-1",
        path: "a.txt",
        kind: "write",
        before_sha256: "cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4",
        status: "pending",
        decided_at: null,
      },
    ]);
    expect(outcome.path).toBe("a.txt");
  });

  it("files the hash the caller read as before_sha256, so a file changed since the read is stale on approve", async () => {
    const file = box.put("a.txt", "hello\n");
    const readSha = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    // The file changes between the model's read and its propose.
    writeFileSync(file, "someone else was here\n");
    const outcome = await root.write("a.txt" as never, "my edit\n", AGENT, { expectedSha256: readSha });
    expect(outcome.status).toBe("pending_approval");
    const row = fx.db.prepare("SELECT before_sha256 FROM file_proposals").get() as { before_sha256: string };
    expect(row.before_sha256).toBe(readSha);
    if (outcome.status !== "pending_approval") {
      return;
    }
    expect(await approveProposal(DESK_A, outcome.proposalId, { store: fx.store })).toEqual({
      id: outcome.proposalId,
      status: "stale",
    });
    expect(readFileSync(file, "utf8")).toBe("someone else was here\n");
  });

  it("hashes the current file when the caller gave no expectation", async () => {
    box.put("a.txt", "hello\n");
    await root.write("a.txt" as never, "changed", AGENT, {});
    const row = fx.db.prepare("SELECT before_sha256 FROM file_proposals").get() as { before_sha256: string };
    expect(row.before_sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  });

  it("records a missing file as before NULL and seals the proposed text at rest", async () => {
    const outcome = await root.write("fresh/new.txt" as never, "plain secret body", AGENT);
    expect(outcome.status).toBe("pending_approval");
    const row = fx.db.prepare("SELECT before_sha256, after_body FROM file_proposals").get() as {
      before_sha256: string | null;
      after_body: string;
    };
    expect(row.before_sha256).toBeNull();
    expect(row.after_body).not.toContain("plain secret body");
    expect(readdirSync(box.folder)).toEqual([]);
  });

  it("hashes the existing file into before_sha256", async () => {
    box.put("a.txt", "hello\n");
    await root.write("a.txt" as never, "changed", AGENT);
    const row = fx.db.prepare("SELECT before_sha256 FROM file_proposals").get() as { before_sha256: string };
    expect(row.before_sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  });

  it("takes the run id from the actor, then from the root's author, then falls back to user", async () => {
    await root.write("a.txt" as never, "x", { kind: "user", userId: "local" });
    const row = fx.db.prepare("SELECT run_id FROM file_proposals").get() as { run_id: string };
    expect(row.run_id).toBe("run-1");
    const plain = await createFolderRoot(DESK_A, { kind: "user", userId: "local" }, { store: fx.store });
    if ("ok" in plain) {
      throw new Error("expected a root");
    }
    await plain.write("b.txt" as never, "x", { kind: "user", userId: "local" });
    expect(
      (fx.db.prepare("SELECT run_id FROM file_proposals WHERE path = 'b.txt'").get() as { run_id: string }).run_id,
    ).toBe("user");
  });

  it("replaces an earlier pending proposal for the same path by rejecting it", async () => {
    const first = await root.write("a.txt" as never, "one", AGENT);
    const second = await root.write("a.txt" as never, "two", AGENT);
    expect(
      first.status === "pending_approval" &&
        second.status === "pending_approval" &&
        first.proposalId !== second.proposalId,
    ).toBe(true);
    const rows = fx.db
      .prepare("SELECT status, decided_at FROM file_proposals ORDER BY created_at, rowid")
      .all() as Array<{
      status: string;
      decided_at: number | null;
    }>;
    expect(rows.map((row) => row.status)).toEqual(["rejected", "pending"]);
    expect(rows[0].decided_at).toEqual(expect.any(Number));
    expect(rows[1].decided_at).toBeNull();
  });

  it("proposes a delete and leaves the file in place", async () => {
    const file = box.put("gone.txt", "bye");
    const outcome = await root.remove("gone.txt" as never, AGENT);
    expect(outcome.status).toBe("pending_approval");
    expect(readFileSync(file, "utf8")).toBe("bye");
    const row = fx.db.prepare("SELECT kind, after_body, status FROM file_proposals").get();
    expect(row).toEqual({ kind: "delete", after_body: null, status: "pending" });
    expect(await refusalCode(root.remove("missing.txt" as never, AGENT))).toBe("not_found");
  });

  it("refuses denied names, oversize text, NUL bytes and binary targets", async () => {
    box.put("blob.bin", Buffer.from([1, 0, 2]));
    expect(await refusalCode(root.write(".env" as never, "S=1", AGENT))).toBe("denied");
    expect(await refusalCode(root.write("k/id_rsa" as never, "x", AGENT))).toBe("denied");
    expect(await refusalCode(root.write("big.txt" as never, "a".repeat(2 * 1024 * 1024 + 1), AGENT))).toBe("too_large");
    expect(await refusalCode(root.write("zero.txt" as never, "a\u0000b", AGENT))).toBe("denied");
    expect(await refusalCode(root.write("blob.bin" as never, "text", AGENT))).toBe("denied");
    expect(await refusalCode(root.write("../x.txt" as never, "x", AGENT))).toBe("bad_path");
    expect(await refusalCode(root.remove(".git/config" as never, AGENT))).toBe("denied");
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM file_proposals").get()).toEqual({ n: 0 });
  });

  it("allows 50 pending proposals, refuses the 51st, and still lets a path replace its own", async () => {
    for (let index = 0; index < 50; index += 1) {
      await root.write(`f${index}.txt` as never, "x", AGENT);
    }
    expect(await refusalCode(root.write("f50.txt" as never, "x", AGENT))).toBe("too_many_files");
    expect((await root.write("f0.txt" as never, "again", AGENT)).status).toBe("pending_approval");
  });
});

describe("where the root is unavailable", () => {
  it("returns a root_unavailable refusal in server mode", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    expect(await createFolderRoot(DESK_A, AGENT, { store: fx.store })).toEqual({
      ok: false,
      code: "root_unavailable",
      message: "No folder is open for this desk.",
    });
  });

  it("refuses every method on a root that was handed out before server mode turned on", async () => {
    box.put("a.txt", "x");
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    expect(await refusalCode(root.list(null))).toBe("root_unavailable");
    expect(await refusalCode(root.read("a.txt" as never))).toBe("root_unavailable");
    expect(await refusalCode(root.write("a.txt" as never, "y", AGENT))).toBe("root_unavailable");
    expect(await refusalCode(root.remove("a.txt" as never, AGENT))).toBe("root_unavailable");
    expect(await refusalCode(root.search("x"))).toBe("root_unavailable");
  });

  it("returns root_unavailable when the desk has no folder, and when another desk has one", async () => {
    const other = await createFolderRoot({ ...DESK_A, workspaceId: "desk-b" }, AGENT, { store: fx.store });
    expect(other).toMatchObject({ ok: false, code: "root_unavailable" });
  });

  it("stops serving the moment the folder is unmounted", async () => {
    box.put("a.txt", "x");
    await unmountFolder(DESK_A, { store: fx.store });
    expect(await refusalCode(root.read("a.txt" as never))).toBe("root_unavailable");
  });

  it("stops serving when the folder is deleted from under the mount", async () => {
    box.put("a.txt", "x");
    rmSync(box.folder, { recursive: true, force: true });
    expect(await refusalCode(root.read("a.txt" as never))).toBe("root_unavailable");
  });
});

describe("through the core file tools", () => {
  beforeEach(() => {
    setFileRootResolver(async () => ({ root, author: AGENT }));
  });

  afterEach(() => {
    setFileRootResolver(null);
  });

  it("hands the model the same code and fixed message the root threw for a denied name", async () => {
    box.put(".env", "SECRET=1");
    const result = await invokeTool(readFileTool, { root: "folder", path: ".env" }, DESK_A);
    expect(result).toEqual({ ok: false, code: "denied", message: "That file is not available to the agent." });
  });

  it.each([
    ["missing.txt", "not_found", "That file does not exist in the folder."],
    ["big.txt", "too_large", "That file is too large to read as text."],
  ])("keeps the code for %s (%s), not a generic root_unavailable", async (rel, code, message) => {
    box.put("big.txt", "a".repeat(2 * 1024 * 1024 + 1));
    const result = await invokeTool(readFileTool, { root: "folder", path: rel }, DESK_A);
    expect(result).toEqual({ ok: false, code, message });
  });

  it("searches case-sensitively and flags more than 200 hits as truncated", async () => {
    box.put("a.txt", "Needle\n".repeat(201));
    const tooMany = await invokeTool(searchFilesTool, { root: "folder", pattern: "Needle" }, DESK_A);
    expect(tooMany).toMatchObject({ ok: true, root: "folder", mode: "text", truncated: true });
    expect((tooMany as { hits: unknown[] }).hits).toHaveLength(200);
    expect(await invokeTool(searchFilesTool, { root: "folder", pattern: "needle" }, DESK_A)).toMatchObject({
      ok: true,
      truncated: false,
      hits: [],
    });
  });
});
