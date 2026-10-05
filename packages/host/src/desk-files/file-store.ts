import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ApiError, type TenantContext } from "@agentforge/core";
import {
  FileRootError,
  globMatcher,
  MAX_FILE_BYTES,
  MAX_SEARCH_HITS,
  searchLiteralLines,
  utf8ByteLength,
} from "@agentforge/core/tools/files";
import type {
  DeskPath,
  FileAuthor,
  FileEntry,
  FileRead,
  FileRoot,
  SearchHit,
  WriteOptions,
  WriteOutcome,
} from "@agentforge/core/tools/files";
import { log } from "../log";
import { tenantRelativePath } from "../tenant-paths";
import { isStorageQuotaError, putTenantObject, readTenantObject, removeTenantObject } from "../tenant-storage";
import { openBody, sealBody } from "./body";
import { withDeskLock } from "./lock";
import { mimeForPath } from "./mime";

export const MAX_DESK_FILES = 2000;
/** What one `search` may decrypt, counted in plain-text bytes. */
export const MAX_SEARCH_READ_BYTES = 50 * 1024 * 1024;
/** First segment of every object key a desk file owns: `desk-files/<fileId>/<version>`. */
export const DESK_OBJECT_DIR = "desk-files";

const NOT_FOUND = "No file at that path.";
const QUOTA_MESSAGE =
  "This account has no storage space left, so the file was not saved. Every saved version counts, so deleting a file does not free space; ask the account owner.";
const CONFLICT_MESSAGE =
  "The file changed after it was read (or was deleted), so this edit was not saved. Read the file again and redo the edit.";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type DeskFileVersion = {
  readonly version: number;
  /** Plain-text size. The sealed object the quota counts is larger. */
  readonly bytes: number;
  readonly sha256: string;
  readonly authorKind: "user" | "agent";
  /** The user id, or the run id for an agent. */
  readonly authorId: string;
  readonly mode: string | null;
  readonly createdAt: number;
};

export type DeskFileStore = {
  createDeskRoot(tenant: TenantContext, author: FileAuthor): FileRoot;
  listVersions(tenant: TenantContext, path: DeskPath): Promise<DeskFileVersion[]>;
  readVersion(tenant: TenantContext, path: DeskPath, version: number): Promise<FileRead>;
  /** A new version equal to an old one. History only grows; reverting to the head changes nothing. */
  revertTo(tenant: TenantContext, path: DeskPath, version: number, author: FileAuthor): Promise<WriteOutcome>;
  /** Remove every file, version row and object of one desk. Call it before the desk row goes. */
  purgeDesk(tenant: TenantContext): Promise<{ files: number; objects: number }>;
};

type LiveRow = {
  id: string;
  path: string;
  head_version: number;
  bytes: number;
  sha256: string;
  updated_at: number;
  object_key: string;
};

type VersionRow = {
  version: number;
  object_key: string;
  bytes: number;
  sha256: string;
  author_kind: "user" | "agent";
  author_id: string;
  mode: string | null;
  created_at: number;
};

/** Rows only ever hold paths `parseDeskPath` accepted, so the brand is restored on the way out. */
function asDeskPath(value: string): DeskPath {
  return value as DeskPath;
}

function notFound(): never {
  throw new FileRootError("not_found", NOT_FOUND);
}

function saved(path: DeskPath, version: number): WriteOutcome {
  return { status: "saved", path, version };
}

function authorColumns(by: FileAuthor): { kind: "user" | "agent"; id: string; mode: string | null } {
  return by.kind === "user"
    ? { kind: "user", id: by.userId, mode: null }
    : { kind: "agent", id: by.runId, mode: by.mode };
}

function checkContent(content: string): void {
  if (content.length > MAX_FILE_BYTES || utf8ByteLength(content) > MAX_FILE_BYTES) {
    throw new FileRootError("too_large", "The content is larger than 2 MB.");
  }
  if (content.includes("\u0000")) {
    throw new FileRootError("denied", "Desk files are text. The content has a NUL character.");
  }
  if (LONE_SURROGATE.test(content)) {
    throw new FileRootError("denied", "The content is not valid UTF-8 text.");
  }
}

/**
 * The desk's versioned file store over one SQLite connection and the tenant object store.
 *
 * Rows say which files exist and which version is the head; each version's text is a sealed object
 * written through `putTenantObject`, so the tenant quota counts every one and an erase of the tenant
 * removes them with its prefix. Every query carries the desk id (`tenant.workspaceId`), exactly as
 * the artifact store does, so another desk's or another tenant's path is simply not found.
 */
export function createDeskFileStore(db: Database.Database, keyProvider: () => Buffer): DeskFileStore {
  const liveSelect = `SELECT f.id, f.path, f.head_version, f.bytes, f.sha256, f.updated_at, v.object_key
       FROM desk_files f
       JOIN desk_file_versions v ON v.file_id = f.id AND v.version = f.head_version
      WHERE f.workspace_id = ? AND f.deleted_at IS NULL`;

  function findLive(workspaceId: string, path: string): LiveRow | undefined {
    return db.prepare(`${liveSelect} AND f.path = ?`).get(workspaceId, path) as LiveRow | undefined;
  }

  function requireLive(workspaceId: string, path: string): LiveRow {
    return findLive(workspaceId, path) ?? notFound();
  }

  function liveRows(workspaceId: string, dir: DeskPath | null): LiveRow[] {
    if (dir === null) {
      return db.prepare(`${liveSelect} ORDER BY f.path`).all(workspaceId) as LiveRow[];
    }
    const prefix = `${dir}/`;
    return db
      .prepare(`${liveSelect} AND substr(f.path, 1, ?) = ? ORDER BY f.path`)
      .all(workspaceId, prefix.length, prefix) as LiveRow[];
  }

  async function readText(tenant: TenantContext, fileId: string, objectKey: string): Promise<string> {
    try {
      return openBody(await readTenantObject(tenant.tenantId, objectKey), keyProvider());
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") {
        log.warn("desk_file_object_missing", { fileId });
        notFound();
      }
      log.warn("desk_file_unreadable", { fileId, detail: error instanceof Error ? error.name : "unknown" });
      throw new FileRootError("root_unavailable", "That file could not be read.");
    }
  }

  async function putSealed(tenant: TenantContext, objectKey: string, content: string): Promise<void> {
    try {
      await putTenantObject(tenant.tenantId, objectKey, sealBody(content, keyProvider()), "application/octet-stream");
    } catch (error) {
      if (isStorageQuotaError(error)) {
        throw new FileRootError("quota", QUOTA_MESSAGE);
      }
      // An OS error's text can carry an absolute path, and this message reaches the model.
      log.error("desk_file_put_failed", { detail: error instanceof Error ? error.name : "unknown" });
      throw new FileRootError("root_unavailable", "The file store could not save this file. Try again later.");
    }
  }

  /** A new file needs room under the cap, and its name must not be a folder or sit inside a file. */
  function assertRoomFor(workspaceId: string, path: string): void {
    const live = db
      .prepare("SELECT count(*) AS n FROM desk_files WHERE workspace_id = ? AND deleted_at IS NULL")
      .get(workspaceId) as { n: number };
    if (live.n >= MAX_DESK_FILES) {
      throw new FileRootError("too_many_files", `This desk already holds ${MAX_DESK_FILES} files. Delete some first.`);
    }
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      if (findLive(workspaceId, segments.slice(0, end).join("/"))) {
        throw new FileRootError("bad_path", "A file already has the name of one of this path's folders.");
      }
    }
    const below = db
      .prepare(
        "SELECT 1 AS found FROM desk_files WHERE workspace_id = ? AND deleted_at IS NULL AND substr(path, 1, ?) = ? LIMIT 1",
      )
      .get(workspaceId, path.length + 1, `${path}/`);
    if (below) {
      throw new FileRootError("bad_path", "That path is a folder with files in it, so it cannot also be a file.");
    }
  }

  /**
   * The caller holds the desk lock, which is what makes the compare-and-set sound: the head is read
   * and the new version committed with no other save of this desk in between.
   */
  async function saveLocked(
    tenant: TenantContext,
    path: DeskPath,
    content: string,
    by: FileAuthor,
    options?: WriteOptions,
  ): Promise<WriteOutcome> {
    checkContent(content);
    const data = Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const live = findLive(tenant.workspaceId, path);
    // Before the no-op shortcut: a stale edit that happens to equal the head is still a lost update
    // for the caller, who computed it from older text.
    if (options?.expectedSha256 !== undefined && live?.sha256 !== options.expectedSha256) {
      throw new FileRootError("conflict", CONFLICT_MESSAGE);
    }
    if (live?.sha256 === sha256) {
      return saved(path, live.head_version);
    }
    if (!live) {
      assertRoomFor(tenant.workspaceId, path);
    }
    const fileId = live?.id ?? randomUUID();
    const version = (live?.head_version ?? 0) + 1;
    const objectKey = tenantRelativePath(tenant.tenantId, [DESK_OBJECT_DIR, fileId], String(version));
    await putSealed(tenant, objectKey, content);

    const now = Date.now();
    const author = authorColumns(by);
    try {
      db.transaction(() => {
        if (live) {
          const moved = db
            .prepare(
              `UPDATE desk_files SET head_version = ?, bytes = ?, mime = ?, sha256 = ?, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND head_version = ? AND deleted_at IS NULL`,
            )
            .run(version, data.length, mimeForPath(path), sha256, now, fileId, tenant.workspaceId, live.head_version);
          if (moved.changes !== 1) {
            throw new FileRootError("root_unavailable", "The file changed while it was being saved. Try again.");
          }
        } else {
          db.prepare(
            `INSERT INTO desk_files (id, workspace_id, path, head_version, bytes, mime, sha256, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(fileId, tenant.workspaceId, path, version, data.length, mimeForPath(path), sha256, now, now);
        }
        db.prepare(
          `INSERT INTO desk_file_versions (file_id, version, object_key, bytes, sha256, author_kind, author_id, mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(fileId, version, objectKey, data.length, sha256, author.kind, author.id, author.mode, now);
      })();
    } catch (error) {
      // The rows did not commit, so the object is unreferenced: give the bytes back.
      await removeTenantObject(tenant.tenantId, objectKey).catch(() => {
        log.warn("desk_file_orphan_object", { fileId, version });
      });
      throw error;
    }
    log.info("desk_file_saved", { fileId, version, bytes: data.length, authorKind: author.kind });
    return saved(path, version);
  }

  async function readVersionLocked(tenant: TenantContext, path: DeskPath, version: number): Promise<FileRead> {
    const live = requireLive(tenant.workspaceId, path);
    if (!Number.isInteger(version) || version < 1) {
      notFound();
    }
    const row = db
      .prepare("SELECT object_key, bytes, sha256 FROM desk_file_versions WHERE file_id = ? AND version = ?")
      .get(live.id, version) as Pick<VersionRow, "object_key" | "bytes" | "sha256"> | undefined;
    if (!row) {
      notFound();
    }
    return {
      path,
      text: await readText(tenant, live.id, row.object_key),
      sha256: row.sha256,
      bytes: row.bytes,
      version,
    };
  }

  function createDeskRoot(tenant: TenantContext, author: FileAuthor): FileRoot {
    return {
      kind: "desk",

      async list(dir, glob) {
        const matches = glob ? globMatcher(glob) : () => true;
        return liveRows(tenant.workspaceId, dir)
          .filter((row) => matches(row.path))
          .map(
            (row): FileEntry => ({
              path: asDeskPath(row.path),
              kind: "file",
              bytes: row.bytes,
              updatedAt: row.updated_at,
              version: row.head_version,
            }),
          );
      },

      async read(path) {
        const live = requireLive(tenant.workspaceId, path);
        return {
          path,
          text: await readText(tenant, live.id, live.object_key),
          sha256: live.sha256,
          bytes: live.bytes,
          version: live.head_version,
        };
      },

      write: (path, content, by, options) =>
        withDeskLock(tenant.workspaceId, () => saveLocked(tenant, path, content, by ?? author, options)),

      remove: (path, by) =>
        withDeskLock(tenant.workspaceId, async () => {
          const live = requireLive(tenant.workspaceId, path);
          const now = Date.now();
          const done = db
            .prepare(
              "UPDATE desk_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL",
            )
            .run(now, now, live.id, tenant.workspaceId);
          if (done.changes !== 1) {
            notFound();
          }
          log.info("desk_file_deleted", { fileId: live.id, authorKind: (by ?? author).kind });
          return saved(path, live.head_version);
        }),

      async search(pattern, glob) {
        if (pattern === "") {
          return [];
        }
        const matches = glob ? globMatcher(glob) : () => true;
        const hits: SearchHit[] = [];
        let readBytes = 0;
        for (const row of liveRows(tenant.workspaceId, null)) {
          if (!matches(row.path)) {
            continue;
          }
          if (readBytes + row.bytes > MAX_SEARCH_READ_BYTES) {
            break;
          }
          readBytes += row.bytes;
          let text: string;
          try {
            text = await readText(tenant, row.id, row.object_key);
          } catch (error) {
            if (error instanceof FileRootError) {
              continue;
            }
            throw error;
          }
          // One past the cap, so the tool can tell "exactly 200" from "more than 200".
          hits.push(...searchLiteralLines(asDeskPath(row.path), text, pattern, MAX_SEARCH_HITS + 1 - hits.length));
          if (hits.length > MAX_SEARCH_HITS) {
            break;
          }
        }
        return hits;
      },
    };
  }

  return {
    createDeskRoot,

    async listVersions(tenant, path) {
      const live = requireLive(tenant.workspaceId, path);
      const rows = db
        .prepare(
          `SELECT version, object_key, bytes, sha256, author_kind, author_id, mode, created_at
             FROM desk_file_versions WHERE file_id = ? ORDER BY version`,
        )
        .all(live.id) as VersionRow[];
      return rows.map((row) => ({
        version: row.version,
        bytes: row.bytes,
        sha256: row.sha256,
        authorKind: row.author_kind,
        authorId: row.author_id,
        mode: row.mode,
        createdAt: row.created_at,
      }));
    },

    readVersion: (tenant, path, version) => readVersionLocked(tenant, path, version),

    revertTo: (tenant, path, version, author) =>
      withDeskLock(tenant.workspaceId, async () => {
        const old = await readVersionLocked(tenant, path, version);
        return saveLocked(tenant, path, old.text, author);
      }),

    purgeDesk: (tenant) =>
      withDeskLock(tenant.workspaceId, async () => {
        const keys = db
          .prepare(
            `SELECT v.object_key AS object_key FROM desk_file_versions v
               JOIN desk_files f ON f.id = v.file_id WHERE f.workspace_id = ?`,
          )
          .all(tenant.workspaceId) as Array<{ object_key: string }>;
        // Objects first: a failure leaves the rows, so the purge can be run again.
        for (const { object_key } of keys) {
          await removeTenantObject(tenant.tenantId, object_key);
        }
        return db.transaction(() => {
          db.prepare(
            "DELETE FROM desk_file_versions WHERE file_id IN (SELECT id FROM desk_files WHERE workspace_id = ?)",
          ).run(tenant.workspaceId);
          const files = db.prepare("DELETE FROM desk_files WHERE workspace_id = ?").run(tenant.workspaceId);
          return { files: files.changes, objects: keys.length };
        })();
      }),
  };
}
