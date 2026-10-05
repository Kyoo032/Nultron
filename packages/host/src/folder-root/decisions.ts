import type { TenantContext } from "@agentforge/core";
import { folderUnavailableError, notMountedError, proposalNotFoundError, proposalNotPendingError } from "./api-errors";
import { applyChange, type ApplyFailure } from "./apply-change";
import { parseRelPath, resolveInside } from "./contain";
import { defaultFolderDeps, type FolderDeps } from "./deps";
import { folderRootAvailable } from "./availability";
import { openMount } from "./mount";
import type { ProposalKind, ProposalRecord, ProposalStatus, ProposalSummary } from "./proposal-store";
import { isFolderRefusal } from "./refusal";
import { readTextFile } from "./text-file";

export type ApproveOutcome =
  | { readonly id: string; readonly status: "applied" }
  | { readonly id: string; readonly status: "stale" }
  | { readonly id: string; readonly status: "failed"; readonly reason: ApplyFailure };

export type ProposalDiff = {
  readonly id: string;
  readonly path: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  /** The file's text right now; empty when it does not exist or cannot be read as text. */
  readonly before: string;
  /** The text the file would hold after approval; empty for a delete. */
  readonly after: string;
  /** True when the file is no longer the one the proposal was made against. */
  readonly stale: boolean;
};

function requireAvailable(): void {
  if (!folderRootAvailable()) {
    throw folderUnavailableError();
  }
}

async function storeOf(deps?: FolderDeps): Promise<FolderDeps["store"]> {
  return (deps ?? (await defaultFolderDeps())).store;
}

async function requireProposal(tenant: TenantContext, id: string, deps?: FolderDeps): Promise<ProposalRecord> {
  const record = (await storeOf(deps)).get(tenant, id);
  if (!record) {
    throw proposalNotFoundError();
  }
  return record;
}

export async function listProposals(
  tenant: TenantContext,
  status?: ProposalStatus,
  deps?: FolderDeps,
): Promise<ProposalSummary[]> {
  requireAvailable();
  return (await storeOf(deps)).list(tenant, status);
}

async function currentTextOf(rootReal: string, relPath: string): Promise<{ text: string; sha256: string } | null> {
  try {
    const resolved = await resolveInside(rootReal, parseRelPath(relPath));
    return resolved.exists ? await readTextFile(resolved.target) : null;
  } catch (error) {
    if (isFolderRefusal(error)) {
      return null;
    }
    throw error;
  }
}

/** What the owner is shown before deciding: the file now, and the file as it would become. */
export async function getProposalDiff(tenant: TenantContext, id: string, deps?: FolderDeps): Promise<ProposalDiff> {
  requireAvailable();
  const record = await requireProposal(tenant, id, deps);
  const mount = await openMount(tenant.workspaceId);
  const current = mount.ok ? await currentTextOf(mount.rootReal, record.path) : null;
  return {
    id: record.id,
    path: record.path,
    kind: record.kind,
    status: record.status,
    before: current?.text ?? "",
    after: record.afterBody ?? "",
    stale: (current?.sha256 ?? null) !== record.beforeSha256,
  };
}

/**
 * The owner's yes. The proposal is claimed first (pending to approved, once), so two clicks or two
 * windows cannot apply it twice; then the change is applied against the file as it is now.
 */
export async function approveProposal(tenant: TenantContext, id: string, deps?: FolderDeps): Promise<ApproveOutcome> {
  requireAvailable();
  const store = await storeOf(deps);
  const record = await requireProposal(tenant, id, deps);
  if (record.status !== "pending") {
    throw proposalNotPendingError();
  }
  const mount = await openMount(tenant.workspaceId);
  if (!mount.ok) {
    throw notMountedError();
  }
  if (!store.claim(tenant, id)) {
    throw proposalNotPendingError();
  }
  const result = await applyChange(mount.rootReal, record);
  store.finish(tenant, id, result.status);
  return { id, ...result };
}

export async function rejectProposal(
  tenant: TenantContext,
  id: string,
  deps?: FolderDeps,
): Promise<{ readonly id: string; readonly status: "rejected" }> {
  requireAvailable();
  const store = await storeOf(deps);
  const record = await requireProposal(tenant, id, deps);
  if (record.status !== "pending" || !store.reject(tenant, id)) {
    throw proposalNotPendingError();
  }
  return { id, status: "rejected" };
}
