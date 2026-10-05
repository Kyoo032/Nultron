import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { FOLDER_TEXT_MAX_BYTES } from "./constants";
import { parseRelPath, resolveInside } from "./contain";
import { isFolderRefusal } from "./refusal";
import type { ProposalKind } from "./proposal-store";
import { readFileBytes, sha256Of } from "./text-file";
import { log } from "../log";

/** Why an approved change did not land. Fixed words; the OS error and the path stay in no message. */
export type ApplyFailure = "denied" | "io_error";

export type ApplyResult =
  | { readonly status: "applied" }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly reason: ApplyFailure };

export type ChangeToApply = {
  readonly path: string;
  readonly kind: ProposalKind;
  readonly beforeSha256: string | null;
  readonly afterBody: string | null;
};

type Current = { readonly exists: boolean; readonly sha256: string | null; readonly mode: number | null };

/** The file as it is now. A file too big to read cannot match a hash taken from a readable one. */
async function readCurrent(rootReal: string, segments: readonly string[]): Promise<Current> {
  const resolved = await resolveInside(rootReal, segments);
  if (!resolved.exists) {
    return { exists: false, sha256: null, mode: null };
  }
  const mode = (await stat(resolved.target)).mode & 0o777;
  try {
    return { exists: true, sha256: sha256Of(await readFileBytes(resolved.target)), mode };
  } catch (error) {
    if (isFolderRefusal(error) && error.code === "too_large") {
      return { exists: true, sha256: null, mode };
    }
    throw error;
  }
}

/** Temp file beside the target, flushed, then renamed over it: readers see the old file or the new one. */
async function writeAtomically(target: string, body: string, mode: number | null): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== null && process.platform !== "win32") {
      await chmod(temp, mode);
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function failed(reason: ApplyFailure, error: unknown): ApplyResult {
  log.warn("folder_proposal_apply_failed", {
    reason,
    code: isFolderRefusal(error) ? error.code : ((error as NodeJS.ErrnoException).code ?? "unknown"),
  });
  return { status: "failed", reason };
}

/**
 * Put an approved change on the disk, or say why not.
 *
 * The file is read again first. If its hash is not the one the proposal was made against (or, for a
 * new file, if something now exists there) nothing is written and the answer is `stale`: the owner
 * approved a diff against a file that has since changed. The path is resolved again too, and a
 * missing parent folder is created only after its nearest existing ancestor has been checked to be
 * inside the root.
 */
export async function applyChange(rootReal: string, change: ChangeToApply): Promise<ApplyResult> {
  try {
    const segments = parseRelPath(change.path);
    const current = await readCurrent(rootReal, segments);
    if (current.sha256 !== change.beforeSha256 || current.exists !== (change.beforeSha256 !== null)) {
      return { status: "stale" };
    }
    const resolved = await resolveInside(rootReal, segments);
    if (change.kind === "delete") {
      await unlink(resolved.target);
      return { status: "applied" };
    }
    if (change.afterBody === null || Buffer.byteLength(change.afterBody, "utf8") > FOLDER_TEXT_MAX_BYTES) {
      return failed("io_error", new Error("proposal has no usable body"));
    }
    await mkdir(path.dirname(resolved.target), { recursive: true });
    // The folders may have just been created; contain the final path once more before writing.
    const final = await resolveInside(rootReal, segments);
    await writeAtomically(final.target, change.afterBody, current.mode);
    return { status: "applied" };
  } catch (error) {
    return failed(isFolderRefusal(error) ? "denied" : "io_error", error);
  }
}
