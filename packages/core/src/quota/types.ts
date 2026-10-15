import type { MembershipRole } from "../tenancy/types";

export const QUOTA_SCOPE_KINDS = ["everyone", "groups", "people", "admins"] as const;
export type QuotaScopeKind = (typeof QUOTA_SCOPE_KINDS)[number];

export const QUOTA_STATUSES = ["active", "paused", "archived"] as const;
export type QuotaStatus = (typeof QUOTA_STATUSES)[number];

export const QUOTA_MODELS_MODES = ["all", "list"] as const;
export type QuotaModelsMode = (typeof QUOTA_MODELS_MODES)[number];

export type Payer = {
  userId: string;
  role: MembershipRole | null;
  groupIds: readonly string[];
};

export type AllocationView = {
  id: string;
  name: string;
  scopeKind: QuotaScopeKind;
  status: QuotaStatus;
  limitMicros: number;
  spentMicros: number;
  heldMicros: number;
  modelsMode: QuotaModelsMode;
  models: readonly string[];
  priority: number;
  createdAt: number;
  assignedPersonIds: readonly string[];
  assignedGroupIds: readonly string[];
  perPersonLimitMicros?: number;
  personSpentMicros?: number;
  personHeldMicros?: number;
};

export type Resolution =
  | { ok: true; allocation: AllocationView }
  | { ok: false; code: "quota_none" }
  | { ok: false; code: "quota_paused"; allocation: AllocationView };
