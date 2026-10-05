import path from "node:path";
import { folderRootAvailable } from "./availability";
import { getMount } from "./mount-record";
import { checkMountPath } from "./mount-validate";
import { isSamePath } from "./path-compare";

export type OpenMount =
  | { readonly ok: true; readonly rootReal: string; readonly name: string }
  | { readonly ok: false };

/**
 * The desk's folder as it is right now, or `{ ok: false }`.
 *
 * The record holds the real path from the day the owner picked it. Every open checks the folder
 * against the mount rules again and insists it is still the same real path: a folder that was since
 * deleted, replaced by a link to somewhere else, or moved under a system directory stops being a
 * root instead of quietly becoming a different one.
 */
export async function openMount(workspaceId: string): Promise<OpenMount> {
  if (!folderRootAvailable()) {
    return { ok: false };
  }
  const mount = getMount(workspaceId);
  if (!mount) {
    return { ok: false };
  }
  const checked = await checkMountPath(mount.path);
  if (!checked.ok || !isSamePath(checked.real, mount.path)) {
    return { ok: false };
  }
  return { ok: true, rootReal: checked.real, name: path.basename(checked.real) };
}
