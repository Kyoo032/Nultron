import type { TenantContext } from "../../tenancy/types";
import { MAX_FILE_BYTES, utf8ByteLength } from "./lines";
import { fileRefusal, isFileRefusal, toFileRefusal } from "./refusals";
import { type ResolvedFileRoot, resolveFileRoot } from "./resolver";
import type { DeskPath, FileRefusal, FileRootKind, WriteOutcome } from "./types";

export type SavedResult = {
  readonly ok: true;
  readonly root: FileRootKind;
  readonly status: "saved";
  readonly path: DeskPath;
  readonly version: number;
};

export type PendingResult = {
  readonly ok: true;
  readonly root: FileRootKind;
  readonly status: "pending_approval";
  readonly path: DeskPath;
  readonly proposalId: string;
  readonly message: string;
};

export const PENDING_APPROVAL_MESSAGE =
  "Not applied yet. The owner has to approve this change; until then the file on disk is unchanged. Tell the owner it is waiting and do not rely on it.";

/**
 * Resolve the root for this run, run the tool body, and turn anything the root throws into a
 * refusal. Tool bodies return success objects or refusals and never throw for a user error.
 */
export async function withRoot<T>(
  tenant: TenantContext,
  kind: FileRootKind | undefined,
  run: (resolved: ResolvedFileRoot) => Promise<T | FileRefusal>,
): Promise<T | FileRefusal> {
  try {
    const resolved = await resolveFileRoot(tenant, kind ?? "desk");
    if (isFileRefusal(resolved)) {
      return resolved;
    }
    return await run(resolved);
  } catch (error) {
    return toFileRefusal(error);
  }
}

export function writeResult(root: FileRootKind, outcome: WriteOutcome): SavedResult | PendingResult {
  if (outcome.status === "pending_approval") {
    return {
      ok: true,
      root,
      status: "pending_approval",
      path: outcome.path,
      proposalId: outcome.proposalId,
      message: PENDING_APPROVAL_MESSAGE,
    };
  }
  return { ok: true, root, status: "saved", path: outcome.path, version: outcome.version };
}

/** Null when `content` fits the per-file cap, measured in UTF-8 bytes. */
export function checkContentSize(content: string): FileRefusal | null {
  // A UTF-16 unit is at least one UTF-8 byte, so a longer string is over without counting.
  if (content.length > MAX_FILE_BYTES || utf8ByteLength(content) > MAX_FILE_BYTES) {
    return fileRefusal("too_large", "The content is larger than 2 MB. Write a shorter file, or split it into several.");
  }
  return null;
}
