import { randomUUID } from "node:crypto";
import { sql } from "@agentforge/db";
import {
  normalizeModelId,
  QUOTA_MODELS_MODES,
  QUOTA_SCOPE_KINDS,
  type QuotaModelsMode,
  type QuotaScopeKind,
  type QuotaStatus,
} from "@agentforge/core/quota";
import { appendAudit, type AuditValue } from "./audit";
import {
  assertMicros,
  isUniqueViolation,
  QuotaStoreError,
  requireScope,
  runImmediate,
  type QuotaScope,
} from "./common";
import { loadViews, selectAllocationRow, type AllocationDetail, type AllocationRow } from "./views";

export type AllocationInput = {
  name: string;
  scopeKind: QuotaScopeKind;
  limitMicros: number;
  perPersonLimitMicros?: number | null;
  periodKind: "lifetime" | "monthly";
  modelsMode?: QuotaModelsMode;
  models?: readonly string[];
  priority?: number;
  gatewayTokenId?: string | null;
  assignedPersonIds?: readonly string[];
  assignedGroupIds?: readonly string[];
};

export type AllocationPatch = {
  name?: string;
  limitMicros?: number;
  perPersonLimitMicros?: number | null;
  modelsMode?: QuotaModelsMode;
  models?: readonly string[];
  priority?: number;
  gatewayTokenId?: string | null;
  assignedPersonIds?: readonly string[];
  assignedGroupIds?: readonly string[];
};

const NAME_MAX = 120;
const MODEL_ID_MAX = 200;
const MODELS_MAX = 500;
const ASSIGNMENTS_MAX = 5000;

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new QuotaStoreError("invalid_input", "name");
  }
  return name;
}

function cleanModels(raw: readonly string[] | undefined): string[] {
  const models = [...new Set((raw ?? []).map((model) => normalizeModelId(String(model))))];
  if (models.length > MODELS_MAX || models.some((model) => model.length === 0 || model.length > MODEL_ID_MAX)) {
    throw new QuotaStoreError("invalid_input", "models");
  }
  return models.sort();
}

function cleanIds(raw: readonly string[] | undefined, name: string): string[] {
  const ids = [...new Set(raw ?? [])];
  if (ids.length > ASSIGNMENTS_MAX || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new QuotaStoreError("invalid_input", name);
  }
  return ids.sort();
}

function cleanPriority(raw: number | undefined): number {
  if (raw === undefined) {
    return 0;
  }
  if (!Number.isInteger(raw) || raw < -1000 || raw > 1000) {
    throw new QuotaStoreError("invalid_input", "priority");
  }
  return raw;
}

function requireSubjects(
  scope: QuotaScope,
  scopeKind: QuotaScopeKind,
  personIds: readonly string[],
  groupIds: readonly string[],
): void {
  if (scopeKind !== "people" && personIds.length > 0) {
    throw new QuotaStoreError("invalid_input", "people are assigned only to a people allocation");
  }
  if (scopeKind !== "groups" && groupIds.length > 0) {
    throw new QuotaStoreError("invalid_input", "groups are assigned only to a groups allocation");
  }
  const isMember = sql.prepare("SELECT 1 AS ok FROM organization_members WHERE organization_id = ? AND user_id = ?");
  for (const userId of personIds) {
    if (!isMember.get(scope.organizationId, userId)) {
      throw new QuotaStoreError("subject_invalid", "person");
    }
  }
  const isGroup = sql.prepare(
    "SELECT 1 AS ok FROM company_groups WHERE id = ? AND organization_id = ? AND tenant_id = ? AND archived_at IS NULL",
  );
  for (const groupId of groupIds) {
    if (!isGroup.get(groupId, scope.organizationId, scope.tenantId)) {
      throw new QuotaStoreError("subject_invalid", "group");
    }
  }
}

function capRoom(scope: QuotaScope, excludeId: string | null, addMicros: number): void {
  const settings = sql
    .prepare("SELECT company_cap_micros FROM company_quota_settings WHERE organization_id = ? AND tenant_id = ?")
    .get(scope.organizationId, scope.tenantId) as { company_cap_micros: number | null } | undefined;
  const cap = settings?.company_cap_micros;
  if (cap === null || cap === undefined) {
    return;
  }
  const row = sql
    .prepare(
      `SELECT COALESCE(SUM(limit_micros), 0) AS total FROM quota_allocations
        WHERE organization_id = ? AND tenant_id = ? AND status <> 'archived' AND id <> ?`,
    )
    .get(scope.organizationId, scope.tenantId, excludeId ?? "") as { total: number };
  if (row.total + addMicros > cap) {
    throw new QuotaStoreError("exceeds_company_cap");
  }
}

function writeModels(allocationId: string, models: readonly string[]): void {
  sql.prepare("DELETE FROM quota_allocation_models WHERE allocation_id = ?").run(allocationId);
  const insert = sql.prepare("INSERT INTO quota_allocation_models (allocation_id, model_id) VALUES (?, ?)");
  for (const model of models) {
    insert.run(allocationId, model);
  }
}

function writeAssignments(allocationId: string, kind: "person" | "group", ids: readonly string[]): void {
  sql.prepare("DELETE FROM quota_assignments WHERE allocation_id = ? AND subject_kind = ?").run(allocationId, kind);
  const insert = sql.prepare(
    "INSERT INTO quota_assignments (allocation_id, subject_kind, subject_id) VALUES (?, ?, ?)",
  );
  for (const id of ids) {
    insert.run(allocationId, kind, id);
  }
}

function view(scope: QuotaScope, id: string, now: number): AllocationDetail {
  const found = loadViews(scope, now, undefined, true).find((entry) => entry.id === id);
  if (!found) {
    throw new QuotaStoreError("not_found", "allocation");
  }
  return found;
}

export function listAllocations(
  scope: QuotaScope,
  options: { includeArchived?: boolean; now?: number } = {},
): AllocationDetail[] {
  requireScope(scope);
  return loadViews(scope, options.now ?? Date.now(), undefined, options.includeArchived === true);
}

export function getAllocation(scope: QuotaScope, id: string, now = Date.now()): AllocationDetail | null {
  requireScope(scope);
  return loadViews(scope, now, undefined, true).find((entry) => entry.id === id) ?? null;
}

export function createAllocation(
  scope: QuotaScope,
  actorUserId: string,
  input: AllocationInput,
  now = Date.now(),
): AllocationDetail {
  const name = cleanName(input.name);
  if (!(QUOTA_SCOPE_KINDS as readonly string[]).includes(input.scopeKind)) {
    throw new QuotaStoreError("invalid_input", "scopeKind");
  }
  if (input.periodKind !== "lifetime" && input.periodKind !== "monthly") {
    throw new QuotaStoreError("invalid_input", "periodKind");
  }
  const modelsMode = input.modelsMode ?? "all";
  if (!(QUOTA_MODELS_MODES as readonly string[]).includes(modelsMode)) {
    throw new QuotaStoreError("invalid_input", "modelsMode");
  }
  const limit = assertMicros(input.limitMicros, "limitMicros");
  const perPerson =
    input.perPersonLimitMicros === undefined || input.perPersonLimitMicros === null
      ? null
      : assertMicros(input.perPersonLimitMicros, "perPersonLimitMicros");
  if (perPerson !== null && input.scopeKind === "people") {
    throw new QuotaStoreError("invalid_input", "a people allocation has no per-person ceiling");
  }
  const models = cleanModels(input.models);
  const personIds = cleanIds(input.assignedPersonIds, "assignedPersonIds");
  const groupIds = cleanIds(input.assignedGroupIds, "assignedGroupIds");
  const priority = cleanPriority(input.priority);
  return runImmediate(() => {
    requireScope(scope);
    requireSubjects(scope, input.scopeKind, personIds, groupIds);
    capRoom(scope, null, limit);
    const id = randomUUID();
    try {
      sql
        .prepare(
          `INSERT INTO quota_allocations (id, organization_id, tenant_id, name, scope_kind, limit_micros,
             per_person_limit_micros, period_kind, models_mode, priority, gateway_token_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope.organizationId,
          scope.tenantId,
          name,
          input.scopeKind,
          limit,
          perPerson,
          input.periodKind,
          modelsMode,
          priority,
          input.gatewayTokenId ?? null,
          actorUserId,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new QuotaStoreError("duplicate", "a live allocation of this kind already exists");
      }
      throw error;
    }
    writeModels(id, models);
    writeAssignments(id, "person", personIds);
    writeAssignments(id, "group", groupIds);
    appendAudit(
      scope,
      actorUserId,
      "allocation.create",
      id,
      { scopeKind: input.scopeKind, limitMicros: limit, perPersonLimitMicros: perPerson, models },
      now,
    );
    if (personIds.length + groupIds.length > 0) {
      appendAudit(scope, actorUserId, "allocation.assign", id, { personIds, groupIds }, now);
    }
    return view(scope, id, now);
  });
}

function diff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
  };
}

function applyPatchColumns(scope: QuotaScope, row: AllocationRow, patch: AllocationPatch): Record<string, AuditValue> {
  const changes: Record<string, AuditValue> = {};
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name !== row.name) {
      sets.push("name = ?");
      values.push(name);
      changes.name = true;
    }
  }
  if (patch.limitMicros !== undefined) {
    const limit = assertMicros(patch.limitMicros, "limitMicros");
    if (limit !== row.limit_micros) {
      if (limit > row.limit_micros) {
        capRoom(scope, row.id, limit);
      }
      sets.push("limit_micros = ?");
      values.push(limit);
      changes.limitMicros = { before: row.limit_micros, after: limit };
    }
  }
  if (patch.perPersonLimitMicros !== undefined) {
    const perPerson =
      patch.perPersonLimitMicros === null ? null : assertMicros(patch.perPersonLimitMicros, "perPersonLimitMicros");
    if (perPerson !== null && row.scope_kind === "people") {
      throw new QuotaStoreError("invalid_input", "a people allocation has no per-person ceiling");
    }
    if (perPerson !== row.per_person_limit_micros) {
      sets.push("per_person_limit_micros = ?");
      values.push(perPerson);
      changes.perPersonLimitMicros = { before: row.per_person_limit_micros, after: perPerson };
    }
  }
  if (patch.modelsMode !== undefined) {
    if (!(QUOTA_MODELS_MODES as readonly string[]).includes(patch.modelsMode)) {
      throw new QuotaStoreError("invalid_input", "modelsMode");
    }
    if (patch.modelsMode !== row.models_mode) {
      sets.push("models_mode = ?");
      values.push(patch.modelsMode);
      changes.modelsMode = { before: row.models_mode, after: patch.modelsMode };
    }
  }
  if (patch.priority !== undefined) {
    const priority = cleanPriority(patch.priority);
    if (priority !== row.priority) {
      sets.push("priority = ?");
      values.push(priority);
      changes.priority = { before: row.priority, after: priority };
    }
  }
  if (patch.gatewayTokenId !== undefined && patch.gatewayTokenId !== row.gateway_token_id) {
    sets.push("gateway_token_id = ?");
    values.push(patch.gatewayTokenId);
    changes.gatewayTokenId = { before: row.gateway_token_id, after: patch.gatewayTokenId };
  }
  if (sets.length > 0) {
    sql
      .prepare(`UPDATE quota_allocations SET ${sets.join(", ")} WHERE id = ? AND organization_id = ? AND tenant_id = ?`)
      .run(...values, row.id, scope.organizationId, scope.tenantId);
  }
  return changes;
}

export function updateAllocation(
  scope: QuotaScope,
  actorUserId: string,
  id: string,
  expectedVersion: number,
  patch: AllocationPatch,
  now = Date.now(),
): AllocationDetail {
  return runImmediate(() => {
    requireScope(scope);
    const row = selectAllocationRow(scope, id);
    if (!row) {
      throw new QuotaStoreError("not_found", "allocation");
    }
    if (row.status === "archived") {
      throw new QuotaStoreError("archived");
    }
    if (row.version !== expectedVersion) {
      throw new QuotaStoreError("version_conflict");
    }
    const current = view(scope, id, now);
    const changes = applyPatchColumns(scope, row, patch);
    let touched = Object.keys(changes).length > 0;
    if (patch.models !== undefined) {
      const models = cleanModels(patch.models);
      const delta = diff(current.models, models);
      if (delta.added.length + delta.removed.length > 0) {
        writeModels(id, models);
        changes.models = { added: delta.added, removed: delta.removed };
        touched = true;
      }
    }
    const people =
      patch.assignedPersonIds === undefined ? undefined : cleanIds(patch.assignedPersonIds, "assignedPersonIds");
    const groups =
      patch.assignedGroupIds === undefined ? undefined : cleanIds(patch.assignedGroupIds, "assignedGroupIds");
    if (people !== undefined || groups !== undefined) {
      const nextPeople = people ?? current.assignedPersonIds;
      const nextGroups = groups ?? current.assignedGroupIds;
      requireSubjects(scope, row.scope_kind, nextPeople, nextGroups);
      const personDelta = diff(current.assignedPersonIds, nextPeople);
      const groupDelta = diff(current.assignedGroupIds, nextGroups);
      if (personDelta.added.length + groupDelta.added.length > 0) {
        writeAssignments(id, "person", nextPeople);
        writeAssignments(id, "group", nextGroups);
        appendAudit(
          scope,
          actorUserId,
          "allocation.assign",
          id,
          { personIds: personDelta.added, groupIds: groupDelta.added },
          now,
        );
        touched = true;
      }
      if (personDelta.removed.length + groupDelta.removed.length > 0) {
        writeAssignments(id, "person", nextPeople);
        writeAssignments(id, "group", nextGroups);
        appendAudit(
          scope,
          actorUserId,
          "allocation.unassign",
          id,
          { personIds: personDelta.removed, groupIds: groupDelta.removed },
          now,
        );
        touched = true;
      }
    }
    if (!touched) {
      return current;
    }
    const bumped = sql
      .prepare(
        `UPDATE quota_allocations SET version = version + 1, updated_at = ?
          WHERE id = ? AND organization_id = ? AND tenant_id = ? AND version = ?`,
      )
      .run(now, id, scope.organizationId, scope.tenantId, expectedVersion);
    if (bumped.changes !== 1) {
      throw new QuotaStoreError("version_conflict");
    }
    if (Object.keys(changes).length > 0) {
      appendAudit(scope, actorUserId, "allocation.update", id, changes, now);
    }
    return view(scope, id, now);
  });
}

const STATUS_ACTION = {
  paused: "allocation.pause",
  active: "allocation.resume",
  archived: "allocation.archive",
} as const;

export function setAllocationStatus(
  scope: QuotaScope,
  actorUserId: string,
  id: string,
  status: QuotaStatus,
  now = Date.now(),
): AllocationDetail {
  if (!(status in STATUS_ACTION)) {
    throw new QuotaStoreError("invalid_input", "status");
  }
  return runImmediate(() => {
    requireScope(scope);
    const row = selectAllocationRow(scope, id);
    if (!row) {
      throw new QuotaStoreError("not_found", "allocation");
    }
    if (row.status === status) {
      return view(scope, id, now);
    }
    if (row.status === "archived") {
      throw new QuotaStoreError("archived");
    }
    sql
      .prepare(
        `UPDATE quota_allocations SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND organization_id = ? AND tenant_id = ?`,
      )
      .run(status, now, id, scope.organizationId, scope.tenantId);
    appendAudit(scope, actorUserId, STATUS_ACTION[status], id, { before: row.status, after: status }, now);
    return view(scope, id, now);
  });
}
