import type { FileRefusal, FileRefusalCode } from "@agentforge/core";
import { FileRootError } from "@agentforge/core/tools/files";

/**
 * Fixed words for each refusal. None of them carries a path, a name from the folder or an OS error
 * string: the model reads these, and the owner's disk layout is not the model's business.
 */
const MESSAGES: Readonly<Record<FileRefusalCode, string>> = {
  bad_path: "That path is not valid.",
  not_found: "That file does not exist in the folder.",
  too_large: "That file is too large to read as text.",
  too_many_files: "There are too many changes waiting for the owner. Wait for them to be reviewed first.",
  denied: "That file is not available to the agent.",
  no_match: "Nothing matched.",
  bad_pattern: "That pattern is not valid.",
  ambiguous_match: "More than one place matched.",
  root_unavailable: "No folder is open for this desk.",
  quota: "The storage limit was reached.",
  conflict: "The file changed after it was read. Read the file again and redo the edit.",
};

export function refusalOf(code: FileRefusalCode): FileRefusal {
  return { ok: false, code, message: MESSAGES[code] };
}

/**
 * How the folder root refuses. The contract (`@agentforge/core/tools/files`) types the methods as
 * returning values, so a refusal travels as core's own `FileRootError`: the tool boundary
 * (`toFileRefusal`) recognises that class and nothing else, and turns it back into
 * `{ ok: false, code, message }` for the model. Any other error becomes a generic
 * `root_unavailable` there.
 */
export function refuse(code: FileRefusalCode): never {
  throw new FileRootError(code, MESSAGES[code]);
}

export function isFolderRefusal(error: unknown): error is FileRootError {
  return error instanceof FileRootError;
}
