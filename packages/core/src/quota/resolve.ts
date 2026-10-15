import { canAdminister } from "../tenancy/types";
import type { AllocationView, Payer, Resolution } from "./types";

const SCOPE_RANK = {
  people: 0,
  groups: 1,
  admins: 2,
  everyone: 3,
} as const;

type RankedAllocation = { allocation: AllocationView; rank: number };

function matchRank(payer: Payer, allocation: AllocationView): number | null {
  if (payer.role === null) {
    return null;
  }
  switch (allocation.scopeKind) {
    case "people":
      return allocation.assignedPersonIds.includes(payer.userId) ? SCOPE_RANK.people : null;
    case "groups":
      return allocation.assignedGroupIds.some((groupId) => payer.groupIds.includes(groupId)) ? SCOPE_RANK.groups : null;
    case "admins":
      return canAdminister(payer.role) ? SCOPE_RANK.admins : null;
    case "everyone":
      return SCOPE_RANK.everyone;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function bySpecificity(left: RankedAllocation, right: RankedAllocation): number {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  if (left.allocation.priority !== right.allocation.priority) {
    return left.allocation.priority - right.allocation.priority;
  }
  if (left.allocation.createdAt !== right.allocation.createdAt) {
    return left.allocation.createdAt - right.allocation.createdAt;
  }
  return compareText(left.allocation.id, right.allocation.id);
}

export function resolveAllocation(payer: Payer, all: readonly AllocationView[]): Resolution {
  const ranked = all.flatMap((allocation): RankedAllocation[] => {
    if (allocation.status === "archived") {
      return [];
    }
    const rank = matchRank(payer, allocation);
    return rank === null ? [] : [{ allocation, rank }];
  });
  if (ranked.length === 0) {
    return { ok: false, code: "quota_none" };
  }
  const winner = ranked.reduce((best, next) => (bySpecificity(next, best) < 0 ? next : best)).allocation;
  if (winner.status === "paused") {
    return { ok: false, code: "quota_paused", allocation: winner };
  }
  return { ok: true, allocation: winner };
}

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function modelAllowed(allocation: AllocationView, modelId: string): boolean {
  const needle = normalizeModelId(modelId);
  if (needle.length === 0) {
    return false;
  }
  if (allocation.modelsMode === "all") {
    return true;
  }
  return allocation.models.some((model) => normalizeModelId(model) === needle);
}

function roomOf(limitMicros: number, spentMicros: number, heldMicros: number): number {
  const room = limitMicros - spentMicros - heldMicros;
  return Number.isFinite(room) && room > 0 ? room : 0;
}

function personalRoom(allocation: AllocationView): number {
  if (allocation.perPersonLimitMicros === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (allocation.personSpentMicros === undefined || allocation.personHeldMicros === undefined) {
    return 0;
  }
  return roomOf(allocation.perPersonLimitMicros, allocation.personSpentMicros, allocation.personHeldMicros);
}

export function headroomMicros(allocation: AllocationView): number {
  const pool = roomOf(allocation.limitMicros, allocation.spentMicros, allocation.heldMicros);
  return Math.min(pool, personalRoom(allocation));
}
