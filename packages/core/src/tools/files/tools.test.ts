import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../tenancy/types";
import { invokeTool } from "../define-tool";
import { getTool, resetToolRegistry } from "../registry";
import { createMemoryRoot, type MemoryRoot } from "./__fixtures__/memory-root";
import { FileRootError } from "./refusals";
import { registerFileTools } from "./register";
import { type FileRootResolver, setFileRootResolver } from "./resolver";
import { FILE_TOOLS } from "./tools";
import type { FileAuthor, FileRootKind } from "./types";

const tenant: TenantContext = {
  tenantId: "local-tenant",
  organizationId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  role: "member",
};

const agent: FileAuthor = { kind: "agent", runId: "run-1", mode: "chat" };

function run(key: string, args: unknown): Promise<unknown> {
  const found = getTool(key);
  if (!found) {
    throw new Error(`missing tool ${key}`);
  }
  return invokeTool(found, args, tenant);
}

function useRoots(roots: Partial<Record<FileRootKind, MemoryRoot>>): { asked: FileRootKind[] } {
  const asked: FileRootKind[] = [];
  const resolver: FileRootResolver = async (_tenant, kind) => {
    asked.push(kind);
    const memory = roots[kind];
    return memory
      ? { root: memory.root, author: agent }
      : { ok: false, code: "root_unavailable", message: "No folder is open on this desk." };
  };
  setFileRootResolver(resolver);
  return { asked };
}

describe("file tools", () => {
  beforeEach(() => {
    setFileRootResolver(null);
    resetToolRegistry();
    registerFileTools();
  });

  afterEach(() => {
    setFileRootResolver(null);
    vi.restoreAllMocks();
  });

  it("registers six tools whose output is user content", () => {
    expect(FILE_TOOLS.map((tool) => tool.key)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "delete_file",
    ]);
    for (const tool of FILE_TOOLS) {
      expect(getTool(tool.key)?.trust).toBe("user_content");
    }
  });

  it("tells the model about the limits and about folder approval", () => {
    expect(getTool("write_file")?.description).toContain("at most 2 MB");
    expect(getTool("write_file")?.description).toContain("pending_approval");
    expect(getTool("edit_file")?.description).toContain("must occur once");
    expect(getTool("read_file")?.description).toContain("At most 2000 lines");
    expect(getTool("search_files")?.description).toContain("at most 200");
    expect(getTool("delete_file")?.description).toContain("only after the owner approves");
  });

  it("rejects an argument it does not know", async () => {
    useRoots({ desk: createMemoryRoot("desk") });
    await expect(run("read_file", { path: "a.md", extra: true })).rejects.toMatchObject({ code: "invalid_tool_args" });
  });

  describe("without a resolver", () => {
    it.each([
      ["list_files", {}],
      ["read_file", { path: "a.md" }],
      ["write_file", { path: "a.md", content: "x" }],
      ["edit_file", { path: "a.md", old_string: "x", new_string: "y" }],
      ["search_files", { pattern: "x" }],
      ["delete_file", { path: "a.md" }],
    ])("%s answers root_unavailable", async (key, args) => {
      expect(await run(key, args)).toEqual({
        ok: false,
        code: "root_unavailable",
        message: "File tools are not available in this run.",
      });
    });
  });

  describe("roots", () => {
    it("asks for the desk by default and for the folder when told to", async () => {
      const desk = createMemoryRoot("desk", { "a.md": "desk text" });
      const folder = createMemoryRoot("folder", { "b.md": "folder text" });
      const { asked } = useRoots({ desk, folder });
      expect(await run("read_file", { path: "a.md" })).toMatchObject({ root: "desk", content: "     1\tdesk text" });
      expect(await run("read_file", { root: "folder", path: "b.md" })).toMatchObject({
        root: "folder",
        content: "     1\tfolder text",
      });
      expect(asked).toEqual(["desk", "folder"]);
    });

    it("passes through the resolver's refusal for a root the run cannot use", async () => {
      useRoots({ desk: createMemoryRoot("desk") });
      expect(await run("list_files", { root: "folder" })).toEqual({
        ok: false,
        code: "root_unavailable",
        message: "No folder is open on this desk.",
      });
    });
  });

  describe("path checks", () => {
    it.each([
      ["read_file", { path: "../a.md" }],
      ["write_file", { path: "/a.md", content: "x" }],
      ["edit_file", { path: "C:/a.md", old_string: "x", new_string: "y" }],
      ["delete_file", { path: "a\\b.md" }],
      ["list_files", { dir: "a/../b" }],
    ])("%s refuses a bad path before touching the root", async (key, args) => {
      const desk = createMemoryRoot("desk", { "a.md": "x" });
      const { asked } = useRoots({ desk });
      expect(await run(key, args)).toMatchObject({ ok: false, code: "bad_path" });
      expect(asked).toEqual([]);
      expect(desk.calls).toEqual([]);
    });

    it("refuses a glob over 200 characters", async () => {
      useRoots({ desk: createMemoryRoot("desk") });
      expect(await run("list_files", { glob: "a".repeat(201) })).toEqual({
        ok: false,
        code: "bad_pattern",
        message: "The glob is longer than 200 characters.",
      });
    });
  });

  describe("list_files", () => {
    const seed = { "notes/plan.md": "p", "notes/deep/idea.md": "i", "src/app.ts": "t", "readme.md": "r" };

    it("lists everything in path order", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      const result = (await run("list_files", {})) as { entries: Array<{ path: string }>; total: number };
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "notes/deep/idea.md",
        "notes/plan.md",
        "readme.md",
        "src/app.ts",
      ]);
      expect(result).toMatchObject({ ok: true, root: "desk", dir: null, total: 4, truncated: false });
    });

    it("limits to a folder and a glob", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      const result = (await run("list_files", { dir: "notes", glob: "notes/**/*.md" })) as {
        entries: Array<{ path: string }>;
      };
      expect(result.entries.map((entry) => entry.path)).toEqual(["notes/deep/idea.md", "notes/plan.md"]);
    });

    it("shows 500 entries and says there are more", async () => {
      const many = Object.fromEntries(Array.from({ length: 520 }, (_, index) => [`f${index}.txt`, "x"]));
      useRoots({ desk: createMemoryRoot("desk", many) });
      const result = (await run("list_files", {})) as { entries: unknown[]; total: number; truncated: boolean };
      expect(result.entries).toHaveLength(500);
      expect(result.total).toBe(520);
      expect(result.truncated).toBe(true);
    });
  });

  describe("read_file", () => {
    it("numbers lines and reports the version", async () => {
      useRoots({ desk: createMemoryRoot("desk", { "plan.md": "one\ntwo\nthree\n" }) });
      expect(await run("read_file", { path: "plan.md" })).toEqual({
        ok: true,
        root: "desk",
        path: "plan.md",
        bytes: 14,
        version: 1,
        totalLines: 3,
        firstLine: 1,
        lastLine: 3,
        truncated: false,
        content: "     1\tone\n     2\ttwo\n     3\tthree",
      });
    });

    it("truncates at 2000 lines and says how to continue", async () => {
      const text = Array.from({ length: 2100 }, (_, index) => `row ${index + 1}`).join("\n");
      useRoots({ desk: createMemoryRoot("desk", { "big.txt": text }) });
      const result = (await run("read_file", { path: "big.txt" })) as { content: string; truncated: boolean };
      expect(result.truncated).toBe(true);
      expect(result.content.split("\n").at(-1)).toBe(
        "[Showing lines 1-2000 of 2100. Call read_file again with offset 2001 to continue.]",
      );
      const rest = (await run("read_file", { path: "big.txt", offset: 2001 })) as { content: string; lastLine: number };
      expect(rest.lastLine).toBe(2100);
      expect(rest.content.split("\n")[0]).toBe("  2001\trow 2001");
    });

    it("answers not_found for a missing file", async () => {
      useRoots({ desk: createMemoryRoot("desk") });
      expect(await run("read_file", { path: "missing.md" })).toEqual({
        ok: false,
        code: "not_found",
        message: "No file at that path.",
      });
    });
  });

  describe("write_file", () => {
    it("saves on the desk as the next version", async () => {
      const desk = createMemoryRoot("desk", { "plan.md": "v1" });
      useRoots({ desk });
      expect(await run("write_file", { path: "plan.md", content: "v2" })).toEqual({
        ok: true,
        root: "desk",
        status: "saved",
        path: "plan.md",
        version: 2,
      });
      expect(desk.files.get("plan.md")).toEqual({ text: "v2", version: 2 });
      expect(desk.calls).toEqual([{ op: "write", path: "plan.md", by: agent, content: "v2" }]);
      // Overwrite is what write_file means: it passes no expectation about the file's current text.
      expect(desk.calls[0]).not.toHaveProperty("options");
    });

    it("returns pending_approval for a folder and changes nothing", async () => {
      const folder = createMemoryRoot("folder", { "plan.md": "v1" });
      useRoots({ folder });
      expect(await run("write_file", { root: "folder", path: "plan.md", content: "v2" })).toEqual({
        ok: true,
        root: "folder",
        status: "pending_approval",
        path: "plan.md",
        proposalId: "proposal-1",
        message:
          "Not applied yet. The owner has to approve this change; until then the file on disk is unchanged. Tell the owner it is waiting and do not rely on it.",
      });
      expect(folder.files.get("plan.md")?.text).toBe("v1");
    });

    it("accepts exactly 2 MB and refuses one byte more", async () => {
      const desk = createMemoryRoot("desk");
      useRoots({ desk });
      const limit = 2 * 1024 * 1024;
      expect(await run("write_file", { path: "ok.txt", content: "a".repeat(limit) })).toMatchObject({
        ok: true,
        status: "saved",
      });
      expect(await run("write_file", { path: "big.txt", content: "a".repeat(limit + 1) })).toEqual({
        ok: false,
        code: "too_large",
        message: "The content is larger than 2 MB. Write a shorter file, or split it into several.",
      });
      expect(desk.files.has("big.txt")).toBe(false);
    });

    it("measures the cap in UTF-8 bytes, not characters", async () => {
      const desk = createMemoryRoot("desk");
      useRoots({ desk });
      const twoByteChars = "é".repeat(1024 * 1024 + 1);
      expect(twoByteChars.length).toBe(1_048_577);
      expect(await run("write_file", { path: "wide.txt", content: twoByteChars })).toMatchObject({
        ok: false,
        code: "too_large",
      });
      expect(await run("write_file", { path: "wide.txt", content: "é".repeat(1024 * 1024) })).toMatchObject({
        ok: true,
      });
    });

    it("passes a root's quota refusal on", async () => {
      const desk = createMemoryRoot("desk");
      desk.root.write = async () => {
        throw new FileRootError("quota", "The storage quota is full.");
      };
      useRoots({ desk });
      expect(await run("write_file", { path: "a.md", content: "x" })).toEqual({
        ok: false,
        code: "quota",
        message: "The storage quota is full.",
      });
    });

    it("passes a root's file-count refusal on", async () => {
      const desk = createMemoryRoot("desk");
      desk.root.write = async () => {
        throw new FileRootError("too_many_files", "A desk holds at most 2000 files.");
      };
      useRoots({ desk });
      expect(await run("write_file", { path: "a.md", content: "x" })).toMatchObject({
        ok: false,
        code: "too_many_files",
      });
    });
  });

  describe("edit_file", () => {
    it("reads, replaces once and writes the next version", async () => {
      const desk = createMemoryRoot("desk", { "notes/plan.md": "1. gather\n2. draft\n3. send\n" });
      useRoots({ desk });
      expect(
        await run("edit_file", { path: "notes/plan.md", old_string: "2. draft", new_string: "2. review" }),
      ).toEqual({ ok: true, root: "desk", status: "saved", path: "notes/plan.md", version: 2, replacements: 1 });
      expect(desk.files.get("notes/plan.md")).toEqual({ text: "1. gather\n2. review\n3. send\n", version: 2 });
    });

    it("hands the root the hash it read, so a write that lost a race can be refused", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "one two" });
      useRoots({ desk });
      await run("edit_file", { path: "a.txt", old_string: "one", new_string: "1" });
      expect(desk.calls).toEqual([
        { op: "write", path: "a.txt", by: agent, content: "1 two", options: { expectedSha256: "sha-1" } },
      ]);
    });

    it("passes the root's conflict refusal on", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "one two" });
      desk.root.write = async () => {
        throw new FileRootError("conflict", "The file changed. Read it again and redo the edit.");
      };
      useRoots({ desk });
      expect(await run("edit_file", { path: "a.txt", old_string: "one", new_string: "1" })).toEqual({
        ok: false,
        code: "conflict",
        message: "The file changed. Read it again and redo the edit.",
      });
    });

    it("refuses an ambiguous match and writes nothing", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "x = 1\ny = 1\n" });
      useRoots({ desk });
      expect(await run("edit_file", { path: "a.txt", old_string: "= 1", new_string: "= 2" })).toMatchObject({
        ok: false,
        code: "ambiguous_match",
      });
      expect(desk.calls).toEqual([]);
    });

    it("replaces every occurrence with replace_all", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "x = 1\ny = 1\n" });
      useRoots({ desk });
      expect(
        await run("edit_file", { path: "a.txt", old_string: "= 1", new_string: "= 2", replace_all: true }),
      ).toMatchObject({ ok: true, replacements: 2, version: 2 });
      expect(desk.files.get("a.txt")?.text).toBe("x = 2\ny = 2\n");
    });

    it("refuses when old_string is not in the file", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "hello" });
      useRoots({ desk });
      expect(await run("edit_file", { path: "a.txt", old_string: "bye", new_string: "hi" })).toMatchObject({
        ok: false,
        code: "no_match",
      });
      expect(desk.calls).toEqual([]);
    });

    it("answers not_found for a missing file", async () => {
      useRoots({ desk: createMemoryRoot("desk") });
      expect(await run("edit_file", { path: "gone.md", old_string: "a", new_string: "b" })).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });

    it("edits a CRLF file with a multi-line old_string typed with plain line breaks", async () => {
      const desk = createMemoryRoot("desk", { "win.txt": "alpha\r\nbeta\r\ngamma\r\n" });
      useRoots({ desk });
      expect(
        await run("edit_file", { path: "win.txt", old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" }),
      ).toMatchObject({
        ok: true,
        replacements: 1,
      });
      expect(desk.files.get("win.txt")?.text).toBe("ALPHA\r\nBETA\r\ngamma\r\n");
    });

    it("proposes the edit on a folder and leaves the file alone", async () => {
      const folder = createMemoryRoot("folder", { "README.md": "Teh project\n" });
      useRoots({ folder });
      expect(
        await run("edit_file", { root: "folder", path: "README.md", old_string: "Teh", new_string: "The" }),
      ).toMatchObject({ ok: true, status: "pending_approval", proposalId: "proposal-1", replacements: 1 });
      expect(folder.files.get("README.md")?.text).toBe("Teh project\n");
      expect(folder.calls[0]).toMatchObject({ op: "write", content: "The project\n" });
    });

    it("refuses an edit that grows the file past 2 MB", async () => {
      const limit = 2 * 1024 * 1024;
      const desk = createMemoryRoot("desk", { "a.txt": `x${"a".repeat(limit - 1)}` });
      useRoots({ desk });
      expect(await run("edit_file", { path: "a.txt", old_string: "x", new_string: "xx" })).toMatchObject({
        ok: false,
        code: "too_large",
      });
      expect(desk.calls).toEqual([]);
    });
  });

  describe("search_files", () => {
    const seed = {
      "notes/plan.md": "TODO write\ndone\nTODO send\n",
      "notes/idea.md": "no match here\n",
      "src/app.ts": "// TODO: fix a.b\nconst axb = 1;\n",
    };

    let previousServerFlag: string | undefined;

    beforeEach(() => {
      previousServerFlag = process.env.AGENTFORGE_SERVER;
      delete process.env.AGENTFORGE_SERVER;
    });

    afterEach(() => {
      if (previousServerFlag === undefined) {
        delete process.env.AGENTFORGE_SERVER;
      } else {
        process.env.AGENTFORGE_SERVER = previousServerFlag;
      }
    });

    it("finds literal text, case sensitive, with line numbers", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      expect(await run("search_files", { pattern: "TODO" })).toEqual({
        ok: true,
        root: "desk",
        mode: "text",
        truncated: false,
        hits: [
          { path: "notes/plan.md", line: 1, text: "TODO write" },
          { path: "notes/plan.md", line: 3, text: "TODO send" },
          { path: "src/app.ts", line: 1, text: "// TODO: fix a.b" },
        ],
      });
      expect(await run("search_files", { pattern: "todo" })).toMatchObject({ hits: [] });
    });

    it("treats a dot as a dot unless regex is set", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      expect(await run("search_files", { pattern: "a.b" })).toMatchObject({
        hits: [{ path: "src/app.ts", line: 1 }],
      });
      expect(await run("search_files", { pattern: "a.b", regex: true })).toMatchObject({
        mode: "regex",
        hits: [
          { path: "src/app.ts", line: 1, text: "// TODO: fix a.b" },
          { path: "src/app.ts", line: 2, text: "const axb = 1;" },
        ],
      });
    });

    it("narrows by glob in both modes", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      expect(await run("search_files", { pattern: "TODO", glob: "notes/**" })).toMatchObject({
        hits: [
          { path: "notes/plan.md", line: 1 },
          { path: "notes/plan.md", line: 3 },
        ],
      });
      expect(await run("search_files", { pattern: "^TODO", regex: true, glob: "**/*.md" })).toMatchObject({
        hits: [
          { path: "notes/plan.md", line: 1 },
          { path: "notes/plan.md", line: 3 },
        ],
      });
    });

    it("caps hits at 200 and says so", async () => {
      const lines = Array.from({ length: 250 }, (_, index) => `hit ${index + 1}`).join("\n");
      useRoots({ desk: createMemoryRoot("desk", { "many.txt": lines }) });
      for (const regex of [false, true]) {
        const result = (await run("search_files", { pattern: "hit", regex })) as {
          hits: unknown[];
          truncated: boolean;
        };
        expect(result.hits).toHaveLength(200);
        expect(result.truncated).toBe(true);
      }
    });

    it("refuses a pattern over 200 characters and an invalid regex", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      expect(await run("search_files", { pattern: "a".repeat(201) })).toEqual({
        ok: false,
        code: "bad_pattern",
        message: "The search pattern is longer than 200 characters.",
      });
      expect(await run("search_files", { pattern: "[a-", regex: true })).toMatchObject({
        ok: false,
        code: "bad_pattern",
      });
    });

    it("refuses a regex that would run for ever", async () => {
      useRoots({ desk: createMemoryRoot("desk", { "a.txt": `${"a".repeat(45)}!` }) });
      expect(await run("search_files", { pattern: "(a|a)*b", regex: true })).toEqual({
        ok: false,
        code: "bad_pattern",
        message: "That regular expression is too slow to run. Use a simpler pattern, or search for plain text.",
      });
    });

    it("skips a file the root will not read during a regex search", async () => {
      const desk = createMemoryRoot("desk", { "a.txt": "needle\n", "secret.txt": "needle\n" });
      const read = desk.root.read.bind(desk.root);
      desk.root.read = async (path) => {
        if (path === "secret.txt") {
          throw new FileRootError("denied", "That file is not available.");
        }
        return read(path);
      };
      useRoots({ desk });
      expect(await run("search_files", { pattern: "needle", regex: true })).toMatchObject({
        hits: [{ path: "a.txt", line: 1, text: "needle" }],
      });
    });

    describe("on the hosted server", () => {
      beforeEach(() => {
        process.env.AGENTFORGE_SERVER = "1";
      });

      it("refuses a regex search with bad_pattern and never touches the root", async () => {
        const desk = createMemoryRoot("desk", seed);
        const { asked } = useRoots({ desk });
        expect(await run("search_files", { pattern: "TODO.*send", regex: true })).toEqual({
          ok: false,
          code: "bad_pattern",
          message:
            "Regular expression search is not available here. Search for plain text instead: leave regex off and use a distinctive piece of the text.",
        });
        expect(asked).toEqual([]);
        expect(desk.calls).toEqual([]);
      });

      it("refuses a catastrophic pattern at once instead of running it", async () => {
        useRoots({ desk: createMemoryRoot("desk", { "a.txt": `${"a".repeat(45)}!` }) });
        const started = Date.now();
        expect(await run("search_files", { pattern: "(a|a)*b", regex: true })).toMatchObject({
          ok: false,
          code: "bad_pattern",
          message: expect.stringContaining("Search for plain text instead"),
        });
        expect(Date.now() - started).toBeLessThan(500);
      });

      it("still searches plain text", async () => {
        useRoots({ desk: createMemoryRoot("desk", seed) });
        expect(await run("search_files", { pattern: "TODO", regex: false })).toMatchObject({
          ok: true,
          mode: "text",
          hits: [
            { path: "notes/plan.md", line: 1 },
            { path: "notes/plan.md", line: 3 },
            { path: "src/app.ts", line: 1 },
          ],
        });
      });
    });

    it("keeps regex search when the server flag is unset or off, as on desktop and webdev", async () => {
      useRoots({ desk: createMemoryRoot("desk", seed) });
      for (const flag of [undefined, "0", "false"]) {
        if (flag === undefined) {
          delete process.env.AGENTFORGE_SERVER;
        } else {
          process.env.AGENTFORGE_SERVER = flag;
        }
        expect(await run("search_files", { pattern: "^TODO", regex: true, glob: "**/*.md" })).toMatchObject({
          ok: true,
          mode: "regex",
          hits: [
            { path: "notes/plan.md", line: 1 },
            { path: "notes/plan.md", line: 3 },
          ],
        });
      }
    });
  });

  describe("delete_file", () => {
    it("deletes on the desk", async () => {
      const desk = createMemoryRoot("desk", { "old.md": "x" });
      useRoots({ desk });
      expect(await run("delete_file", { path: "old.md" })).toEqual({
        ok: true,
        root: "desk",
        status: "saved",
        path: "old.md",
        version: 2,
      });
      expect(desk.files.has("old.md")).toBe(false);
    });

    it("proposes the delete on a folder", async () => {
      const folder = createMemoryRoot("folder", { "old.md": "x" });
      useRoots({ folder });
      expect(await run("delete_file", { root: "folder", path: "old.md" })).toMatchObject({
        ok: true,
        status: "pending_approval",
        proposalId: "proposal-1",
      });
      expect(folder.files.has("old.md")).toBe(true);
    });

    it("answers not_found for a missing file", async () => {
      useRoots({ desk: createMemoryRoot("desk") });
      expect(await run("delete_file", { path: "gone.md" })).toMatchObject({ ok: false, code: "not_found" });
    });
  });

  describe("failures inside a root", () => {
    it("never shows the model a host path from an unexpected error", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const desk = createMemoryRoot("desk");
      desk.root.read = async () => {
        throw new Error("ENOENT: no such file or directory, open 'C:\\Users\\rizky\\AppData\\Roaming\\Nultron\\x.bin'");
      };
      useRoots({ desk });
      const result = await run("read_file", { path: "a.md" });
      expect(result).toEqual({
        ok: false,
        code: "root_unavailable",
        message: "The file store could not complete this request. Try again later.",
      });
      expect(JSON.stringify(result)).not.toContain("rizky");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("turns a resolver that throws into root_unavailable", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      setFileRootResolver(async () => {
        throw new Error("boom at /srv/data");
      });
      expect(await run("list_files", {})).toEqual({
        ok: false,
        code: "root_unavailable",
        message: "The file store could not complete this request. Try again later.",
      });
    });
  });
});
