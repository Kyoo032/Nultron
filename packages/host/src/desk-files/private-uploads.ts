/**
 * Which desk files a person may see: `uploads/~<them>/` is theirs alone on the hosted server.
 *
 * A document attached in Chat is private to the person who attached it (owner's decision, 2026-10-06:
 * even on Enterprise each person's knowledge is their own). Its text is saved under
 * `uploads/~<folder>/`, and in server mode every desk-file path treats another person's folder as not
 * found: the file tools and `run_code` inputs (both read the desk root), the list and glob, search, the
 * Files view routes and the version routes. The rule lives here, in the host, next to the store, and
 * never in the renderer.
 *
 * The folder name carries a tilde because a tilde marks a folder as private by its name alone: the rule
 * needs no lookup of who the other people on the desk are. Any `uploads/~...` folder is private, and it
 * is visible only to the person whose own folder name it is, so a person cannot read, write or create a
 * folder with someone else's name.
 *
 * On a desk (Personal) there is one person, so nothing is guarded and nothing changes. A caller with no
 * user id (a background run) sees none of these folders on the hosted server.
 */
import { createHash } from "node:crypto";
import { type EnvLike, isServerMode } from "@agentforge/core";
import { CHAT_DOCUMENT_DESK_DIR } from "@agentforge/core/chat-documents";

/** The mark that makes a folder under `uploads/` private. */
export const PRIVATE_FOLDER_MARK = "~";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The private folder name for a user id: the id itself when it is a safe token, else a hash of it. */
export function privateFolderFor(userId: string): string {
  const id = SAFE_ID.test(userId) ? userId : `h-${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
  return `${PRIVATE_FOLDER_MARK}${id}`;
}

/** The private folder a desk path sits in (`~name`), or null when it is not under one. */
export function privateFolderOf(path: string): string | null {
  const parts = path.split("/");
  const folder = parts[1];
  return parts.length >= 2 && parts[0] === CHAT_DOCUMENT_DESK_DIR && folder?.startsWith(PRIVATE_FOLDER_MARK)
    ? folder
    : null;
}

/** Whether the caller may see `path`. Everything is visible off server mode. */
export function canSeePath(
  caller: { readonly userId?: string },
  path: string,
  serverMode: boolean | EnvLike = isServerMode(),
): boolean {
  const guarded = typeof serverMode === "boolean" ? serverMode : isServerMode(serverMode);
  if (!guarded) {
    return true;
  }
  const folder = privateFolderOf(path);
  if (folder === null) {
    return true;
  }
  return typeof caller.userId === "string" && caller.userId !== "" && folder === privateFolderFor(caller.userId);
}
