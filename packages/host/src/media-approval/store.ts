import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openPayload, sealPayload } from "@agentforge/core";
import type { MediaKind, MediaProposalStatus } from "./constants";
import type { StoredMediaRequest } from "./request";

export type MediaOwner = {
  readonly organizationId: string;
  readonly userId: string;
};

export type MediaProposalRecord = {
  readonly id: string;
  readonly kind: MediaKind;
  readonly model: string;
  readonly status: MediaProposalStatus;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly estimateMicros: number | null;
  readonly request: StoredMediaRequest;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly claimedAt: number | null;
};

export type NewMediaProposal = {
  readonly owner: MediaOwner;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly kind: MediaKind;
  readonly model: string;
  readonly estimateMicros: number | null;
  readonly request: StoredMediaRequest;
  readonly now: number;
};

export type MediaApprovalStore = {
  propose(input: NewMediaProposal): string;
  get(owner: MediaOwner, id: string): MediaProposalRecord | null;
  claim(owner: MediaOwner, id: string, now: number): boolean;
  finish(owner: MediaOwner, id: string, status: "generated" | "failed", now: number): void;
  skip(owner: MediaOwner, id: string, now: number): boolean;
  expire(owner: MediaOwner, id: string, now: number): void;
  allowedFor(owner: MediaOwner, kind: MediaKind): boolean;
  allowedByKind(owner: MediaOwner): Readonly<Record<MediaKind, boolean>>;
  setAllowed(owner: MediaOwner, kind: MediaKind, allowed: boolean, now: number): void;
};

type ProposalRow = {
  id: string;
  kind: string;
  model: string;
  status: string;
  thread_id: string;
  workspace_id: string;
  estimate_micros: number | null;
  sealed_request: string;
  created_at: number;
  decided_at: number | null;
  claimed_at: number | null;
};

function kindOf(value: string): MediaKind {
  return value === "video" ? "video" : "image";
}

function statusOf(value: string): MediaProposalStatus {
  switch (value) {
    case "generated":
    case "skipped":
    case "expired":
    case "failed":
      return value;
    default:
      return "pending";
  }
}

export function createMediaApprovalStore(db: Database.Database, keyProvider: () => Buffer): MediaApprovalStore {
  const seal = (value: StoredMediaRequest): string => JSON.stringify(sealPayload(value, keyProvider()));
  const open = (stored: string): StoredMediaRequest =>
    openPayload<StoredMediaRequest>(JSON.parse(stored), keyProvider());

  const insert = db.prepare(
    `INSERT INTO media_proposals (id, organization_id, workspace_id, thread_id, run_id, user_id, kind, model, sealed_request,
       estimate_micros, estimate_currency, status, claimed_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'pending', NULL, ?, NULL)`,
  );
  const selectOwn = db.prepare(
    "SELECT id, kind, model, status, thread_id, workspace_id, estimate_micros, sealed_request, created_at, decided_at, claimed_at FROM media_proposals WHERE organization_id = ? AND user_id = ? AND id = ?",
  );
  const claimStmt = db.prepare(
    "UPDATE media_proposals SET claimed_at = ? WHERE organization_id = ? AND user_id = ? AND id = ? AND status = 'pending' AND claimed_at IS NULL",
  );
  const finishStmt = db.prepare(
    "UPDATE media_proposals SET status = ?, decided_at = ?, claimed_at = NULL WHERE organization_id = ? AND user_id = ? AND id = ? AND status = 'pending'",
  );
  const skipStmt = db.prepare(
    "UPDATE media_proposals SET status = 'skipped', decided_at = ? WHERE organization_id = ? AND user_id = ? AND id = ? AND status = 'pending' AND claimed_at IS NULL",
  );
  const expireStmt = db.prepare(
    "UPDATE media_proposals SET status = 'expired', decided_at = ? WHERE organization_id = ? AND user_id = ? AND id = ? AND status = 'pending'",
  );
  const selectAllowed = db.prepare(
    "SELECT allowed FROM media_always_allow WHERE organization_id = ? AND user_id = ? AND kind = ?",
  );
  const upsertAllowed = db.prepare(
    `INSERT INTO media_always_allow (organization_id, user_id, kind, allowed, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (organization_id, user_id, kind) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
  );

  const allowedFor = (owner: MediaOwner, kind: MediaKind): boolean => {
    const row = selectAllowed.get(owner.organizationId, owner.userId, kind) as { allowed: number } | undefined;
    return row?.allowed === 1;
  };

  return {
    propose(input) {
      const id = randomUUID();
      insert.run(
        id,
        input.owner.organizationId,
        input.workspaceId,
        input.threadId,
        input.runId,
        input.owner.userId,
        input.kind,
        input.model,
        seal(input.request),
        input.estimateMicros,
        input.now,
      );
      return id;
    },

    get(owner, id) {
      const row = selectOwn.get(owner.organizationId, owner.userId, id) as ProposalRow | undefined;
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        kind: kindOf(row.kind),
        model: row.model,
        status: statusOf(row.status),
        threadId: row.thread_id,
        workspaceId: row.workspace_id,
        estimateMicros: row.estimate_micros,
        request: open(row.sealed_request),
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        claimedAt: row.claimed_at,
      };
    },

    claim(owner, id, now) {
      return claimStmt.run(now, owner.organizationId, owner.userId, id).changes > 0;
    },

    finish(owner, id, status, now) {
      finishStmt.run(status, now, owner.organizationId, owner.userId, id);
    },

    skip(owner, id, now) {
      return skipStmt.run(now, owner.organizationId, owner.userId, id).changes > 0;
    },

    expire(owner, id, now) {
      expireStmt.run(now, owner.organizationId, owner.userId, id);
    },

    allowedFor,

    allowedByKind(owner) {
      return Object.freeze({
        image: allowedFor(owner, "image"),
        video: allowedFor(owner, "video"),
      });
    },

    setAllowed(owner, kind, allowed, now) {
      upsertAllowed.run(owner.organizationId, owner.userId, kind, allowed ? 1 : 0, now);
    },
  };
}
