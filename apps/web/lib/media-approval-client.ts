import {
  readAlwaysAllow,
  readGeneratedEnvelope,
  readProposalEnvelope,
  type AlwaysAllow,
  type GeneratedMedia,
  type MediaKind,
  type MediaProposal,
} from "@/components/tool-rows/media-result";
import { asRecord, readString } from "@/components/tool-rows/results";
import { apiFetch } from "./api-client";

export const MEDIA_PROPOSALS_PATH = "/api/v1/media/proposals";
export const MEDIA_ALWAYS_ALLOW_PATH = "/api/v1/media/always-allow";

export type MediaFailure = {
  readonly ok: false;
  readonly code: string;
  readonly status: number;
  readonly message: string | null;
};

export type MediaOutcome<T> = { readonly ok: true; readonly value: T } | MediaFailure;

export function mediaFailureOf(status: number, body: unknown): MediaFailure {
  const record = asRecord(body);
  if (typeof record?.error === "string") {
    return { ok: false, code: record.error, status, message: readString(record, "message") ?? null };
  }
  const nested = asRecord(record?.error);
  return {
    ok: false,
    code: readString(nested, "code") ?? "unknown",
    status,
    message: readString(nested, "message") ?? null,
  };
}

async function call<T>(path: string, init: RequestInit, read: (body: unknown) => T | null): Promise<MediaOutcome<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    return { ok: false, code: "network", status: 0, message: null };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return mediaFailureOf(response.status, body);
  }
  const value = read(body);
  return value === null ? { ok: false, code: "unknown", status: response.status, message: null } : { ok: true, value };
}

function proposalPath(id: string, action?: "generate" | "skip"): string {
  const base = `${MEDIA_PROPOSALS_PATH}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export function fetchMediaProposal(id: string): Promise<MediaOutcome<MediaProposal>> {
  return call(proposalPath(id), {}, readProposalEnvelope);
}

export function generateMediaProposal(id: string): Promise<MediaOutcome<GeneratedMedia>> {
  return call(proposalPath(id, "generate"), { method: "POST" }, readGeneratedEnvelope);
}

export function skipMediaProposal(id: string): Promise<MediaOutcome<MediaProposal>> {
  return call(proposalPath(id, "skip"), { method: "POST" }, readProposalEnvelope);
}

export function fetchAlwaysAllow(): Promise<MediaOutcome<AlwaysAllow>> {
  return call(MEDIA_ALWAYS_ALLOW_PATH, {}, readAlwaysAllow);
}

export function setAlwaysAllow(kind: MediaKind, allow: boolean): Promise<MediaOutcome<AlwaysAllow>> {
  return call(
    MEDIA_ALWAYS_ALLOW_PATH,
    { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ kind, allow }) },
    readAlwaysAllow,
  );
}

export type MediaApi = {
  readonly fetchProposal: typeof fetchMediaProposal;
  readonly generate: typeof generateMediaProposal;
  readonly skip: typeof skipMediaProposal;
  readonly fetchAlwaysAllow: typeof fetchAlwaysAllow;
  readonly setAlwaysAllow: typeof setAlwaysAllow;
};

export const mediaApi: MediaApi = {
  fetchProposal: fetchMediaProposal,
  generate: generateMediaProposal,
  skip: skipMediaProposal,
  fetchAlwaysAllow,
  setAlwaysAllow,
};
