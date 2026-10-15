import { asRecord, readNumber, readString, type Rec } from "./results";

export const MEDIA_TOOL_KEYS = ["image_generate", "video_generate"] as const;
export type MediaToolKey = (typeof MEDIA_TOOL_KEYS)[number];
export type MediaKind = "image" | "video";
export const MEDIA_STATUSES = ["pending", "generated", "skipped", "expired", "failed"] as const;
export type MediaProposalStatus = (typeof MEDIA_STATUSES)[number];

export function isMediaTool(key: string): key is MediaToolKey {
  return (MEDIA_TOOL_KEYS as readonly string[]).includes(key);
}

export type MediaEstimate = {
  readonly amountMicros: number | null;
  readonly currency: "USD";
};

export type PendingMedia = {
  readonly proposalId: string;
  readonly kind: MediaKind;
  readonly prompt: string;
  readonly amountMicros: number | null;
};

export type MediaProposal = {
  readonly id: string;
  readonly kind: MediaKind;
  readonly prompt: string;
  readonly status: MediaProposalStatus;
  readonly estimate: MediaEstimate;
};

export type AlwaysAllow = {
  readonly image: boolean;
  readonly video: boolean;
};

export type GeneratedMedia = {
  readonly proposal: MediaProposal;
  readonly result: Rec | null;
};

function kindOf(value: unknown): MediaKind | null {
  return value === "image" || value === "video" ? value : null;
}

function statusOf(value: unknown): MediaProposalStatus | null {
  return (MEDIA_STATUSES as readonly unknown[]).includes(value) ? (value as MediaProposalStatus) : null;
}

function amountOf(estimate: Rec | null): number | null {
  const micros = readNumber(estimate, "amountMicros");
  return micros !== undefined && micros >= 0 ? micros : null;
}

export function readPendingMedia(toolKey: string, output: unknown): PendingMedia | null {
  const record = asRecord(output);
  if (!isMediaTool(toolKey) || record?.ok !== true || record.status !== "pending_approval") {
    return null;
  }
  const kind = kindOf(record.kind);
  const proposalId = readString(record, "proposalId");
  if (!kind || !proposalId) {
    return null;
  }
  return {
    proposalId,
    kind,
    prompt: readString(record, "prompt") ?? "",
    amountMicros: amountOf(asRecord(record.estimate)),
  };
}

export function readAutoAllowed(toolKey: string, output: unknown): boolean {
  return isMediaTool(toolKey) && asRecord(output)?.autoAllowed === true;
}

export function readMediaProposal(body: unknown): MediaProposal | null {
  const record = asRecord(body);
  const id = readString(record, "id");
  const kind = kindOf(record?.kind);
  const status = statusOf(record?.status);
  if (!id || !kind || !status) {
    return null;
  }
  return {
    id,
    kind,
    prompt: readString(record, "prompt") ?? "",
    status,
    estimate: { amountMicros: amountOf(asRecord(record?.estimate)), currency: "USD" },
  };
}

export function readProposalEnvelope(body: unknown): MediaProposal | null {
  return readMediaProposal(asRecord(body)?.proposal);
}

export function readGeneratedEnvelope(body: unknown): GeneratedMedia | null {
  const record = asRecord(body);
  const proposal = readMediaProposal(record?.proposal);
  if (!proposal) {
    return null;
  }
  return { proposal, result: asRecord(record?.result) };
}

export function readAlwaysAllow(body: unknown): AlwaysAllow | null {
  const record = asRecord(body);
  if (!record || typeof record.image !== "boolean" || typeof record.video !== "boolean") {
    return null;
  }
  return { image: record.image, video: record.video };
}

export function formatMediaUsd(amountMicros: number, locale: string): string {
  const tag = locale === "id" ? "id-ID" : "en-US";
  return new Intl.NumberFormat(tag, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amountMicros / 1_000_000);
}
