/**
 * The desk file store: versions, no-op saves, soft delete, the caps, the desk boundary, the sealed
 * bodies and the tenant quota. Each case runs against a scratch SQLite database and the real file
 * object store under the suite's throwaway media root.
 */
import { rmSync } from "node:fs";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeTool, LOCAL_TENANT_ID, wrappingKeyFromSecret, type TenantContext } from "@agentforge/core";
import {
  editFileTool,
  FileRootError,
  MAX_FILE_BYTES,
  MAX_SEARCH_HITS,
  setFileRootResolver,
} from "@agentforge/core/tools/files";
import type { DeskPath, FileAuthor, FileRoot } from "@agentforge/core/tools/files";
import { ensureSchema } from "@agentforge/db/ensure-schema";
import {
  readTenantStorageCounter,
  registerTenantStorageSql,
  resetTenantStorageSqlForTests,
} from "../tenant-storage-store";
import { mediaRoot } from "../media-root";
import { readTenantObject, resetObjectStoreForTests } from "../tenant-storage";
import { createDeskFileStore, MAX_DESK_FILES, type DeskFileStore } from "./file-store";

const KEY = wrappingKeyFromSecret("c".repeat(64));
const SECRET_TEXT = "the launch codes are 0000-1111-2222";

const deskA = (): TenantContext => ({
  tenantId: LOCAL_TENANT_ID,
  organizationId: "org",
  workspaceId: `desk-${crypto.randomUUID()}`,
  userId: "local",
  role: "owner",
});

const person: FileAuthor = { kind: "user", userId: "user-1" };
const agent: FileAuthor = { kind: "agent", runId: "run-1", mode: "research" };

const path = (value: string): DeskPath => value as DeskPath;

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileRootError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("desk file store", () => {
  let db: Database.Database;
  let store: DeskFileStore;
  let tenant: TenantContext;
  let root: FileRoot;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureSchema(db);
    store = createDeskFileStore(db, () => KEY);
    tenant = deskA();
    root = store.createDeskRoot(tenant, person);
  });

  afterEach(() => {
    db.close();
  });

  describe("versions", () => {
    it("keeps version 1 and 2 of an edited file, and a revert makes version 3 equal to version 1", async () => {
      expect(await root.write(path("notes/plan.md"), "1. gather\n2. draft\n3. ship\n", person)).toEqual({
        status: "saved",
        path: "notes/plan.md",
        version: 1,
      });
      expect(await root.write(path("notes/plan.md"), "1. gather\n2. rewrite\n3. ship\n", agent)).toEqual({
        status: "saved",
        path: "notes/plan.md",
        version: 2,
      });

      const head = await root.read(path("notes/plan.md"));
      expect(head).toMatchObject({ path: "notes/plan.md", text: "1. gather\n2. rewrite\n3. ship\n", version: 2 });
      expect((await store.readVersion(tenant, path("notes/plan.md"), 1)).text).toBe("1. gather\n2. draft\n3. ship\n");

      expect(await store.revertTo(tenant, path("notes/plan.md"), 1, person)).toEqual({
        status: "saved",
        path: "notes/plan.md",
        version: 3,
      });
      const reverted = await root.read(path("notes/plan.md"));
      const first = await store.readVersion(tenant, path("notes/plan.md"), 1);
      expect(reverted.version).toBe(3);
      expect(reverted.text).toBe(first.text);
      expect(reverted.sha256).toBe(first.sha256);

      const history = await store.listVersions(tenant, path("notes/plan.md"));
      expect(history.map((row) => [row.version, row.authorKind, row.authorId, row.mode])).toEqual([
        [1, "user", "user-1", null],
        [2, "agent", "run-1", "research"],
        [3, "user", "user-1", null],
      ]);
      expect(history[0]).toMatchObject({ bytes: 27, sha256: first.sha256 });
    });

    it("answers an identical body with the current version and writes nothing", async () => {
      await root.write(path("a.txt"), "same", person);
      const objects = db.prepare("SELECT count(*) AS n FROM desk_file_versions").get() as { n: number };
      expect(await root.write(path("a.txt"), "same", agent)).toEqual({ status: "saved", path: "a.txt", version: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM desk_file_versions").get()).toEqual(objects);
      expect((await store.listVersions(tenant, path("a.txt"))).length).toBe(1);

      await root.write(path("a.txt"), "changed", person);
      // Reverting to the version that is already the head changes nothing either.
      expect(await store.revertTo(tenant, path("a.txt"), 2, person)).toMatchObject({ version: 2 });
      expect((await store.listVersions(tenant, path("a.txt"))).length).toBe(2);
    });

    it("refuses a version that does not exist", async () => {
      await root.write(path("a.txt"), "one", person);
      for (const version of [0, -1, 2, 1.5, Number.NaN]) {
        expect(await refusalOf(store.readVersion(tenant, path("a.txt"), version))).toEqual({
          code: "not_found",
          message: "No file at that path.",
        });
      }
      expect((await refusalOf(store.revertTo(tenant, path("a.txt"), 9, person))).code).toBe("not_found");
      expect((await refusalOf(store.listVersions(tenant, path("missing.txt")))).code).toBe("not_found");
    });

    it("numbers parallel saves of one file one after another", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, index) => root.write(path("race.txt"), `body ${index}`, person)),
      );
      expect(outcomes.map((outcome) => (outcome.status === "saved" ? outcome.version : -1))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect((await root.read(path("race.txt"))).text).toBe("body 7");
    });
  });

  describe("compare and set", () => {
    afterEach(() => {
      setFileRootResolver(null);
    });

    it("refuses a write whose expected hash is no longer the head, and keeps the head", async () => {
      await root.write(path("a.txt"), "one", person);
      const readAt1 = await root.read(path("a.txt"));
      await root.write(path("a.txt"), "two", agent);

      const refused = await refusalOf(root.write(path("a.txt"), "three", agent, { expectedSha256: readAt1.sha256 }));
      expect(refused.code).toBe("conflict");
      expect(refused.message).toMatch(/read the file again/i);
      expect((await root.read(path("a.txt"))).text).toBe("two");
      expect((await store.listVersions(tenant, path("a.txt"))).length).toBe(2);
    });

    it("saves a write whose expected hash is the head, and a write that sends none", async () => {
      await root.write(path("a.txt"), "one", person);
      const head = await root.read(path("a.txt"));
      expect(await root.write(path("a.txt"), "two", agent, { expectedSha256: head.sha256 })).toMatchObject({
        status: "saved",
        version: 2,
      });
      expect(await root.write(path("a.txt"), "three", agent)).toMatchObject({ status: "saved", version: 3 });
    });

    it("refuses an expected hash for a file that was deleted after it was read", async () => {
      await root.write(path("a.txt"), "one", person);
      const head = await root.read(path("a.txt"));
      await root.remove(path("a.txt"), agent);
      expect((await refusalOf(root.write(path("a.txt"), "two", agent, { expectedSha256: head.sha256 }))).code).toBe(
        "conflict",
      );
      expect(await refusalOf(root.read(path("a.txt")))).toMatchObject({ code: "not_found" });
    });

    it("saves one of two edit_file calls made together and refuses the other, never overwriting silently", async () => {
      await root.write(path("plan.md"), "alpha\nbeta\ngamma\n", person);
      // The AI SDK runs one step's tool calls together. Hold both reads until both have the same text,
      // which is what an unlucky interleaving looks like.
      let reads = 0;
      let release: () => void = () => {};
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const raced: FileRoot = {
        ...root,
        read: async (target) => {
          const file = await root.read(target);
          reads += 1;
          if (reads === 2) {
            release();
          }
          await bothRead;
          return file;
        },
      };
      setFileRootResolver(async () => ({ root: raced, author: agent }));

      const outcomes = (await Promise.all([
        invokeTool(editFileTool, { path: "plan.md", old_string: "alpha", new_string: "ALPHA" }, tenant),
        invokeTool(editFileTool, { path: "plan.md", old_string: "gamma", new_string: "GAMMA" }, tenant),
      ])) as Array<{ ok: boolean; status?: string; code?: string; message?: string }>;

      const saved = outcomes.filter((outcome) => outcome.ok && outcome.status === "saved");
      const refused = outcomes.filter((outcome) => !outcome.ok);
      expect(saved).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ ok: false, code: "conflict" });
      expect(refused[0]?.message).toMatch(/read the file again/i);

      const text = (await root.read(path("plan.md"))).text;
      expect(["ALPHA\nbeta\ngamma\n", "alpha\nbeta\nGAMMA\n"]).toContain(text);
      expect((await store.listVersions(tenant, path("plan.md"))).length).toBe(2);

      // Doing what the message says (read again, redo the edit) lands the lost edit on top of the saved one.
      setFileRootResolver(async () => ({ root, author: agent }));
      const loser = text.includes("ALPHA") ? { old: "gamma", next: "GAMMA" } : { old: "alpha", next: "ALPHA" };
      expect(
        await invokeTool(editFileTool, { path: "plan.md", old_string: loser.old, new_string: loser.next }, tenant),
      ).toMatchObject({ ok: true, status: "saved", version: 3 });
      expect((await root.read(path("plan.md"))).text).toBe("ALPHA\nbeta\nGAMMA\n");
    });
  });

  describe("delete", () => {
    it("is soft: the file disappears, its history stays, and a new write starts a new file", async () => {
      await root.write(path("old.md"), "first life", person);
      await root.write(path("old.md"), "first life, edited", person);
      const [firstRow] = db.prepare("SELECT id FROM desk_files").all() as Array<{ id: string }>;

      expect(await root.remove(path("old.md"), agent)).toEqual({ status: "saved", path: "old.md", version: 2 });
      expect((await refusalOf(root.read(path("old.md")))).code).toBe("not_found");
      expect(await root.list(null)).toEqual([]);
      expect((await refusalOf(root.remove(path("old.md"), agent))).code).toBe("not_found");

      expect(await root.write(path("old.md"), "second life", person)).toEqual({
        status: "saved",
        path: "old.md",
        version: 1,
      });
      const rows = db.prepare("SELECT id, deleted_at FROM desk_files ORDER BY created_at, rowid").all() as Array<{
        id: string;
        deleted_at: number | null;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(firstRow?.id);
      expect(typeof rows[0]?.deleted_at).toBe("number");
      expect(rows[1]?.deleted_at).toBeNull();
      // The deleted file's two versions are still there.
      expect(
        (
          db.prepare("SELECT count(*) AS n FROM desk_file_versions WHERE file_id = ?").get(firstRow?.id) as {
            n: number;
          }
        ).n,
      ).toBe(2);
      expect((await store.listVersions(tenant, path("old.md"))).length).toBe(1);
    });
  });

  describe("caps", () => {
    it("takes exactly 2 MB and refuses one byte more, counted in UTF-8 bytes", async () => {
      expect(await root.write(path("big.txt"), "a".repeat(MAX_FILE_BYTES), person)).toMatchObject({ version: 1 });
      expect(await refusalOf(root.write(path("big.txt"), "a".repeat(MAX_FILE_BYTES + 1), person))).toEqual({
        code: "too_large",
        message: "The content is larger than 2 MB.",
      });
      // 1,048,577 two-byte characters is 2,097,154 bytes: under the cap by length, over it by bytes.
      expect((await refusalOf(root.write(path("wide.txt"), "é".repeat(1_048_577), person))).code).toBe("too_large");
      expect((await root.list(null)).map((entry) => entry.path)).toEqual(["big.txt"]);
    });

    it("refuses file number 2001 but still lets an existing file take a new version", async () => {
      const insert = db.prepare(
        `INSERT INTO desk_files (id, workspace_id, path, head_version, bytes, mime, sha256, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, 'text/plain', 'x', 1, 1)`,
      );
      db.transaction(() => {
        for (let index = 0; index < MAX_DESK_FILES - 1; index += 1) {
          insert.run(`filler-${index}`, tenant.workspaceId, `filler/${index}.txt`);
        }
      })();
      expect(await root.write(path("the-2000th.txt"), "last one", person)).toMatchObject({ version: 1 });
      expect(await refusalOf(root.write(path("the-2001st.txt"), "no room", person))).toEqual({
        code: "too_many_files",
        message: "This desk already holds 2000 files. Delete some first.",
      });
      expect(await root.write(path("the-2000th.txt"), "last one, edited", person)).toMatchObject({ version: 2 });
      // The cap counts live files only.
      await root.remove(path("the-2000th.txt"), person);
      expect(await root.write(path("the-2001st.txt"), "now there is room", person)).toMatchObject({ version: 1 });
    });

    it("counts desks separately", async () => {
      const other = store.createDeskRoot({ ...tenant, workspaceId: "another-desk" }, person);
      await root.write(path("a.txt"), "x", person);
      expect(await other.list(null)).toEqual([]);
      expect(await other.write(path("a.txt"), "y", person)).toMatchObject({ version: 1 });
    });

    it("refuses content that is not text", async () => {
      expect(await refusalOf(root.write(path("bin.dat"), "before\u0000after", person))).toEqual({
        code: "denied",
        message: "Desk files are text. The content has a NUL character.",
      });
      expect(await refusalOf(root.write(path("bad.txt"), "broken \ud800 pair", person))).toEqual({
        code: "denied",
        message: "The content is not valid UTF-8 text.",
      });
      expect(await root.list(null)).toEqual([]);
    });

    it("does not let a path be both a file and a folder", async () => {
      await root.write(path("notes"), "a file named notes", person);
      expect(await refusalOf(root.write(path("notes/plan.md"), "inside it", person))).toEqual({
        code: "bad_path",
        message: "A file already has the name of one of this path's folders.",
      });
      await root.write(path("docs/readme.md"), "x", person);
      expect(await refusalOf(root.write(path("docs"), "over the folder", person))).toEqual({
        code: "bad_path",
        message: "That path is a folder with files in it, so it cannot also be a file.",
      });
      // A sibling that merely shares a prefix is fine.
      expect(await root.write(path("docs2"), "ok", person)).toMatchObject({ version: 1 });
    });
  });

  describe("list and search", () => {
    beforeEach(async () => {
      await root.write(path("readme.md"), "alpha\nBeta line\nalpha again\n", person);
      await root.write(path("notes/plan.md"), "plan with alpha\n", person);
      await root.write(path("notes/deep/idea.txt"), "idea\n", person);
      await root.write(path("src/app.ts"), "export const alpha = 1;\n", person);
    });

    it("lists every live file under a folder, newest head first-class fields only", async () => {
      const all = await root.list(null);
      expect(all.map((entry) => entry.path)).toEqual([
        "notes/deep/idea.txt",
        "notes/plan.md",
        "readme.md",
        "src/app.ts",
      ]);
      expect(all[1]).toEqual({
        path: "notes/plan.md",
        kind: "file",
        bytes: 16,
        updatedAt: expect.any(Number),
        version: 1,
      });
      expect((await root.list(path("notes"))).map((entry) => entry.path)).toEqual([
        "notes/deep/idea.txt",
        "notes/plan.md",
      ]);
      // A folder name is not a prefix match on a longer name.
      expect(await root.list(path("note"))).toEqual([]);
    });

    it("filters by a glob matched against the full path", async () => {
      // A whole `**` part crosses zero or more folders, so it reaches the top level too.
      expect((await root.list(null, "**/*.md")).map((entry) => entry.path)).toEqual(["notes/plan.md", "readme.md"]);
      expect((await root.list(null, "notes/*.md")).map((entry) => entry.path)).toEqual(["notes/plan.md"]);
      expect((await root.list(null, "*.md")).map((entry) => entry.path)).toEqual(["readme.md"]);
      expect((await root.list(path("notes"), "notes/**/*.txt")).map((entry) => entry.path)).toEqual([
        "notes/deep/idea.txt",
      ]);
    });

    it("finds plain text, case sensitive, one hit per line, in path order", async () => {
      expect(await root.search("alpha")).toEqual([
        { path: "notes/plan.md", line: 1, text: "plan with alpha" },
        { path: "readme.md", line: 1, text: "alpha" },
        { path: "readme.md", line: 3, text: "alpha again" },
        { path: "src/app.ts", line: 1, text: "export const alpha = 1;" },
      ]);
      expect(await root.search("ALPHA")).toEqual([]);
      expect(await root.search("")).toEqual([]);
      expect((await root.search("alpha", "src/**")).map((hit) => hit.path)).toEqual(["src/app.ts"]);
    });

    it("returns one hit past the cap so the tool can say there are more", async () => {
      await root.write(path("log.txt"), `${"error here\n".repeat(MAX_SEARCH_HITS + 50)}`, person);
      const hits = await root.search("error");
      expect(hits).toHaveLength(MAX_SEARCH_HITS + 1);
    });

    it("stops reading once 50 MB of plain text has been searched", async () => {
      const big = 30 * 1024 * 1024;
      db.prepare("UPDATE desk_files SET bytes = ? WHERE path IN ('notes/plan.md', 'readme.md')").run(big);
      // notes/plan.md is read (30 MB); readme.md would make 60 MB, so the search ends before it.
      expect((await root.search("alpha")).map((hit) => hit.path)).toEqual(["notes/plan.md"]);
    });

    it("skips a file whose object has gone missing instead of failing the search", async () => {
      const [row] = db
        .prepare(
          "SELECT object_key FROM desk_file_versions v JOIN desk_files f ON f.id = v.file_id WHERE f.path = 'readme.md'",
        )
        .all() as Array<{ object_key: string }>;
      db.prepare("UPDATE desk_file_versions SET object_key = ? WHERE object_key = ?").run(
        "desk-files/gone/1",
        row?.object_key,
      );
      expect((await root.search("alpha")).map((hit) => hit.path)).toEqual(["notes/plan.md", "src/app.ts"]);
      expect((await refusalOf(root.read(path("readme.md")))).code).toBe("not_found");
    });
  });

  describe("the desk boundary", () => {
    it("shows another desk and another tenant nothing, by any verb", async () => {
      await root.write(path("secret.md"), SECRET_TEXT, person);
      await root.write(path("secret.md"), `${SECRET_TEXT}!`, person);

      const otherDesk = { ...tenant, workspaceId: "someone-elses-desk" };
      const otherTenant = { ...tenant, tenantId: "tenant-beta", workspaceId: "beta-desk" };
      for (const stranger of [otherDesk, otherTenant]) {
        const theirs = store.createDeskRoot(stranger, person);
        expect(await theirs.list(null)).toEqual([]);
        expect(await theirs.search("launch")).toEqual([]);
        expect((await refusalOf(theirs.read(path("secret.md")))).code).toBe("not_found");
        expect((await refusalOf(theirs.remove(path("secret.md"), person))).code).toBe("not_found");
        expect((await refusalOf(store.listVersions(stranger, path("secret.md")))).code).toBe("not_found");
        expect((await refusalOf(store.readVersion(stranger, path("secret.md"), 1))).code).toBe("not_found");
        expect((await refusalOf(store.revertTo(stranger, path("secret.md"), 1, person))).code).toBe("not_found");
      }
      // And nothing was touched.
      expect((await root.read(path("secret.md"))).version).toBe(2);
    });

    it("never reads an object from another tenant's prefix, whatever a row says", async () => {
      const mine = { ...tenant, tenantId: "tenant-alpha" };
      const alpha = store.createDeskRoot(mine, person);
      await alpha.write(path("a.md"), "alpha's", person);
      const beta = { ...tenant, tenantId: "tenant-beta" };
      // Point tenant beta's row at tenant alpha's object. The key guard answers before any IO.
      const { object_key } = db.prepare("SELECT object_key FROM desk_file_versions").get() as { object_key: string };
      db.prepare("UPDATE desk_files SET workspace_id = ?").run(beta.workspaceId);
      expect(object_key.startsWith("tenants/tenant-alpha/desk-files/")).toBe(true);
      const theirs = store.createDeskRoot(beta, person);
      expect((await refusalOf(theirs.read(path("a.md")))).code).toBe("not_found");
    });
  });

  describe("bodies at rest", () => {
    it("holds no plain text in the database or the object store", async () => {
      await root.write(path("secrets/codes.md"), SECRET_TEXT, person);
      const dump =
        JSON.stringify(db.prepare("SELECT * FROM desk_files").all()) +
        JSON.stringify(db.prepare("SELECT * FROM desk_file_versions").all());
      expect(dump).not.toContain("launch codes");

      const { object_key } = db.prepare("SELECT object_key FROM desk_file_versions").get() as { object_key: string };
      expect(object_key).toMatch(/^desk-files\/[0-9a-f-]{36}\/1$/);
      const raw = Buffer.from(await readTenantObject(LOCAL_TENANT_ID, object_key)).toString("utf8");
      expect(raw).not.toContain("launch codes");
      expect(raw).not.toContain("0000-1111");
      expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: "aes-256-gcm" });
    });

    it("refuses to hand back an object it cannot open instead of showing its bytes", async () => {
      await root.write(path("a.md"), "real text", person);
      const wrongKey = createDeskFileStore(db, () => wrappingKeyFromSecret("d".repeat(64)));
      expect(await refusalOf(wrongKey.createDeskRoot(tenant, person).read(path("a.md")))).toEqual({
        code: "root_unavailable",
        message: "That file could not be read.",
      });
    });
  });

  describe("a failed save", () => {
    it("removes the object it wrote when the rows do not commit", async () => {
      await root.write(path("a.md"), "one", person);
      const { id } = db.prepare("SELECT id FROM desk_files").get() as { id: string };
      // A stray row where version 2 will go makes the version insert collide after the object is put.
      db.prepare(
        "INSERT INTO desk_file_versions (file_id, version, object_key, bytes, sha256, author_kind, author_id, created_at) VALUES (?, 2, 'stray', 1, 'x', 'user', 'u', 1)",
      ).run(id);

      await expect(root.write(path("a.md"), "two", person)).rejects.toThrow(/UNIQUE|PRIMARY/i);

      const key = `desk-files/${id}/2`;
      await expect(readTenantObject(LOCAL_TENANT_ID, key)).rejects.toMatchObject({ code: "not_found" });
      expect((await root.read(path("a.md"))).text).toBe("one");
    });
  });

  describe("the tenant quota", () => {
    let counters: Database.Database;

    beforeEach(() => {
      counters = new Database(":memory:");
      counters.exec(`
        CREATE TABLE tenants (id text PRIMARY KEY NOT NULL);
        CREATE TABLE tenant_storage (
          tenant_id text PRIMARY KEY NOT NULL REFERENCES tenants(id) ON DELETE cascade,
          bytes_used integer DEFAULT 0 NOT NULL,
          object_count integer DEFAULT 0 NOT NULL,
          measured_at integer,
          updated_at integer NOT NULL
        );
      `);
      counters.prepare("INSERT INTO tenants (id) VALUES (?)").run("tenant-quota");
      registerTenantStorageSql(counters);
      resetObjectStoreForTests();
      // The counter is seeded from what the tenant already holds on disk, so start from nothing.
      rmSync(nodePath.join(mediaRoot(), "tenants"), { recursive: true, force: true });
      process.env.AGENTFORGE_SERVER = "1";
    });

    afterEach(() => {
      delete process.env.AGENTFORGE_SERVER;
      delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
      resetTenantStorageSqlForTests();
      resetObjectStoreForTests();
      counters.close();
    });

    it("charges every saved version to the tenant and refuses a write past the ceiling", async () => {
      process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "3000";
      const hosted = store.createDeskRoot({ ...tenant, tenantId: "tenant-quota" }, person);

      await hosted.write(path("a.md"), "small", person);
      const afterFirst = readTenantStorageCounter("tenant-quota");
      expect(afterFirst?.objectCount).toBe(1);
      expect(afterFirst?.bytesUsed).toBeGreaterThan(0);
      await hosted.write(path("a.md"), "small, edited", person);
      expect(readTenantStorageCounter("tenant-quota")?.objectCount).toBe(2);

      const before = readTenantStorageCounter("tenant-quota");
      expect(await refusalOf(hosted.write(path("b.md"), "x".repeat(4000), person))).toEqual({
        code: "quota",
        message: expect.stringContaining("no storage space left"),
      });
      // The refusal stored nothing: no row, no object, no charge.
      expect(readTenantStorageCounter("tenant-quota")).toEqual(before);
      expect((await hosted.list(null)).map((entry) => entry.path)).toEqual(["a.md"]);
    });

    it("does not charge a save that changes nothing", async () => {
      process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "100000";
      const hosted = store.createDeskRoot({ ...tenant, tenantId: "tenant-quota" }, person);
      await hosted.write(path("a.md"), "same", person);
      const before = readTenantStorageCounter("tenant-quota");
      await hosted.write(path("a.md"), "same", person);
      expect(readTenantStorageCounter("tenant-quota")).toEqual(before);
    });

    it("gives the bytes back when a desk is purged", async () => {
      process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "100000";
      const mine = { ...tenant, tenantId: "tenant-quota" };
      const hosted = store.createDeskRoot(mine, person);
      await hosted.write(path("a.md"), "one", person);
      await hosted.write(path("a.md"), "two", person);
      await hosted.write(path("b.md"), "three", person);
      expect(readTenantStorageCounter("tenant-quota")?.objectCount).toBe(3);

      expect(await store.purgeDesk(mine)).toEqual({ files: 2, objects: 3 });
      expect(readTenantStorageCounter("tenant-quota")).toMatchObject({ bytesUsed: 0, objectCount: 0 });
      expect(await hosted.list(null)).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM desk_file_versions").get()).toEqual({ n: 0 });
    });
  });

  describe("purging a desk", () => {
    it("removes that desk's files, versions and objects and leaves the other desks alone", async () => {
      const other = { ...tenant, workspaceId: "kept-desk" };
      const keeper = store.createDeskRoot(other, person);
      await root.write(path("a.md"), "one", person);
      await root.write(path("a.md"), "two", person);
      await keeper.write(path("a.md"), "kept", person);
      const { object_key } = db
        .prepare(
          "SELECT object_key FROM desk_file_versions v JOIN desk_files f ON f.id = v.file_id WHERE f.workspace_id = ? AND v.version = 1",
        )
        .get(tenant.workspaceId) as { object_key: string };

      expect(await store.purgeDesk(tenant)).toEqual({ files: 1, objects: 2 });

      expect(await root.list(null)).toEqual([]);
      await expect(readTenantObject(LOCAL_TENANT_ID, object_key)).rejects.toMatchObject({ code: "not_found" });
      expect((await keeper.read(path("a.md"))).text).toBe("kept");
      expect(await store.purgeDesk(tenant)).toEqual({ files: 0, objects: 0 });
    });
  });
});
