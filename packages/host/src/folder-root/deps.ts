import type { ProposalStore } from "./proposal-store";

/** What the folder root needs besides the disk. Tests hand in an in-memory store. */
export type FolderDeps = { readonly store: ProposalStore };

let cached: FolderDeps | null = null;

/**
 * The store bound to the app database and the local vault key, built on first use.
 *
 * The database is imported here, at call time, rather than at the top of the module: the path,
 * mount and containment code in this folder has no business opening SQLite, and a unit test of it
 * should not either.
 */
export async function defaultFolderDeps(): Promise<FolderDeps> {
  if (!cached) {
    const { sql } = await import("@agentforge/db");
    const { getLocalVaultKey } = await import("@agentforge/db/vault-key");
    const { createProposalStore } = await import("./proposal-store");
    cached = { store: createProposalStore(sql, getLocalVaultKey) };
  }
  return cached;
}
