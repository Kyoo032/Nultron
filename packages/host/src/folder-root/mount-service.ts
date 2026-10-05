import path from "node:path";
import { ApiError, type TenantContext } from "@agentforge/core";
import { folderRootAvailable } from "./availability";
import { FOLDER_MOUNT_REFUSED_CODE } from "./constants";
import { defaultFolderDeps, type FolderDeps } from "./deps";
import { folderUnavailableError } from "./api-errors";
import { openMount } from "./mount";
import { clearMount, getMount, setMount } from "./mount-record";
import { MOUNT_REFUSAL_MESSAGES, checkMountPath } from "./mount-validate";
import { isSamePath } from "./path-compare";

export type FolderStatus = {
  readonly mounted: boolean;
  /** The last segment of the folder's path, never the path itself. */
  readonly name: string | null;
  readonly available: boolean;
};

export const UNAVAILABLE_STATUS: FolderStatus = { mounted: false, name: null, available: false };

/** What the desk's folder is right now. Never touches the mount record when the folder root is off. */
export async function folderStatus(tenant: TenantContext): Promise<FolderStatus> {
  if (!folderRootAvailable()) {
    return UNAVAILABLE_STATUS;
  }
  const mount = await openMount(tenant.workspaceId);
  return { mounted: mount.ok, name: mount.ok ? mount.name : null, available: true };
}

/**
 * Make `input` the desk's folder. Pending proposals belong to the folder they were made against, so
 * picking a different one rejects them all: a "create this file" proposal must never land in a
 * folder the owner had not opened when the agent proposed it.
 */
export async function mountFolder(tenant: TenantContext, input: unknown, deps?: FolderDeps): Promise<FolderStatus> {
  if (!folderRootAvailable()) {
    throw folderUnavailableError();
  }
  const checked = await checkMountPath(input);
  if (!checked.ok) {
    throw new ApiError(FOLDER_MOUNT_REFUSED_CODE, MOUNT_REFUSAL_MESSAGES[checked.reason], 400);
  }
  const previous = getMount(tenant.workspaceId);
  if (!previous || !isSamePath(previous.path, checked.real)) {
    const { store } = deps ?? (await defaultFolderDeps());
    store.rejectAllPending(tenant);
  }
  setMount(tenant.workspaceId, checked.real);
  return { mounted: true, name: path.basename(checked.real), available: true };
}

/** Close the desk's folder and reject whatever was waiting on it. */
export async function unmountFolder(tenant: TenantContext, deps?: FolderDeps): Promise<void> {
  if (!folderRootAvailable()) {
    throw folderUnavailableError();
  }
  const { store } = deps ?? (await defaultFolderDeps());
  store.rejectAllPending(tenant);
  clearMount(tenant.workspaceId);
}
