"use client";

import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import { type DocumentRead, discardChipOriginal } from "./composer-documents";

type Chip = { readonly id: string; readonly kind: string; readonly read?: DocumentRead };

/**
 * The composer's document chips, as far as the kept originals go.
 *
 * `reportRead` takes the host's read answer for a chip. A chip removed while its document was still
 * reading has no state left to report into, so its answer is where its original is deleted.
 * `removeChip` takes a chip out of the box at once, and deletes its original with it unless a send is in
 * flight: the message may already name that original. Reads themselves start in `use-document-reads`.
 */
export function useChipOriginals<T extends Chip>(
  files: ReadonlyArray<T>,
  setFiles: Dispatch<SetStateAction<T[]>>,
  busy: boolean,
) {
  const removedWhileReading = useRef(new Set<string>());

  const reportRead = useCallback(
    (id: string, read: DocumentRead | undefined) => {
      if (removedWhileReading.current.has(id)) {
        if (read?.status === "reading") {
          return;
        }
        removedWhileReading.current.delete(id);
        void discardChipOriginal(read, false);
        return;
      }
      setFiles((current) => current.map((item) => (item.id === id ? { ...item, read } : item)));
    },
    [setFiles],
  );

  const removeChip = useCallback(
    (id: string) => {
      const held = files.find((item) => item.id === id);
      setFiles((current) => current.filter((item) => item.id !== id));
      if (held?.kind !== "document") {
        return;
      }
      if (held.read?.status === "reading") {
        removedWhileReading.current.add(id);
      }
      void discardChipOriginal(held.read, busy);
    },
    [busy, files, setFiles],
  );

  return { reportRead, removeChip };
}
