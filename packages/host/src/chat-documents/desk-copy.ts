/**
 * The document's text as a desk file, so Chat's file tools and `run_code` can work on it.
 *
 * This is the desk's own write path, unchanged: `createDeskRoot(...).write` does the versioning (the
 * same bytes again is the same version), the 2 MB file limit, the 2000-file ceiling and, on the
 * hosted server, the tenant's storage quota. Nothing is written outside it, and the path always
 * lands under `uploads/` (`desk-name.ts`). A refusal never fails the attachment: the caller gets a
 * fixed code and the person is told why the file was not saved.
 */
import type { TenantContext } from "@agentforge/core";
import { FileRootError, MAX_FILE_BYTES } from "@agentforge/core/tools/files";
import { createDeskRoot } from "../desk-files/store";
import { log } from "../log";
import { deskPathForDocument } from "./desk-name";
import type { SaveFailure } from "./notes";
import { fitUtf8Bytes } from "./text";

export type DeskCopy =
  | { readonly ok: true; readonly path: string; readonly version: number; readonly partial: boolean }
  | { readonly ok: false; readonly error: SaveFailure };

const FAILURE_BY_CODE: Readonly<Record<string, SaveFailure>> = {
  quota: "quota",
  too_large: "too_large",
  too_many_files: "too_many_files",
  denied: "denied",
};

function failureOf(error: unknown): SaveFailure {
  if (error instanceof FileRootError) {
    return FAILURE_BY_CODE[error.code] ?? "unavailable";
  }
  // The detail can quote a path, so only the fact that it failed is logged.
  log.warn("chat_document_desk_copy_failed", { kind: error instanceof Error ? error.name : typeof error });
  return "unavailable";
}

/** Save `text` for the person who attached `filename`. Never throws. */
export async function saveDeskCopy(tenant: TenantContext, filename: string, text: string): Promise<DeskCopy> {
  try {
    const fitted = fitUtf8Bytes(text, MAX_FILE_BYTES);
    const root = createDeskRoot(tenant, { kind: "user", userId: tenant.userId });
    const outcome = await root.write(deskPathForDocument(filename, tenant.userId), fitted.text, {
      kind: "user",
      userId: tenant.userId,
    });
    if (outcome.status !== "saved") {
      return { ok: false, error: "unavailable" };
    }
    return { ok: true, path: outcome.path, version: outcome.version, partial: fitted.cut };
  } catch (error) {
    return { ok: false, error: failureOf(error) };
  }
}
