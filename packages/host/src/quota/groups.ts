import { randomUUID } from "node:crypto";
import { sql } from "@agentforge/db";
import { appendAudit } from "./audit";
import { isUniqueViolation, QuotaStoreError, requireScope, runImmediate, type QuotaScope } from "./common";

export type GroupView = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
};

const NAME_MAX = 80;

function cleanName(raw: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new QuotaStoreError("invalid_input", "group name");
  }
  return name;
}

function groupRow(
  scope: QuotaScope,
  groupId: string,
): { id: string; name: string; created_by: string; created_at: number } | undefined {
  return sql
    .prepare(
      `SELECT id, name, created_by, created_at FROM company_groups
        WHERE id = ? AND organization_id = ? AND tenant_id = ? AND archived_at IS NULL`,
    )
    .get(groupId, scope.organizationId, scope.tenantId) as
    | { id: string; name: string; created_by: string; created_at: number }
    | undefined;
}

function memberIdsOf(groupId: string): string[] {
  return (
    sql.prepare("SELECT user_id FROM company_group_members WHERE group_id = ? ORDER BY user_id").all(groupId) as Array<{
      user_id: string;
    }>
  ).map((row) => row.user_id);
}

function viewOf(row: { id: string; name: string; created_by: string; created_at: number }): GroupView {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    memberIds: memberIdsOf(row.id),
  };
}

export function listGroups(scope: QuotaScope): GroupView[] {
  requireScope(scope);
  const rows = sql
    .prepare(
      `SELECT id, name, created_by, created_at FROM company_groups
        WHERE organization_id = ? AND tenant_id = ? AND archived_at IS NULL ORDER BY lower(name), id`,
    )
    .all(scope.organizationId, scope.tenantId) as Array<{
    id: string;
    name: string;
    created_by: string;
    created_at: number;
  }>;
  return rows.map(viewOf);
}

export function getGroup(scope: QuotaScope, groupId: string): GroupView | null {
  requireScope(scope);
  const row = groupRow(scope, groupId);
  return row ? viewOf(row) : null;
}

export function createGroup(scope: QuotaScope, actorUserId: string, name: string, now = Date.now()): GroupView {
  const clean = cleanName(name);
  return runImmediate(() => {
    requireScope(scope);
    const id = randomUUID();
    try {
      sql
        .prepare(
          `INSERT INTO company_groups (id, organization_id, tenant_id, name, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, scope.organizationId, scope.tenantId, clean, actorUserId, now);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new QuotaStoreError("duplicate", "group name");
      }
      throw error;
    }
    appendAudit(scope, actorUserId, "group.create", null, { groupId: id }, now);
    return viewOf(groupRow(scope, id) as { id: string; name: string; created_by: string; created_at: number });
  });
}

export function setGroupMembers(
  scope: QuotaScope,
  actorUserId: string,
  groupId: string,
  userIds: readonly string[],
  now = Date.now(),
): GroupView {
  const wanted = [...new Set(userIds)];
  return runImmediate(() => {
    requireScope(scope);
    const group = groupRow(scope, groupId);
    if (!group) {
      throw new QuotaStoreError("not_found", "group");
    }
    const isMember = sql.prepare("SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?");
    for (const userId of wanted) {
      if (typeof userId !== "string" || !isMember.get(scope.organizationId, userId)) {
        throw new QuotaStoreError("subject_invalid", "member");
      }
    }
    const current = new Set(memberIdsOf(groupId));
    const added = wanted.filter((userId) => !current.has(userId));
    const removed = [...current].filter((userId) => !wanted.includes(userId));
    for (const userId of removed) {
      sql.prepare("DELETE FROM company_group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId);
      appendAudit(scope, actorUserId, "group.member.remove", null, { groupId, userId }, now);
    }
    for (const userId of added) {
      sql
        .prepare("INSERT INTO company_group_members (group_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)")
        .run(groupId, userId, actorUserId, now);
      appendAudit(scope, actorUserId, "group.member.add", null, { groupId, userId }, now);
    }
    return viewOf(group);
  });
}

export function deleteGroup(scope: QuotaScope, actorUserId: string, groupId: string, now = Date.now()): void {
  runImmediate(() => {
    requireScope(scope);
    const group = groupRow(scope, groupId);
    if (!group) {
      throw new QuotaStoreError("not_found", "group");
    }
    const memberCount = memberIdsOf(groupId).length;
    sql
      .prepare(
        `DELETE FROM quota_assignments WHERE subject_kind = 'group' AND subject_id = ?
           AND allocation_id IN (SELECT id FROM quota_allocations WHERE organization_id = ? AND tenant_id = ?)`,
      )
      .run(groupId, scope.organizationId, scope.tenantId);
    sql
      .prepare("DELETE FROM company_groups WHERE id = ? AND organization_id = ? AND tenant_id = ?")
      .run(groupId, scope.organizationId, scope.tenantId);
    appendAudit(scope, actorUserId, "group.delete", null, { groupId, memberCount }, now);
  });
}
