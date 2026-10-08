"use client";

import { useCallback, useEffect, useRef } from "react";
import { ChatDocumentError, type DocumentRead, pendingDocumentIds, readChatDocument } from "./composer-documents";

type Held = { readonly id: string; readonly kind: string; readonly file: File; readonly read?: DocumentRead };

/**
 * Starts the host read for every attached document that has none, and reports each answer through
 * `report(id, read)`. A document is read once: the ids in flight are remembered so a re-render, or a
 * second effect run in development, cannot send the same file twice. A document that is removed
 * before its answer arrives is simply not found by `report`, which is the caller's own state update.
 *
 * `retry(id)` clears a failed read so the effect starts it again.
 */
export function useDocumentReads(
  files: ReadonlyArray<Held>,
  report: (id: string, read: DocumentRead | undefined) => void,
): { retry: (id: string) => void } {
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    for (const id of pendingDocumentIds(files, inFlight.current)) {
      const held = files.find((item) => item.id === id);
      if (!held) {
        continue;
      }
      inFlight.current.add(id);
      report(id, { status: "reading" });
      readChatDocument(held.file).then(
        (result) => {
          report(id, { status: "ready", result });
          inFlight.current.delete(id);
        },
        (error: unknown) => {
          report(id, { status: "failed", error: error instanceof ChatDocumentError ? error.key : "failed" });
          inFlight.current.delete(id);
        },
      );
    }
  }, [files, report]);

  const retry = useCallback((id: string) => report(id, undefined), [report]);
  return { retry };
}
