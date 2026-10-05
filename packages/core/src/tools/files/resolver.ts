import type { TenantContext } from "../../tenancy/types";
import { fileRefusal } from "./refusals";
import type { FileAuthor, FileRefusal, FileRoot, FileRootKind } from "./types";

export type ResolvedFileRoot = { readonly root: FileRoot; readonly author: FileAuthor };

/**
 * Host-registered seam, like `setEditToolBackend`. The host knows the run id and the mode, so it
 * builds the author, and it knows whether a folder is open on this desk. It answers a refusal
 * (usually `root_unavailable`) for a root the run cannot use.
 */
export type FileRootResolver = (tenant: TenantContext, kind: FileRootKind) => Promise<ResolvedFileRoot | FileRefusal>;

let resolver: FileRootResolver | null = null;

export function setFileRootResolver(next: FileRootResolver | null): void {
  resolver = next;
}

export function getFileRootResolver(): FileRootResolver | null {
  return resolver;
}

export async function resolveFileRoot(
  tenant: TenantContext,
  kind: FileRootKind,
): Promise<ResolvedFileRoot | FileRefusal> {
  if (!resolver) {
    return fileRefusal("root_unavailable", "File tools are not available in this run.");
  }
  return resolver(tenant, kind);
}
