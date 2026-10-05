/**
 * The desk file store bound to the app database and the local vault key, the way `artifactStore()`
 * is. `file-store.ts` holds the logic and takes both as arguments, so a test can hand it a scratch
 * database.
 *
 * Importing this module opens the app database (it reaches `@agentforge/db`).
 */
import { sql } from "@agentforge/db";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import type { TenantContext } from "@agentforge/core";
import type { DeskPath, FileAuthor, FileRead, FileRoot, WriteOutcome } from "@agentforge/core/tools/files";
import { createDeskFileStore, type DeskFileStore, type DeskFileVersion } from "./file-store";

export { DESK_OBJECT_DIR, MAX_DESK_FILES, MAX_SEARCH_READ_BYTES } from "./file-store";
export type { DeskFileStore, DeskFileVersion } from "./file-store";

let defaultStore: DeskFileStore | null = null;

export function deskFileStore(): DeskFileStore {
  if (!defaultStore) {
    defaultStore = createDeskFileStore(sql, getLocalVaultKey);
  }
  return defaultStore;
}

/** The desk's file root: both products, every query scoped to `tenant.workspaceId`. */
export function createDeskRoot(tenant: TenantContext, author: FileAuthor): FileRoot {
  return deskFileStore().createDeskRoot(tenant, author);
}

export function listVersions(tenant: TenantContext, path: DeskPath): Promise<DeskFileVersion[]> {
  return deskFileStore().listVersions(tenant, path);
}

export function readVersion(tenant: TenantContext, path: DeskPath, version: number): Promise<FileRead> {
  return deskFileStore().readVersion(tenant, path, version);
}

export function revertTo(
  tenant: TenantContext,
  path: DeskPath,
  version: number,
  author: FileAuthor,
): Promise<WriteOutcome> {
  return deskFileStore().revertTo(tenant, path, version, author);
}

/** Delete a desk's files, versions and objects. Wire it into desk deletion, before the desk row goes. */
export function purgeDeskFiles(tenant: TenantContext): Promise<{ files: number; objects: number }> {
  return deskFileStore().purgeDesk(tenant);
}
