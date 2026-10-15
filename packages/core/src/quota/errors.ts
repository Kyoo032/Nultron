export const QUOTA_ERROR_CODES = [
  "quota_none",
  "quota_exceeded",
  "quota_paused",
  "model_not_allowed",
  "model_not_priced",
  "pricing_unavailable",
  "quota_context_missing",
  "quota_busy",
] as const;

export type QuotaErrorCode = (typeof QUOTA_ERROR_CODES)[number];

export const QUOTA_ERROR_STATUS: Readonly<Record<QuotaErrorCode, number>> = {
  quota_none: 402,
  quota_exceeded: 402,
  quota_paused: 402,
  model_not_allowed: 403,
  model_not_priced: 409,
  pricing_unavailable: 503,
  quota_context_missing: 500,
  quota_busy: 503,
};

export function isQuotaErrorCode(value: unknown): value is QuotaErrorCode {
  return typeof value === "string" && (QUOTA_ERROR_CODES as readonly string[]).includes(value);
}
