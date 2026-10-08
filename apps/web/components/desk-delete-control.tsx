"use client";

import { useMayDeleteDesk } from "@/lib/desk-delete-access";
import { t } from "@/lib/i18n";

/** The code the host answers to a person who may not delete a desk (`handlers/workspaces.ts`). */
export const WORKSPACE_DELETE_FORBIDDEN_CODE = "workspace_delete_forbidden";

type DeletableDesk = { slug: string; protected?: boolean };

/**
 * The row's Delete button, for the people the host will accept it from. The Default desk never has one;
 * on the hosted app neither does a member (`DeskDeleteNote` says why, once, above the list). Off the
 * hosted app it is the button the page always had.
 */
export function DeskDeleteButton({ workspace, onOpen }: { workspace: DeletableDesk; onOpen: () => void }) {
  const mayDelete = useMayDeleteDesk();
  if (workspace.protected || workspace.slug === "home" || !mayDelete) {
    return null;
  }
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-sm text-[var(--danger)] underline"
      onClick={onOpen}
      data-testid="delete-workspace"
    >
      {t("workspaces.delete")}
    </button>
  );
}

/** One line above the desk list, for a person who has no Delete button because of their role. */
export function DeskDeleteNote() {
  const mayDelete = useMayDeleteDesk();
  if (mayDelete) {
    return null;
  }
  return (
    <p className="mt-3 text-sm text-[var(--text-3)]" data-testid="workspaces-delete-restricted">
      {t("workspaces.deleteRestricted")}
    </p>
  );
}

/**
 * The words for a refused delete. The host's refusal for a role is English; the screen words it in the
 * person's language from the catalog, and keeps the host's own text for every other refusal.
 */
export function deskDeleteErrorMessage(error: { code?: string; message?: string }): string {
  if (error.code === WORKSPACE_DELETE_FORBIDDEN_CODE) {
    return t("workspaces.errors.deleteForbidden");
  }
  return error.message ?? t("workspaces.errors.delete");
}
