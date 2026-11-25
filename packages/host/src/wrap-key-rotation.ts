/**
 * Phase 4 — rotating the key that every tenant's secrets and encrypted stores are sealed under.
 *
 * One wrap key (`AGENTFORGE_SECRETS_KEY`, or `.master-key` on a desk) encrypts every tenant's
 * `settings` payload, session refresh tokens (`auth_sessions.refresh_sealed`), and all at-rest
 * encrypted columns/objects (`messages.content`, `tool_invocations.input/output`,
 * `agent_versions.system_prompt`, `artifacts.body`, `threads.title`, `knowledge_sources.name` on
 * thread cards, `knowledge_graph_nodes.label`, `customer_conversations`, `customer_messages`, and
 * `desk_files` objects) through `packages/core/src/crypto/envelope.ts`.
 *
 * **Decrypt everything before writing anything.** The rotation is a two-phase commit:
 * every sealed payload across every store is opened with the old key and re-sealed in memory first,
 * and only if ALL of them opened does anything get written. A key that is wrong for any single row
 * or file therefore costs nothing rather than leaving the database in a split-key state.
 *
 * **Verify after writing.** Each stored payload is read back and opened with the new key before the
 * run reports success.
 *
 * What is NOT rotated, and does not need to be: the gate verdict (`gateway_gate`) is plain JSON
 * carrying a key fingerprint, never a key, so no wrap key opens or closes it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  decryptJson,
  encryptJson,
  isEnvelope,
  isServerMode,
  LOCAL_TENANT_ID,
  objectStorageKind,
  wrappingKeyFromSecret,
} from "@agentforge/core";
import { decodeVaultKey, hasKeyLikeVariety, MIN_VAULT_KEY_BYTES, sqliteFilePath } from "@agentforge/db/vault-key";
import { openRefresh, sealRefresh } from "./auth/session-secrets";
import { mediaRoot } from "./media-root";
import { resolveInsideTenantRoot, TENANTS_DIR } from "./tenant-paths";
import {
  registeredTenantStateSql,
  tenantStateBackend,
  type TenantStateBackend,
  type TenantStateSql,
} from "./tenant-state-store";
import { log } from "./log";

/** The sealed refresh tokens on `auth_sessions`, as the rotation reads and rewrites them. */
export interface SealedSessionTokens {
  /** Every live session holding one: its stored id (the digest) and the sealed string. */
  list(): Array<{ readonly id: string; readonly sealed: string }>;
  /** Write `next` only if the row still holds `expected` and is live. Whether it did. */
  replace(id: string, expected: string, next: string): boolean;
  read(id: string): string | null;
}

/** A desk's database: the desktop and webdev never sign in, so there is nothing to carry. */
const NO_SESSION_TOKENS: SealedSessionTokens = {
  list: () => [],
  replace: () => false,
  read: () => null,
};

/** The session tokens over the hosted store's own connection. */
export function sqlSessionTokens(sql: TenantStateSql): SealedSessionTokens {
  return {
    list() {
      const rows = sql
        .prepare(
          "SELECT id, refresh_sealed FROM auth_sessions WHERE refresh_sealed IS NOT NULL AND revoked_at IS NULL ORDER BY id",
        )
        .all() as Array<{ id: string; refresh_sealed: string }>;
      return rows.map((row) => ({ id: row.id, sealed: row.refresh_sealed }));
    },
    replace(id, expected, next) {
      const result = sql
        .prepare(
          "UPDATE auth_sessions SET refresh_sealed = ? WHERE id = ? AND refresh_sealed = ? AND revoked_at IS NULL",
        )
        .run(next, id, expected) as { changes?: number };
      return Number(result.changes ?? 0) === 1;
    },
    read(id) {
      const row = sql.prepare("SELECT refresh_sealed FROM auth_sessions WHERE id = ?").get(id) as
        | { refresh_sealed: string | null }
        | undefined;
      return row?.refresh_sealed ?? null;
    },
  };
}

function defaultSessionTokens(): SealedSessionTokens {
  return isServerMode() ? sqlSessionTokens(registeredTenantStateSql()) : NO_SESSION_TOKENS;
}

/** Synchronous reader/writer for sealed `desk_files` objects stored by `object_key`. */
export interface DeskFileObjects {
  read(objectKey: string): string | null;
  write(objectKey: string, content: string): void;
}

function tenantIdForObjectKey(objectKey: string): string {
  const prefix = `${TENANTS_DIR}/`;
  if (!objectKey.startsWith(prefix)) {
    return LOCAL_TENANT_ID;
  }
  return objectKey.slice(prefix.length).split("/")[0] || LOCAL_TENANT_ID;
}

function localDeskFilePath(objectKey: string): string | null {
  const root = mediaRoot();
  const tenantId = tenantIdForObjectKey(objectKey);
  return resolveInsideTenantRoot(root, tenantId, path.resolve(root, objectKey));
}

const fileDeskFileObjects: DeskFileObjects = {
  read(objectKey) {
    if (objectStorageKind() !== "file") {
      return null;
    }
    const target = localDeskFilePath(objectKey);
    if (!target || !existsSync(target)) {
      return null;
    }
    return readFileSync(target, "utf8");
  },
  write(objectKey, content) {
    if (objectStorageKind() !== "file") {
      throw new WrapKeyRotationError(`Cannot synchronously write remote object ${objectKey} during wrap-key rotation.`);
    }
    const target = localDeskFilePath(objectKey);
    if (!target) {
      throw new WrapKeyRotationError(`Invalid desk file object key ${objectKey}.`);
    }
    const temp = `${target}.tmp`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, target);
  },
};

/** A session named in a refusal: the first characters of its digest, never the digest, never a token. */
function sessionLabel(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** The payload the wrap key seals. The other `TenantStateKey` holds no secret. */
const SETTINGS_KEY = "settings" as const;

export type RotateWrapKeyInput = {
  /** The secret the payloads are sealed under today, in the shapes `vault-key.ts` accepts. */
  from: string;
  /** The secret to seal them under. Refused unless it is at least as strong as `from` must be. */
  to: string;
  /** Open and re-seal everything, report, and write nothing. The rehearsal half of the drill. */
  dryRun?: boolean;
  /** Injected by the tests; defaults to the backend this process's mode selects. */
  backend?: TenantStateBackend;
  /** Injected by the tests; defaults to `auth_sessions` in server mode and to nothing on a desk. */
  sessionTokens?: SealedSessionTokens;
  /** Injected by the tests; defaults to `registeredTenantStateSql()` for db backend or local sqlite file when present. */
  sql?: TenantStateSql | null;
  /** Injected by the tests; defaults to the local `mediaRoot()` object tree. */
  deskFiles?: DeskFileObjects;
};

export type EncryptedStoreRotationCounts = {
  messages: number;
  toolInvocations: number;
  agentVersions: number;
  artifacts: number;
  threads: number;
  customerConversations: number;
  customerMessages: number;
  deskFiles: number;
  knowledgeSources: number;
  knowledgeGraphNodes: number;
};

export type RotateWrapKeyResult = {
  /** Tenants whose payload was re-sealed, or would have been on a dry run. */
  rotated: string[];
  /** Tenants that hold no sealed payload at all. Reported so a count can be reconciled. */
  skipped: string[];
  /** Session refresh tokens re-sealed, or that would have been on a dry run. */
  sessionTokens: number;
  /**
   * Session tokens the running app replaced or ended between the read and the write. Not written;
   * each of those sessions ends cleanly at its next check under the new key.
   */
  sessionTokensChanged: number;
  /** Counts of rows/objects re-sealed across all additional encrypted stores. */
  encryptedStores: EncryptedStoreRotationCounts;
  dryRun: boolean;
  backend: "file" | "db";
};

export class WrapKeyRotationError extends Error {
  readonly tenantId: string | null;

  constructor(message: string, tenantId: string | null = null) {
    super(message);
    this.name = "WrapKeyRotationError";
    this.tenantId = tenantId;
  }
}

/**
 * The same floor `getLocalVaultKey` enforces in server mode, applied to both keys here.
 */
function assertUsableSecret(secret: string, label: string, requireVariety: boolean): void {
  const bytes = decodeVaultKey(secret);
  if (bytes.length < MIN_VAULT_KEY_BYTES) {
    throw new WrapKeyRotationError(
      `The ${label} wrap key is not a usable key: it must be at least ${MIN_VAULT_KEY_BYTES} random bytes, ` +
        "written as hex or canonical base64 exactly as `openssl rand -hex 32` produces them.",
    );
  }
  if (requireVariety && !hasKeyLikeVariety(bytes)) {
    throw new WrapKeyRotationError(
      `The ${label} wrap key is the right length but is not random: its bytes repeat far more than a ` +
        "generated key's ever would. Generate one with `openssl rand -hex 32`.",
    );
  }
}

type Resealed = { tenantId: string; value: string };
type ResealedColumnUpdate = {
  table: string;
  idColumn: string;
  idValue: string;
  column: string;
  value: string;
};
type ResealedDeskFile = {
  objectKey: string;
  value: string;
};

function tableExists(sql: TenantStateSql, name: string): boolean {
  const row = sql.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { found: number }
    | undefined;
  return Boolean(row?.found);
}

/**
 * Re-seal a single stored string column if it holds an `EncryptedEnvelope`.
 * Legacy plaintext values (non-JSON or JSON without envelope shape) return `null` so they are left intact.
 */
function resealEnvelopeString(
  raw: unknown,
  oldKey: Buffer,
  newKey: Buffer,
  label: string,
  tenantId: string | null = null,
): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const parsed = safeJson(raw);
  if (!isEnvelope(parsed)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = decryptJson<unknown>(parsed, oldKey);
  } catch {
    throw new WrapKeyRotationError(
      `${label} does not open with the current wrap key, so NOTHING has been rotated. ` +
        "Check that --from is the key these secrets were sealed with.",
      tenantId,
    );
  }
  return JSON.stringify(encryptJson(payload, newKey));
}

function verifyEnvelopeString(raw: unknown, newKey: Buffer, label: string, tenantId: string | null = null): void {
  if (typeof raw !== "string") {
    throw new WrapKeyRotationError(`${label} did not read back as text after rotation.`, tenantId);
  }
  const parsed = safeJson(raw);
  if (!parsed || !isEnvelope(parsed)) {
    throw new WrapKeyRotationError(`${label} did not read back as a sealed envelope after rotation.`, tenantId);
  }
  try {
    decryptJson<unknown>(parsed, newKey);
  } catch {
    throw new WrapKeyRotationError(`${label} was written but does not open with the new wrap key.`, tenantId);
  }
}

function resolveSqlHandle(
  input: RotateWrapKeyInput,
  backend: TenantStateBackend,
): { sql: TenantStateSql | null; ownedDb: Database.Database | null } {
  if (input.sql !== undefined) {
    return { sql: input.sql, ownedDb: null };
  }
  if (backend.kind === "db") {
    return { sql: registeredTenantStateSql(), ownedDb: null };
  }
  const dbPath = sqliteFilePath();
  if (!existsSync(dbPath)) {
    return { sql: null, ownedDb: null };
  }
  const db = new Database(dbPath, { fileMustExist: true, readonly: Boolean(input.dryRun) });
  return { sql: db as unknown as TenantStateSql, ownedDb: db };
}

type SingleColumnTableSpec = {
  table: string;
  column: string;
  countKey: keyof EncryptedStoreRotationCounts;
  where?: string;
};

const SINGLE_COLUMN_TABLES: readonly SingleColumnTableSpec[] = [
  { table: "messages", column: "content", countKey: "messages" },
  { table: "agent_versions", column: "system_prompt", countKey: "agentVersions" },
  { table: "artifacts", column: "body", countKey: "artifacts" },
  { table: "threads", column: "title", countKey: "threads" },
  { table: "knowledge_sources", column: "name", countKey: "knowledgeSources", where: "origin_kind = 'thread'" },
  { table: "knowledge_graph_nodes", column: "label", countKey: "knowledgeGraphNodes" },
  { table: "customer_messages", column: "text", countKey: "customerMessages" },
];

type MultiColumnTableSpec = {
  table: string;
  columns: readonly string[];
  countKey: keyof EncryptedStoreRotationCounts;
};

const MULTI_COLUMN_TABLES: readonly MultiColumnTableSpec[] = [
  { table: "tool_invocations", columns: ["input", "output"], countKey: "toolInvocations" },
  {
    table: "customer_conversations",
    columns: ["contact_name", "last_message_preview"],
    countKey: "customerConversations",
  },
];

/**
 * Re-seal every tenant's settings payload, active session refresh tokens, encrypted DB rows, and
 * desk file objects from one wrap key to another.
 *
 * Throws `WrapKeyRotationError` — before writing anything — if either key is unusable or if any
 * sealed payload will not open under `from`.
 */
export function rotateWrapKey(input: RotateWrapKeyInput): RotateWrapKeyResult {
  assertUsableSecret(input.from, "current", false);
  assertUsableSecret(input.to, "new", true);
  if (input.from.trim() === input.to.trim()) {
    throw new WrapKeyRotationError("The new wrap key is the same as the current one; there is nothing to rotate.");
  }

  const backend = input.backend ?? tenantStateBackend();
  const oldKey = wrappingKeyFromSecret(input.from.trim());
  const newKey = wrappingKeyFromSecret(input.to.trim());
  const deskFiles = input.deskFiles ?? fileDeskFileObjects;

  const { sql, ownedDb } = resolveSqlHandle(input, backend);

  try {
    const tenants = backend.tenantsWith(SETTINGS_KEY);
    const resealed: Resealed[] = [];
    const skipped: string[] = [];

    // Phase one: open everything. Nothing is written in this phase, on purpose.
    for (const tenantId of tenants) {
      const stored = backend.read(tenantId, SETTINGS_KEY);
      if (!stored) {
        skipped.push(tenantId);
        continue;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(stored.value);
      } catch (error) {
        throw new WrapKeyRotationError(
          `${backend.describe(tenantId, SETTINGS_KEY)} is not valid JSON, so it cannot be re-sealed: ${detail(error)}`,
          tenantId,
        );
      }
      if (!isEnvelope(envelope)) {
        throw new WrapKeyRotationError(
          `${backend.describe(tenantId, SETTINGS_KEY)} is not a sealed envelope, so it cannot be re-sealed.`,
          tenantId,
        );
      }
      let payload: unknown;
      try {
        payload = decryptJson<unknown>(envelope, oldKey);
      } catch {
        throw new WrapKeyRotationError(
          `This tenant's settings do not open with the current wrap key, so NOTHING has been rotated. ` +
            "Check that --from is the key these settings were sealed with.",
          tenantId,
        );
      }
      resealed.push({ tenantId, value: `${JSON.stringify(encryptJson(payload, newKey))}\n` });
    }

    const sessionTokens = input.sessionTokens ?? defaultSessionTokens();
    const resealedSessions: Array<{ id: string; expected: string; next: string }> = [];
    for (const { id, sealed } of sessionTokens.list()) {
      const opened = openRefresh(id, sealed, oldKey);
      if (!opened) {
        throw new WrapKeyRotationError(
          `Session ${sessionLabel(id)} holds a stored portal token that does not open with the current wrap key, ` +
            "so NOTHING has been rotated. Check that --from is the key the app runs under. If it is, that " +
            "one session cannot be carried across: delete its auth_sessions row (that person signs in again) " +
            "and run the drill again.",
        );
      }
      resealedSessions.push({ id, expected: sealed, next: sealRefresh(id, opened, newKey) });
    }

    const columnUpdates: ResealedColumnUpdate[] = [];
    const resealedDeskFiles: ResealedDeskFile[] = [];
    const encryptedStores: EncryptedStoreRotationCounts = {
      messages: 0,
      toolInvocations: 0,
      agentVersions: 0,
      artifacts: 0,
      threads: 0,
      customerConversations: 0,
      customerMessages: 0,
      deskFiles: 0,
      knowledgeSources: 0,
      knowledgeGraphNodes: 0,
    };

    if (sql) {
      for (const spec of SINGLE_COLUMN_TABLES) {
        if (!tableExists(sql, spec.table)) {
          continue;
        }
        const where = spec.where ? ` WHERE ${spec.where}` : "";
        const rows = sql
          .prepare(`SELECT id, ${spec.column} AS val FROM ${spec.table}${where} ORDER BY id`)
          .all() as Array<{ id: string; val: unknown }>;
        for (const row of rows) {
          const next = resealEnvelopeString(row.val, oldKey, newKey, `${spec.table}(${row.id}).${spec.column}`);
          if (next !== null) {
            columnUpdates.push({
              table: spec.table,
              idColumn: "id",
              idValue: row.id,
              column: spec.column,
              value: next,
            });
            encryptedStores[spec.countKey] += 1;
          }
        }
      }

      for (const spec of MULTI_COLUMN_TABLES) {
        if (!tableExists(sql, spec.table)) {
          continue;
        }
        const cols = spec.columns.join(", ");
        const rows = sql.prepare(`SELECT id, ${cols} FROM ${spec.table} ORDER BY id`).all() as Array<
          Record<string, unknown> & { id: string }
        >;
        for (const row of rows) {
          let rowTouched = false;
          for (const col of spec.columns) {
            const next = resealEnvelopeString(row[col], oldKey, newKey, `${spec.table}(${row.id}).${col}`);
            if (next !== null) {
              columnUpdates.push({
                table: spec.table,
                idColumn: "id",
                idValue: row.id,
                column: col,
                value: next,
              });
              rowTouched = true;
            }
          }
          if (rowTouched) {
            encryptedStores[spec.countKey] += 1;
          }
        }
      }

      if (tableExists(sql, "desk_file_versions")) {
        const versionRows = sql
          .prepare("SELECT file_id, version, object_key FROM desk_file_versions ORDER BY file_id, version")
          .all() as Array<{ file_id: string; version: number; object_key: string }>;
        for (const row of versionRows) {
          const rawObj = deskFiles.read(row.object_key);
          if (rawObj === null) {
            continue;
          }
          const parsed = safeJson(rawObj);
          if (!isEnvelope(parsed)) {
            throw new WrapKeyRotationError(
              `desk_files(${row.object_key}) is not a sealed envelope, so it cannot be re-sealed.`,
            );
          }
          const next = resealEnvelopeString(rawObj, oldKey, newKey, `desk_files(${row.object_key})`);
          if (next !== null) {
            resealedDeskFiles.push({ objectKey: row.object_key, value: next });
            encryptedStores.deskFiles += 1;
          }
        }
      }
    }

    const rotated = resealed.map((entry) => entry.tenantId);
    if (input.dryRun) {
      log.info("wrap_key_rotation_dry_run", {
        backend: backend.kind,
        rotated: rotated.length,
        skipped: skipped.length,
        resealedSignIns: resealedSessions.length,
        encryptedStores,
      });
      return {
        rotated,
        skipped,
        sessionTokens: resealedSessions.length,
        sessionTokensChanged: 0,
        encryptedStores,
        dryRun: true,
        backend: backend.kind,
      };
    }

    // Phase two: write, then prove every write can be opened with the new key.
    for (const entry of resealed) {
      backend.write(entry.tenantId, SETTINGS_KEY, entry.value);
    }
    const writtenSessions = resealedSessions.filter((entry) =>
      sessionTokens.replace(entry.id, entry.expected, entry.next),
    );
    if (sql && columnUpdates.length > 0) {
      sql.prepare("BEGIN IMMEDIATE").run();
      try {
        for (const update of columnUpdates) {
          sql
            .prepare(`UPDATE ${update.table} SET ${update.column} = ? WHERE ${update.idColumn} = ?`)
            .run(update.value, update.idValue);
        }
        sql.prepare("COMMIT").run();
      } catch (error) {
        try {
          sql.prepare("ROLLBACK").run();
        } catch {
          // Ignore rollback failure when already rolled back.
        }
        throw error;
      }
    }
    for (const file of resealedDeskFiles) {
      deskFiles.write(file.objectKey, file.value);
    }

    // Read-back verification across ALL stores.
    for (const entry of writtenSessions) {
      const stored = sessionTokens.read(entry.id);
      if (stored === null || !openRefresh(entry.id, stored, newKey)) {
        throw new WrapKeyRotationError(
          `Session ${sessionLabel(entry.id)}'s stored portal token was written but does not open with the new wrap key.`,
        );
      }
    }
    const sessionTokensChanged = resealedSessions.length - writtenSessions.length;
    for (const entry of resealed) {
      const stored = backend.read(entry.tenantId, SETTINGS_KEY);
      const parsed: unknown = stored ? safeJson(stored.value) : null;
      if (!parsed || !isEnvelope(parsed)) {
        throw new WrapKeyRotationError(
          `${backend.describe(entry.tenantId, SETTINGS_KEY)} did not read back as a sealed envelope after rotation.`,
          entry.tenantId,
        );
      }
      try {
        decryptJson<unknown>(parsed, newKey);
      } catch {
        throw new WrapKeyRotationError(
          `${backend.describe(entry.tenantId, SETTINGS_KEY)} was written but does not open with the new wrap key.`,
          entry.tenantId,
        );
      }
    }
    if (sql) {
      for (const update of columnUpdates) {
        const row = sql
          .prepare(`SELECT ${update.column} AS val FROM ${update.table} WHERE ${update.idColumn} = ?`)
          .get(update.idValue) as { val: unknown } | undefined;
        verifyEnvelopeString(row?.val, newKey, `${update.table}(${update.idValue}).${update.column}`);
      }
    }
    for (const file of resealedDeskFiles) {
      const stored = deskFiles.read(file.objectKey);
      verifyEnvelopeString(stored, newKey, `desk_files(${file.objectKey})`);
    }

    log.info("wrap_key_rotated", {
      backend: backend.kind,
      rotated: rotated.length,
      skipped: skipped.length,
      resealedSignIns: writtenSessions.length,
      changedSignIns: sessionTokensChanged,
      encryptedStores,
    });
    return {
      rotated,
      skipped,
      sessionTokens: writtenSessions.length,
      sessionTokensChanged,
      encryptedStores,
      dryRun: false,
      backend: backend.kind,
    };
  } finally {
    ownedDb?.close();
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
