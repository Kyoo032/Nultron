import { apiFetch } from "./api-client";

/** One Activity Log row as the host returns it — metadata columns only. */
export type AuditEvent = {
  readonly seq: number;
  readonly id: string;
  readonly tenant_id: string;
  readonly at: number;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly agent_id: string | null;
  readonly event: string;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly outcome: string | null;
  readonly duration_ms: number | null;
  readonly item_count: number | null;
  readonly ref_hash: string | null;
  readonly channel: string | null;
  readonly rule: string | null;
};

export type AuditEventsPage = {
  readonly events: AuditEvent[];
  readonly nextCursor: number | null;
};

export type AuditFilter = {
  readonly from?: number;
  readonly to?: number;
  readonly actor?: string;
  readonly agent?: string;
  readonly event?: string;
  readonly outcome?: string;
};

export type AuditVerification = {
  readonly ok: boolean;
  readonly firstBadSeq?: number;
  readonly checked: number;
};

function queryFor(filter: AuditFilter, cursor?: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filter, cursor })) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function loadAuditEvents(filter: AuditFilter, cursor?: number): Promise<AuditEventsPage> {
  const res = await apiFetch(`/api/v1/audit/events${queryFor(filter, cursor)}`);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as { error?: { message?: unknown } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : "Could not load the activity log";
    throw new Error(message);
  }
  return data as AuditEventsPage;
}

export async function verifyAuditIntegrity(): Promise<AuditVerification> {
  const res = await apiFetch("/api/v1/audit/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error("Integrity check failed to run");
  }
  return data as AuditVerification;
}

/** A download URL; the browser follows it and the host streams the file plus its manifest header. */
export function auditExportUrl(format: "csv" | "jsonl", filter: AuditFilter): string {
  const query = queryFor(filter);
  return `/api/v1/audit/export${query}${query ? "&" : "?"}format=${format}`;
}
