import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openPayload, sealPayload, type TenantContext } from "@agentforge/core";
import { sql } from "@agentforge/db";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { visibleTo } from "../artifacts";
import { DocModelError, replaceSection, type DocSpec, type Section } from "../doc-model";
import { sectionSchema } from "../doc-model/types";
import { admitsArtifactRowWrite } from "../tenant-storage";
import { sectionIdsOf } from "./section-ids";
import { docVersionStore, type DocVersionStore } from "./store";
import type { AppendRefusal, AppendResult } from "./types";

export type ProposalStatus = "pending" | "kept" | "discarded";

export type DocProposal = {
  readonly id: string;
  readonly artifactId: string;
  readonly sectionId: string;
  readonly section: Section;
  readonly baseVersion: number;
  readonly agentId: string;
  readonly askedByUserId: string;
  readonly status: ProposalStatus;
  readonly keptVersion: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ProposalInput = {
  readonly sectionId: string;
  readonly section: Section;
  readonly baseVersion: number;
  readonly agentId: string;
};

export type CreateProposalResult =
  | { readonly ok: true; readonly proposal: DocProposal }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "not_editable" | "bad_base" | "bad_section" | "section_changed" | "quota";
    };

export type ProposalChange =
  | { readonly ok: true; readonly proposal: DocProposal }
  | { readonly ok: false; readonly reason: "not_found" | "not_pending" };

export type KeepResult =
  | ProposalChange
  | { readonly ok: false; readonly reason: AppendRefusal; readonly sectionIds?: readonly string[] };

export type ProposalStore = {
  createProposal(tenant: TenantContext, artifactId: string, input: ProposalInput): CreateProposalResult;
  listPending(tenant: TenantContext, artifactId: string): DocProposal[] | null;
  keep(tenant: TenantContext, proposalId: string): KeepResult;
  discard(tenant: TenantContext, proposalId: string): ProposalChange;
};

export type ProposalStoreOptions = {
  readonly db: Database.Database;
  readonly docVersions: DocVersionStore;
  readonly now?: () => number;
};

type ProposalRow = {
  id: string;
  artifact_id: string;
  section_id: string;
  base_version: number;
  section: string;
  agent_id: string;
  asked_by_user_id: string;
  status: string;
  kept_version: number | null;
  created_at: number;
  updated_at: number;
};

const COLUMNS =
  "id, artifact_id, section_id, base_version, section, agent_id, asked_by_user_id, status, kept_version, created_at, updated_at";

class EditRefused extends Error {
  readonly refusal: "not_editable" | "section_changed";

  constructor(refusal: "not_editable" | "section_changed") {
    super(refusal);
    this.name = "EditRefused";
    this.refusal = refusal;
  }
}

function sealSection(section: Section): string {
  return JSON.stringify(sealPayload(section, getLocalVaultKey()));
}

function openSection(stored: string): Section {
  return sectionSchema.parse(openPayload<unknown>(JSON.parse(stored), getLocalVaultKey()));
}

function proposalOf(row: ProposalRow): DocProposal {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    sectionId: row.section_id,
    section: openSection(row.section),
    baseVersion: row.base_version,
    agentId: row.agent_id,
    askedByUserId: row.asked_by_user_id,
    status: row.status as ProposalStatus,
    keptVersion: row.kept_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatedSection(doc: DocSpec, sectionId: string, section: Section): Section | null {
  try {
    const edited = replaceSection(doc, sectionId, { ...section, id: sectionId });
    return edited.sections.find((part) => part.id === sectionId) ?? null;
  } catch (error) {
    if (error instanceof DocModelError) {
      return null;
    }
    throw error;
  }
}

export function createProposalStore(options: ProposalStoreOptions): ProposalStore {
  const { db, docVersions } = options;
  const now = options.now ?? Date.now;

  const readable = (tenant: TenantContext, artifactId: string): boolean => {
    const visible = visibleTo(tenant);
    return (
      db
        .prepare(`SELECT id FROM artifacts WHERE workspace_id = ? AND id = ?${visible.clause}`)
        .get(tenant.workspaceId, artifactId, ...visible.args) !== undefined
    );
  };

  const rowById = (tenant: TenantContext, proposalId: string): ProposalRow | undefined =>
    db
      .prepare(`SELECT ${COLUMNS} FROM doc_proposals WHERE workspace_id = ? AND id = ?`)
      .get(tenant.workspaceId, proposalId) as ProposalRow | undefined;

  const readableRow = (tenant: TenantContext, proposalId: string): ProposalRow | undefined => {
    const row = rowById(tenant, proposalId);
    return row !== undefined && readable(tenant, row.artifact_id) ? row : undefined;
  };

  const reread = (tenant: TenantContext, proposalId: string): DocProposal => {
    const row = rowById(tenant, proposalId);
    if (row === undefined) {
      throw new Error(`doc proposal ${proposalId} disappeared inside its own transaction`);
    }
    return proposalOf(row);
  };

  const createIn = (tenant: TenantContext, artifactId: string, input: ProposalInput): CreateProposalResult => {
    if (!readable(tenant, artifactId)) {
      return { ok: false, reason: "not_found" };
    }
    const first = docVersions.ensureFirstVersion(tenant, artifactId);
    if (!first.ok) {
      return { ok: false, reason: first.reason };
    }
    const headVersion = first.head.version;
    if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1 || input.baseVersion > headVersion) {
      return { ok: false, reason: "bad_base" };
    }
    const current = docVersions.getVersion(tenant, artifactId, headVersion);
    if (current === null || current.spec.kind !== "document") {
      return { ok: false, reason: "not_editable" };
    }
    const changedAfterBase = (docVersions.listVersions(tenant, artifactId) ?? []).some(
      (version) => version.version > input.baseVersion && version.changedSectionIds.includes(input.sectionId),
    );
    if (changedAfterBase) {
      return { ok: false, reason: "section_changed" };
    }
    const section = validatedSection(current.spec.spec, input.sectionId, input.section);
    if (section === null) {
      return { ok: false, reason: "bad_section" };
    }
    const stored = sealSection(section);
    if (!admitsArtifactRowWrite(tenant.tenantId, Buffer.byteLength(stored, "utf8"), db)) {
      return { ok: false, reason: "quota" };
    }
    const at = now();
    db.prepare(
      "DELETE FROM doc_proposals WHERE workspace_id = ? AND artifact_id = ? AND section_id = ? AND status = 'pending'",
    ).run(tenant.workspaceId, artifactId, input.sectionId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO doc_proposals (id, workspace_id, artifact_id, section_id, base_version, section, agent_id, asked_by_user_id, status, kept_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    ).run(
      id,
      tenant.workspaceId,
      artifactId,
      input.sectionId,
      input.baseVersion,
      stored,
      input.agentId,
      tenant.userId,
      at,
      at,
    );
    return { ok: true, proposal: reread(tenant, id) };
  };

  const keepIn = (tenant: TenantContext, proposalId: string): KeepResult => {
    const row = readableRow(tenant, proposalId);
    if (row === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const section = openSection(row.section);
    let result: AppendResult;
    try {
      result = docVersions.appendVersion(tenant, row.artifact_id, {
        baseVersion: row.base_version,
        author: { kind: "agent", agentId: row.agent_id, askedByUserId: row.asked_by_user_id },
        edit: (head) => {
          if (head.kind !== "document") {
            throw new EditRefused("not_editable");
          }
          if (!sectionIdsOf(head).includes(row.section_id)) {
            throw new EditRefused("section_changed");
          }
          return { kind: "document", spec: replaceSection(head.spec, row.section_id, section) };
        },
      });
    } catch (error) {
      if (error instanceof EditRefused) {
        return error.refusal === "section_changed"
          ? { ok: false, reason: "section_changed", sectionIds: [row.section_id] }
          : { ok: false, reason: "not_editable" };
      }
      throw error;
    }
    if (!result.ok) {
      return result;
    }
    const at = now();
    db.prepare("DELETE FROM doc_proposals WHERE workspace_id = ? AND id = ? AND status = 'pending'").run(
      tenant.workspaceId,
      proposalId,
    );
    return {
      ok: true,
      proposal: { ...proposalOf(row), status: "kept", keptVersion: result.head.version, updatedAt: at },
    };
  };

  const discardIn = (tenant: TenantContext, proposalId: string): ProposalChange => {
    const row = readableRow(tenant, proposalId);
    if (row === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      return { ok: false, reason: "not_pending" };
    }
    const at = now();
    db.prepare("DELETE FROM doc_proposals WHERE workspace_id = ? AND id = ? AND status = 'pending'").run(
      tenant.workspaceId,
      proposalId,
    );
    return { ok: true, proposal: { ...proposalOf(row), status: "discarded", updatedAt: at } };
  };

  return {
    createProposal: (tenant, artifactId, input) => db.transaction(createIn).immediate(tenant, artifactId, input),

    listPending(tenant, artifactId) {
      if (!readable(tenant, artifactId)) {
        return null;
      }
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM doc_proposals WHERE workspace_id = ? AND artifact_id = ? AND status = 'pending' ORDER BY created_at, id`,
        )
        .all(tenant.workspaceId, artifactId) as ProposalRow[];
      return rows.map(proposalOf);
    },

    keep: (tenant, proposalId) => db.transaction(keepIn).immediate(tenant, proposalId),

    discard: (tenant, proposalId) => db.transaction(discardIn).immediate(tenant, proposalId),
  };
}

let defaultStore: ProposalStore | null = null;

export function proposalStore(): ProposalStore {
  if (!defaultStore) {
    defaultStore = createProposalStore({ db: sql, docVersions: docVersionStore() });
  }
  return defaultStore;
}
