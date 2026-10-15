import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { visibleTo } from "../artifacts";
import { openSpec, SPEC_META_KEY, sealSpec, type EditableSpec } from "../doc-tools/doc-meta";
import { parseDocSpec, parseSheetSpec } from "../doc-model";
import { admitsArtifactRowWrite } from "../tenant-storage";
import { lastChanges, planPrune, type HistoryRow } from "./history";
import { pendingBaseVersions } from "./pending-bases";
import { changedSectionIds, sectionIdsOf } from "./section-ids";
import {
  DOC_VERSION_CAP,
  type AppendResult,
  type AppendVersionInput,
  type DocVersion,
  type DocVersionAuthor,
  type DocVersionCap,
  type DocVersionInfo,
  type EnsureFirstResult,
  type ProtectedVersions,
  type SectionAuthors,
} from "./types";

export type DocVersionStore = {
  ensureFirstVersion(tenant: TenantContext, artifactId: string): EnsureFirstResult;
  appendVersion(tenant: TenantContext, artifactId: string, input: AppendVersionInput): AppendResult;
  listVersions(tenant: TenantContext, artifactId: string): DocVersionInfo[] | null;
  getVersion(tenant: TenantContext, artifactId: string, version: number): DocVersion | null;
  sectionAuthors(tenant: TenantContext, artifactId: string): SectionAuthors | null;
};

export type DocVersionStoreOptions = {
  readonly db: Database.Database;
  readonly now?: () => number;
  readonly protectedVersions?: ProtectedVersions;
  readonly cap?: DocVersionCap;
};

type ArtifactRow = { workspace_id: string; meta: string; owner_user_id: string | null };

type VersionRow = {
  version: number;
  kind: string;
  changed_section_ids: string;
  base_version: number | null;
  note: string | null;
  author_kind: string;
  author_user_id: string | null;
  agent_id: string | null;
  asked_by_user_id: string;
  folded_authors: string | null;
  created_at: number;
};

type SpecRow = VersionRow & { spec: string };

type SeededSpec = { readonly sealed: unknown; readonly spec: EditableSpec };

class QuotaRefused extends Error {}

const INFO_COLUMNS =
  "version, kind, changed_section_ids, base_version, note, author_kind, author_user_id, agent_id, asked_by_user_id, folded_authors, created_at";

const NO_PROTECTED: ProtectedVersions = () => new Set();

function authorOf(row: VersionRow): DocVersionAuthor {
  return row.author_kind === "agent"
    ? { kind: "agent", agentId: row.agent_id ?? "", askedByUserId: row.asked_by_user_id }
    : { kind: "person", userId: row.author_user_id ?? row.asked_by_user_id };
}

function infoOf(row: VersionRow): DocVersionInfo {
  return {
    version: row.version,
    kind: row.kind === "workbook" ? "workbook" : "document",
    changedSectionIds: JSON.parse(row.changed_section_ids) as string[],
    baseVersion: row.base_version,
    note: row.note,
    author: authorOf(row),
    createdAt: row.created_at,
  };
}

function historyOf(row: VersionRow): HistoryRow {
  const info = infoOf(row);
  return {
    version: info.version,
    createdAt: info.createdAt,
    changedSectionIds: info.changedSectionIds,
    author: info.author,
    folded: row.folded_authors === null ? {} : (JSON.parse(row.folded_authors) as SectionAuthors),
  };
}

function openStored(stored: string): EditableSpec | null {
  try {
    return openSpec(JSON.parse(stored));
  } catch {
    return null;
  }
}

function sealedSpecOf(meta: string): unknown {
  try {
    return (JSON.parse(meta) as Record<string, unknown>)[SPEC_META_KEY];
  } catch {
    return undefined;
  }
}

function normalized(spec: EditableSpec): EditableSpec {
  return spec.kind === "document"
    ? { kind: "document", spec: parseDocSpec(spec.spec) }
    : { kind: "workbook", spec: parseSheetSpec(spec.spec) };
}

function authorColumns(tenant: TenantContext, input: AppendVersionInput) {
  const askedByUserId = input.author.kind === "agent" ? (input.author.askedByUserId ?? tenant.userId) : tenant.userId;
  return input.author.kind === "agent"
    ? { kind: "agent", userId: null, agentId: input.author.agentId, askedByUserId }
    : { kind: "person", userId: tenant.userId, agentId: null, askedByUserId };
}

export function createDocVersionStore(options: DocVersionStoreOptions): DocVersionStore {
  const { db } = options;
  const now = options.now ?? Date.now;
  const protectedVersions = options.protectedVersions ?? NO_PROTECTED;
  const cap = options.cap ?? DOC_VERSION_CAP;

  const visibleArtifact = (tenant: TenantContext, artifactId: string): ArtifactRow | undefined => {
    const visible = visibleTo(tenant);
    return db
      .prepare(
        `SELECT workspace_id, meta, owner_user_id FROM artifacts WHERE workspace_id = ? AND id = ?${visible.clause}`,
      )
      .get(tenant.workspaceId, artifactId, ...visible.args) as ArtifactRow | undefined;
  };

  const versionRows = (tenant: TenantContext, artifactId: string): VersionRow[] =>
    db
      .prepare(`SELECT ${INFO_COLUMNS} FROM doc_versions WHERE workspace_id = ? AND artifact_id = ? ORDER BY version`)
      .all(tenant.workspaceId, artifactId) as VersionRow[];

  const specRow = (tenant: TenantContext, artifactId: string, version: number): SpecRow | undefined =>
    db
      .prepare(
        `SELECT ${INFO_COLUMNS}, spec FROM doc_versions WHERE workspace_id = ? AND artifact_id = ? AND version = ?`,
      )
      .get(tenant.workspaceId, artifactId, version) as SpecRow | undefined;

  const seedOf = (artifact: ArtifactRow): SeededSpec | null => {
    const sealed = sealedSpecOf(artifact.meta);
    const spec = openSpec(sealed);
    return spec === null ? null : { sealed, spec };
  };

  const admit = (tenant: TenantContext, incomingBytes: number): void => {
    if (!admitsArtifactRowWrite(tenant.tenantId, incomingBytes, db)) {
      throw new QuotaRefused();
    }
  };

  const writeFirst = (
    tenant: TenantContext,
    artifactId: string,
    artifact: ArtifactRow,
    seed: SeededSpec,
  ): DocVersionInfo => {
    const author = artifact.owner_user_id ?? tenant.userId;
    admit(tenant, Buffer.byteLength(JSON.stringify(seed.sealed), "utf8"));
    db.prepare(
      `INSERT OR IGNORE INTO doc_versions (id, workspace_id, artifact_id, version, spec, kind, changed_section_ids,
         base_version, note, author_kind, author_user_id, agent_id, asked_by_user_id, folded_authors, created_at)
       SELECT ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 'person', ?, NULL, ?, NULL, ?
        WHERE NOT EXISTS (SELECT 1 FROM doc_versions WHERE artifact_id = ?)`,
    ).run(
      randomUUID(),
      artifact.workspace_id,
      artifactId,
      JSON.stringify(seed.sealed),
      seed.spec.kind,
      JSON.stringify(sectionIdsOf(seed.spec)),
      author,
      author,
      now(),
      artifactId,
    );
    return infoOf(specRow(tenant, artifactId, 1) as SpecRow);
  };

  const prune = (tenant: TenantContext, artifactId: string): void => {
    const plan = planPrune(versionRows(tenant, artifactId).map(historyOf), now(), protectedVersions(artifactId), cap);
    if (plan === null) {
      return;
    }
    const remove = db.prepare("DELETE FROM doc_versions WHERE artifact_id = ? AND version = ?");
    for (const version of plan.drop) {
      remove.run(artifactId, version);
    }
    db.prepare("UPDATE doc_versions SET folded_authors = ? WHERE artifact_id = ? AND version = ?").run(
      JSON.stringify(plan.folded),
      artifactId,
      plan.foldInto,
    );
  };

  const writeHead = (artifactId: string, artifact: ArtifactRow, sealed: unknown, at: number): void => {
    const meta = { ...(JSON.parse(artifact.meta) as Record<string, unknown>), [SPEC_META_KEY]: sealed };
    db.prepare("UPDATE artifacts SET meta = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(
      JSON.stringify(meta),
      at,
      artifact.workspace_id,
      artifactId,
    );
  };

  const append = (tenant: TenantContext, artifactId: string, input: AppendVersionInput): AppendResult => {
    const artifact = visibleArtifact(tenant, artifactId);
    if (artifact === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const seed = seedOf(artifact);
    if (seed === null) {
      return { ok: false, reason: "not_editable" };
    }
    const rows = versionRows(tenant, artifactId);
    const headRow = rows[rows.length - 1] as VersionRow | undefined;
    const head =
      headRow === undefined ? seed.spec : openStored(specRow(tenant, artifactId, headRow.version)?.spec ?? "null");
    if (head === null) {
      return { ok: false, reason: "not_editable" };
    }
    const headVersion = headRow?.version ?? 1;
    if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1 || input.baseVersion > headVersion) {
      return { ok: false, reason: "bad_base" };
    }
    const edited = input.edit(head);
    if (edited.kind !== head.kind) {
      return { ok: false, reason: "kind_changed" };
    }
    const next = normalized(edited);
    if (isDeepStrictEqual(next.spec, head.spec)) {
      if (headRow !== undefined) {
        return { ok: true, head: infoOf(headRow), created: false };
      }
      return { ok: true, head: writeFirst(tenant, artifactId, artifact, seed), created: false };
    }
    const changed = changedSectionIds(head, next);
    const last = lastChanges(rows.map(historyOf));
    const conflicts = changed.filter((id) => (last[id]?.version ?? 0) > input.baseVersion);
    if (conflicts.length > 0) {
      return { ok: false, reason: "section_changed", sectionIds: conflicts };
    }
    if (headRow === undefined) {
      writeFirst(tenant, artifactId, artifact, seed);
    }
    const author = authorColumns(tenant, input);
    const sealed = sealSpec(next.spec);
    const at = now();
    const version = headVersion + 1;
    admit(tenant, Buffer.byteLength(JSON.stringify(sealed), "utf8"));
    db.prepare(
      `INSERT INTO doc_versions (id, workspace_id, artifact_id, version, spec, kind, changed_section_ids, base_version, note,
         author_kind, author_user_id, agent_id, asked_by_user_id, folded_authors, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      randomUUID(),
      artifact.workspace_id,
      artifactId,
      version,
      JSON.stringify(sealed),
      next.kind,
      JSON.stringify(changed),
      input.baseVersion,
      input.note ?? null,
      author.kind,
      author.userId,
      author.agentId,
      author.askedByUserId,
      at,
    );
    writeHead(artifactId, artifact, sealed, at);
    prune(tenant, artifactId);
    const written = specRow(tenant, artifactId, version) as SpecRow;
    return { ok: true, head: infoOf(written), created: true };
  };

  const first = (tenant: TenantContext, artifactId: string): EnsureFirstResult => {
    const artifact = visibleArtifact(tenant, artifactId);
    if (artifact === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const seed = seedOf(artifact);
    if (seed === null) {
      return { ok: false, reason: "not_editable" };
    }
    const rows = versionRows(tenant, artifactId);
    const headRow = rows[rows.length - 1];
    if (headRow !== undefined) {
      return { ok: true, head: infoOf(headRow) };
    }
    return { ok: true, head: writeFirst(tenant, artifactId, artifact, seed) };
  };

  return {
    ensureFirstVersion(tenant, artifactId) {
      try {
        return db.transaction(first).immediate(tenant, artifactId);
      } catch (error) {
        if (error instanceof QuotaRefused) {
          return { ok: false, reason: "quota" };
        }
        throw error;
      }
    },

    appendVersion(tenant, artifactId, input) {
      try {
        return db.transaction(append).immediate(tenant, artifactId, input);
      } catch (error) {
        if (error instanceof QuotaRefused) {
          return { ok: false, reason: "quota" };
        }
        throw error;
      }
    },

    listVersions(tenant, artifactId) {
      if (visibleArtifact(tenant, artifactId) === undefined) {
        return null;
      }
      return versionRows(tenant, artifactId).map(infoOf).reverse();
    },

    getVersion(tenant, artifactId, version) {
      if (visibleArtifact(tenant, artifactId) === undefined) {
        return null;
      }
      const row = specRow(tenant, artifactId, version);
      const spec = row === undefined ? null : openStored(row.spec);
      return row === undefined || spec === null ? null : { ...infoOf(row), spec };
    },

    sectionAuthors(tenant, artifactId) {
      if (visibleArtifact(tenant, artifactId) === undefined) {
        return null;
      }
      const rows = versionRows(tenant, artifactId);
      const headRow = rows[rows.length - 1];
      const head =
        headRow === undefined ? null : openStored(specRow(tenant, artifactId, headRow.version)?.spec ?? "null");
      if (head === null) {
        return {};
      }
      const last = lastChanges(rows.map(historyOf));
      return Object.fromEntries(
        sectionIdsOf(head).flatMap((id) => (last[id] === undefined ? [] : [[id, last[id]] as const])),
      );
    },
  };
}

let defaultStore: DocVersionStore | null = null;

export function docVersionStore(): DocVersionStore {
  if (!defaultStore) {
    defaultStore = createDocVersionStore({ db: sql, protectedVersions: pendingBaseVersions(sql) });
  }
  return defaultStore;
}
