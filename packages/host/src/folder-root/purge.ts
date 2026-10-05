import { defaultFolderDeps, type FolderDeps } from "./deps";

/**
 * Delete every folder proposal of a desk that is being deleted, and say how many went.
 *
 * A proposal holds a sealed copy of the text an agent wanted to write, and nothing in the app can
 * reach a deleted desk's proposals, so a row left behind is a body that stays on disk for ever. This
 * does not look at whether a folder root is available: the rows exist or they do not, and a desk
 * that never had a folder simply has none.
 */
export async function purgeFolderProposals(workspaceId: string, deps?: FolderDeps): Promise<number> {
  const { store } = deps ?? (await defaultFolderDeps());
  return store.purgeDesk(workspaceId);
}
