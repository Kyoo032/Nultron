export const MEDIA_KINDS = ["image", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_PROPOSAL_STATUSES = ["pending", "generated", "skipped", "expired", "failed"] as const;
export type MediaProposalStatus = (typeof MEDIA_PROPOSAL_STATUSES)[number];

export const MEDIA_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export const MEDIA_CURRENCY = "USD";

export const MICROS_PER_USD = 1_000_000;

export const MEDIA_PROPOSAL_NOT_FOUND_CODE = "not_found";
export const MEDIA_PROPOSAL_NOT_PENDING_CODE = "not_pending";
export const MEDIA_PROPOSAL_EXPIRED_CODE = "expired";
export const MEDIA_PENDING_STATUS = "pending_approval";
export const MEDIA_NEEDS_PERSON_REASON = "needs_person";

export const PENDING_DESCRIPTION_SENTENCE =
  "When the result has status pending_approval, say the picture or clip is waiting for the person's OK, and do not describe it as made.";
