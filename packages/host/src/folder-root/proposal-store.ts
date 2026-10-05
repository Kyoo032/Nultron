import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openPayload, sealPayload, type TenantContext } from "@agentforge/core";
import { FOLDER_PROPOSALS_LIST_MAX } from "./constants";

export const PROPOSAL_KINDS = ["write", "delete"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["pending", "approved", "applied", "rejected", "stale", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export type ProposalSummary = {
  readonly id: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  readonly runId: string;
  readonly createdAt: number;
  readonly decidedAt: number | null;
};

export type ProposalRecord = ProposalSummary & {
  readonly beforeSha256: string | null;
  /** The text the file would hold after approval; `null` for a delete. */
  readonly afterBody: string | null;
};

export type NewProposal = {
  readonly runId: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly beforeSha256: string | null;
  readonly afterBody: string | null;
};

export type ProposalStore = {
  /**
   * Insert a pending proposal. Any earlier pending proposal for the same desk and path is rejected
   * in the same transaction, so a desk never holds two.
   */
  propose(tenant: TenantContext, input: NewProposal): string;
  get(tenant: TenantContext, id: string): ProposalRecord | null;
  list(tenant: TenantContext, status?: ProposalStatus): ProposalSummary[];
  countPending(tenant: TenantContext): number;
  hasPendingFor(tenant: TenantContext, path: string): boolean;
  /** pending -> approved, once. False means somebody else decided first. */
  claim(tenant: TenantContext, id: string): boolean;
  /** approved -> its outcome. */
  finish(tenant: TenantContext, id: string, outcome: "applied" | "stale" | "failed"): void;
  /** pending -> rejected. False means it was not pending. */
  reject(tenant: TenantContext, id: string): boolean;
  /** Reject every pending proposal of the desk; returns how many. */
  rejectAllPending(tenant: TenantContext): number;
  /** Delete every proposal row of one desk, whatever its status, sealed bodies included; returns how many. */
  purgeDesk(workspaceId: string): number;
};

type Row = {
  id: string;
  workspace_id: string;
  run_id: string;
  path: string;
  kind: string;
  before_sha256: string | null;
  after_body: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
};

const SUMMARY_COLUMNS =
  "id, workspace_id, run_id, path, kind, before_sha256, NULL AS after_body, status, created_at, decided_at";

function kindOf(value: string): ProposalKind {
  return value === "delete" ? "delete" : "write";
}

function summaryOf(row: Row): ProposalSummary {
  return {
    id: row.id,
    path: row.path,
    kind: kindOf(row.kind),
    status: isProposalStatus(row.status) ? row.status : "failed",
    runId: row.run_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * Proposals over the `file_proposals` table. Every statement carries the desk id, so another desk's
 * proposal is simply not there. The proposed text is sealed with the vault key the same way
 * artifact bodies are, and a proposal is never edited after it is written: a newer one replaces it
 * by rejecting it, so the diff an owner is looking at is always the text that Approve would apply.
 */
export function createProposalStore(db: Database.Database, keyProvider: () => Buffer): ProposalStore {
  const seal = (body: string): string => JSON.stringify(sealPayload(body, keyProvider()));
  const open = (stored: string | null): string | null => {
    if (stored === null) {
      return null;
    }
    const value = openPayload<unknown>(JSON.parse(stored), keyProvider());
    return typeof value === "string" ? value : null;
  };

  const rejectPendingAt = db.prepare(
    "UPDATE file_proposals SET status = 'rejected', decided_at = ? WHERE workspace_id = ? AND path = ? AND status = 'pending'",
  );
  const insert = db.prepare(
    `INSERT INTO file_proposals (id, workspace_id, run_id, path, kind, before_sha256, after_body, status, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  );
  const proposeTx = db.transaction((tenant: TenantContext, input: NewProposal): string => {
    const now = Date.now();
    const id = randomUUID();
    rejectPendingAt.run(now, tenant.workspaceId, input.path);
    insert.run(
      id,
      tenant.workspaceId,
      input.runId,
      input.path,
      input.kind,
      input.beforeSha256,
      input.afterBody === null ? null : seal(input.afterBody),
      now,
    );
    return id;
  });

  return {
    propose: (tenant, input) => proposeTx(tenant, input),

    get(tenant, id) {
      const row = db
        .prepare("SELECT * FROM file_proposals WHERE workspace_id = ? AND id = ?")
        .get(tenant.workspaceId, id) as Row | undefined;
      if (!row) {
        return null;
      }
      return { ...summaryOf(row), beforeSha256: row.before_sha256, afterBody: open(row.after_body) };
    },

    list(tenant, status) {
      const rows = (
        status
          ? db
              .prepare(
                `SELECT ${SUMMARY_COLUMNS} FROM file_proposals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
              )
              .all(tenant.workspaceId, status, FOLDER_PROPOSALS_LIST_MAX)
          : db
              .prepare(
                `SELECT ${SUMMARY_COLUMNS} FROM file_proposals WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
              )
              .all(tenant.workspaceId, FOLDER_PROPOSALS_LIST_MAX)
      ) as Row[];
      return rows.map(summaryOf);
    },

    countPending(tenant) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM file_proposals WHERE workspace_id = ? AND status = 'pending'")
        .get(tenant.workspaceId) as { n: number };
      return row.n;
    },

    hasPendingFor(tenant, path) {
      const row = db
        .prepare(
          "SELECT 1 AS present FROM file_proposals WHERE workspace_id = ? AND path = ? AND status = 'pending' LIMIT 1",
        )
        .get(tenant.workspaceId, path);
      return row !== undefined;
    },

    claim(tenant, id) {
      const result = db
        .prepare(
          "UPDATE file_proposals SET status = 'approved', decided_at = ? WHERE workspace_id = ? AND id = ? AND status = 'pending'",
        )
        .run(Date.now(), tenant.workspaceId, id);
      return result.changes > 0;
    },

    finish(tenant, id, outcome) {
      db.prepare("UPDATE file_proposals SET status = ? WHERE workspace_id = ? AND id = ? AND status = 'approved'").run(
        outcome,
        tenant.workspaceId,
        id,
      );
    },

    reject(tenant, id) {
      const result = db
        .prepare(
          "UPDATE file_proposals SET status = 'rejected', decided_at = ? WHERE workspace_id = ? AND id = ? AND status = 'pending'",
        )
        .run(Date.now(), tenant.workspaceId, id);
      return result.changes > 0;
    },

    rejectAllPending(tenant) {
      const result = db
        .prepare(
          "UPDATE file_proposals SET status = 'rejected', decided_at = ? WHERE workspace_id = ? AND status = 'pending'",
        )
        .run(Date.now(), tenant.workspaceId);
      return result.changes;
    },

    purgeDesk(workspaceId) {
      return db.prepare("DELETE FROM file_proposals WHERE workspace_id = ?").run(workspaceId).changes;
    },
  };
}
