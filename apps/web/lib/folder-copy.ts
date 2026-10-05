/**
 * Words for the folder surface, chosen from state. Every sentence is a `folder.*` catalog key in
 * both languages; the host sends codes, never copy, so nothing a person reads comes from the wire.
 */
import type { FolderErrorCode, ProposalKind } from "./folder-api";
import { t } from "./i18n";
import type { Outcome } from "./folder-state";

/** Codes with a sentence of their own. Every other code reads as the generic one. */
const ERROR_KEYS: Readonly<Partial<Record<FolderErrorCode, string>>> = {
  folder_unavailable: "folder.error.folder_unavailable",
  folder_mount_ipc_only: "folder.error.folder_mount_ipc_only",
  folder_mount_refused: "folder.error.folder_mount_refused",
  folder_not_mounted: "folder.error.folder_not_mounted",
  network: "folder.error.network",
  noPicker: "folder.error.noPicker",
};

export function folderErrorText(code: FolderErrorCode): string {
  return t(ERROR_KEYS[code] ?? "folder.error.generic");
}

export type OutcomeTone = "good" | "warn" | "neutral";

/** What to say about a decision, and how loudly: applied is good, a refusal is a warning. */
export function outcomeView(
  outcome: Outcome,
  kind: ProposalKind,
): { readonly text: string; readonly tone: OutcomeTone } {
  switch (outcome.tag) {
    case "applied":
      return { text: t(kind === "delete" ? "folder.outcome.appliedDelete" : "folder.outcome.applied"), tone: "good" };
    case "stale":
      return { text: t("folder.outcome.stale"), tone: "warn" };
    case "failed":
      return {
        text: t(outcome.reason === "denied" ? "folder.outcome.failedDenied" : "folder.outcome.failedIo"),
        tone: "warn",
      };
    case "rejected":
      return { text: t("folder.outcome.rejected"), tone: "neutral" };
    case "gone":
      return { text: t("folder.outcome.gone"), tone: "neutral" };
  }
}
