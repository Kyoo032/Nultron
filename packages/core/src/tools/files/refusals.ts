import type { FileRefusal, FileRefusalCode } from "./types";

export function fileRefusal(code: FileRefusalCode, message: string): FileRefusal {
  return { ok: false, code, message };
}

export function isFileRefusal(value: unknown): value is FileRefusal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.ok === false && typeof record.code === "string" && typeof record.message === "string";
}

/**
 * How a `FileRoot` refuses: its methods return only success shapes, so a root throws this and the
 * tool boundary turns it into a `FileRefusal`. The message reaches the model, so it must name no
 * host path.
 */
export class FileRootError extends Error {
  readonly code: FileRefusalCode;

  constructor(code: FileRefusalCode, message: string) {
    super(message);
    this.name = "FileRootError";
    this.code = code;
  }
}

/**
 * Anything a root throws that is not a `FileRootError` is a host bug or an OS error whose text can
 * carry an absolute path. It is logged for the operator and the model gets a fixed sentence.
 */
export function toFileRefusal(error: unknown): FileRefusal {
  if (error instanceof FileRootError) {
    return fileRefusal(error.code, error.message);
  }
  console.warn("file tool: the file root failed", error);
  return fileRefusal("root_unavailable", "The file store could not complete this request. Try again later.");
}
