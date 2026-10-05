/**
 * The Personal "open a folder" routes, seen from the renderer.
 *
 * The wire contract is `packages/host/src/folder-root/routes.ts`; the shapes are mirrored here
 * rather than imported, because the renderer never imports the host. Everything the host answers is
 * validated before it reaches a component: an answer this file does not recognise becomes a typed
 * failure, never a throw, so the Chat composer can never be held up by this panel.
 *
 * The folder's path never comes back from the host (`name` is the last segment only), and the path
 * the owner picked goes out once, in `mountFolder`, and is not kept.
 */
import { apiFetch } from "./api-client";

export const FOLDER_PATH = "/api/v1/folder";
export const FOLDER_MOUNT_PATH = "/api/v1/folder/mount";
export const FOLDER_PROPOSALS_PATH = "/api/v1/folder/proposals";

/** Codes the host sends for a refused folder call, plus the two this client adds itself. */
export const FOLDER_ERROR_CODES = [
  "folder_unavailable",
  "folder_mount_ipc_only",
  "folder_mount_refused",
  "folder_not_mounted",
  "proposal_not_pending",
  "not_found",
  "network",
  "noPicker",
  "unknown",
] as const;
export type FolderErrorCode = (typeof FOLDER_ERROR_CODES)[number];

export const PROPOSAL_KINDS = ["write", "delete"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["pending", "approved", "applied", "rejected", "stale", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type FolderStatus = {
  readonly available: boolean;
  readonly mounted: boolean;
  /** The last segment of the folder's path; null when nothing is open. */
  readonly name: string | null;
};

export type ProposalSummary = {
  readonly id: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
};

export type ProposalDiff = {
  readonly id: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  /** The file's text right now; empty when it does not exist or is not text. */
  readonly before: string;
  /** The text the file would hold after approval; empty for a delete. */
  readonly after: string;
  /** True when the file is no longer the one the proposal was made against. */
  readonly stale: boolean;
};

export type ApplyFailure = "denied" | "io_error";

export type ApproveOutcome =
  | { readonly status: "applied" }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly reason: ApplyFailure };

export type FolderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: FolderErrorCode; readonly status: number };

/** The status a host that predates these routes, or a hosted one, is read as. */
export const NO_FOLDER: FolderStatus = Object.freeze({ available: false, mounted: false, name: null });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseFolderStatus(body: unknown): FolderStatus | null {
  if (!isRecord(body) || typeof body.available !== "boolean" || typeof body.mounted !== "boolean") {
    return null;
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name : null;
  return { available: body.available, mounted: body.mounted, name: body.mounted ? name : null };
}

function parseProposal(body: unknown): ProposalSummary | null {
  if (!isRecord(body) || typeof body.id !== "string" || typeof body.path !== "string") {
    return null;
  }
  const kind = oneOf(PROPOSAL_KINDS, body.kind);
  const status = oneOf(PROPOSAL_STATUSES, body.status);
  return kind && status && body.id ? { id: body.id, path: body.path, kind, status } : null;
}

export function parseProposalList(body: unknown): ProposalSummary[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return null;
  }
  return body.items.map(parseProposal).filter((item): item is ProposalSummary => item !== null);
}

export function parseProposalDiff(body: unknown): ProposalDiff | null {
  const summary = parseProposal(body);
  if (!summary || !isRecord(body) || typeof body.before !== "string" || typeof body.after !== "string") {
    return null;
  }
  return { ...summary, before: body.before, after: body.after, stale: body.stale === true };
}

export function parseApproveOutcome(body: unknown): ApproveOutcome | null {
  if (!isRecord(body)) {
    return null;
  }
  if (body.status === "applied" || body.status === "stale") {
    return { status: body.status };
  }
  if (body.status === "failed") {
    return { status: "failed", reason: body.reason === "denied" ? "denied" : "io_error" };
  }
  return null;
}

/** The host's error body is `{ error: { code, message } }`; only the code is used, the copy is ours. */
export function errorCodeOf(body: unknown): FolderErrorCode {
  const error = isRecord(body) ? body.error : null;
  const code = isRecord(error) ? error.code : null;
  return oneOf(FOLDER_ERROR_CODES, code) ?? "unknown";
}

type Parse<T> = (body: unknown) => T | null;

async function call<T>(path: string, init: RequestInit, parse: Parse<T>): Promise<FolderResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, code: errorCodeOf(body), status: response.status };
  }
  const value = parse(body);
  return value === null ? { ok: false, code: "unknown", status: response.status } : { ok: true, value };
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function proposalPath(id: string, action?: "approve" | "reject"): string {
  const base = `${FOLDER_PROPOSALS_PATH}/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

/** Is a folder possible here, and is one open? Answers `available: false` on the hosted server. */
export function fetchFolderStatus(): Promise<FolderResult<FolderStatus>> {
  return call(FOLDER_PATH, {}, parseFolderStatus);
}

/** Open `path` as the desk's folder. Only the desktop shell's IPC may do this; the host checks. */
export function mountFolder(path: string): Promise<FolderResult<FolderStatus>> {
  return call(
    FOLDER_MOUNT_PATH,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ path }) },
    parseFolderStatus,
  );
}

/** Close the folder; the host drops whatever was waiting for approval. */
export function unmountFolder(): Promise<FolderResult<true>> {
  return call(FOLDER_MOUNT_PATH, { method: "DELETE" }, (body) => (isRecord(body) && body.ok === true ? true : null));
}

/** Proposals waiting for a decision, newest first. */
export function listPendingProposals(): Promise<FolderResult<ProposalSummary[]>> {
  return call(`${FOLDER_PROPOSALS_PATH}?status=pending`, {}, parseProposalList);
}

export function fetchProposalDiff(id: string): Promise<FolderResult<ProposalDiff>> {
  return call(proposalPath(id), {}, parseProposalDiff);
}

export function approveProposal(id: string): Promise<FolderResult<ApproveOutcome>> {
  return call(proposalPath(id, "approve"), { method: "POST" }, parseApproveOutcome);
}

export function rejectProposal(id: string): Promise<FolderResult<true>> {
  return call(proposalPath(id, "reject"), { method: "POST" }, (body) =>
    isRecord(body) && body.status === "rejected" ? true : null,
  );
}

/** The seven calls as one object, so the controller can be driven by a fake in a test. */
export type FolderApi = {
  readonly status: typeof fetchFolderStatus;
  readonly mount: typeof mountFolder;
  readonly unmount: typeof unmountFolder;
  readonly pending: typeof listPendingProposals;
  readonly diff: typeof fetchProposalDiff;
  readonly approve: typeof approveProposal;
  readonly reject: typeof rejectProposal;
};

export const folderApi: FolderApi = {
  status: fetchFolderStatus,
  mount: mountFolder,
  unmount: unmountFolder,
  pending: listPendingProposals,
  diff: fetchProposalDiff,
  approve: approveProposal,
  reject: rejectProposal,
};
