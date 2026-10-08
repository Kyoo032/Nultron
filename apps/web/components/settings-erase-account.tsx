"use client";

import { useEffect, useId, useReducer, useRef, type KeyboardEvent, type Ref } from "react";
import { requestSignOut, signOutAndLeave } from "@/components/account-session-row";
import { resetApp } from "@/lib/api-client";
import {
  ERASE_ACCOUNT_IDLE,
  canSubmitErase,
  eraseAccountReducer,
  eraseFailureReasonOf,
  isErasePanelOpen,
  typedPhrase,
  type EraseFailureReason,
} from "@/lib/erase-account-flow";
import { t } from "@/lib/i18n";
import { ERASE_ACCOUNT_CONFIRM_WORD, eraseAccountPhraseMatches } from "@/lib/reset-app";

/**
 * Erase company account — the hosted account erase, behind two deliberate clicks and a typed phrase.
 *
 * Owner decision 2026-10-01 (SR-65): erasing the company account deletes every person in it and signs
 * them all out, so this is a bright red button that opens a confirmation, and the confirmation has its
 * own red button that stays disabled until the owner has typed the exact phrase. Nothing here decides
 * anything: the rules are the reducer's (`lib/erase-account-flow.ts`) and the host compares the typed
 * word again and answers a wrong one with a 400. The host also refuses anyone who is not an owner.
 *
 * It is deliberately NOT inside the collapsed "Sign out and delete" disclosure of the card around it:
 * a red button nobody can see is not a warning, and the two clicks are the protection against a stray
 * one. It is rendered only where the host's `tenantReset` capability is true.
 *
 * After the host answers, the browser is already signed out (its session row was deleted with the
 * rest), so the screen leaves through the ordinary sign-out (`signOutAndLeave`): that clears the dead
 * cookie and follows the portal's own logout, so the portal's browser session does not sign the next
 * person straight back in (SR-21).
 */

const zoneClass = "space-y-3 border-t border-[var(--line)] pt-4";
const openButtonClass =
  "inline-flex items-center gap-2 rounded-md bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-[var(--surface)] shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--danger)]";
const submitButtonClass =
  "inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--danger)] px-2 py-2 text-center text-sm font-semibold text-[var(--surface)] shadow-sm transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40 [@container(min-width:22rem)]:w-auto [@container(min-width:22rem)]:px-4";
const cancelButtonClass = "rounded-md px-3 py-2 text-center text-sm text-[var(--text-2)] underline disabled:opacity-50";
const panelClass =
  "space-y-3 rounded-md border-2 border-[var(--danger)] bg-[var(--danger)]/5 p-3 min-[480px]:p-4 [container-type:inline-size]";
/**
 * The button row answers to the panel's own width: narrow, the final button is full width under the
 * phrase box and Cancel sits below it; from 22rem up they share a row, as they always did.
 */
const buttonRowClass =
  "flex flex-col gap-2 [@container(min-width:22rem)]:flex-row [@container(min-width:22rem)]:flex-wrap [@container(min-width:22rem)]:items-center [@container(min-width:22rem)]:gap-3";

/** A warning triangle. Decorative: the words beside it carry the meaning, so a screen reader skips it. */
function WarningMark({ className = "shrink-0" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="currentColor"
      className={className}
    >
      <path d="M10 2.2a1.4 1.4 0 0 1 1.2.7l7 12.1a1.4 1.4 0 0 1-1.2 2.1H3a1.4 1.4 0 0 1-1.2-2.1l7-12.1A1.4 1.4 0 0 1 10 2.2Zm-.9 5.3v4.2a.9.9 0 0 0 1.8 0V7.5a.9.9 0 0 0-1.8 0Zm.9 6.1a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1Z" />
    </svg>
  );
}

export type EraseAccountPanelIds = {
  readonly title: string;
  readonly warning: string;
  readonly people: string;
  readonly instruction: string;
  readonly input: string;
};

export type EraseAccountPanelProps = {
  readonly typed: string;
  /** An erase is running: nothing in the panel may be pressed. */
  readonly busy: boolean;
  /** Why the host said no, when it did. */
  readonly reason: EraseFailureReason | null;
  readonly ids: EraseAccountPanelIds;
  readonly onType: (text: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly inputRef?: Ref<HTMLInputElement>;
};

/**
 * The confirmation, as a pure function of its props so it can be rendered and read in a test.
 *
 * An alert dialog, labelled by its title and described by the two warning paragraphs, so a screen
 * reader says what is about to happen when focus lands in it. It is not modal: the rest of the page
 * stays where it is, and Escape or the Cancel button closes it.
 */
export function EraseAccountPanel({
  typed,
  busy,
  reason,
  ids,
  onType,
  onSubmit,
  onCancel,
  inputRef,
}: EraseAccountPanelProps) {
  const matches = eraseAccountPhraseMatches(typed);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby={ids.title}
      aria-describedby={`${ids.warning} ${ids.people}`}
      className={panelClass}
      data-testid="settings-reset-tenant-confirm"
      onKeyDown={onKeyDown}
    >
      <h3 id={ids.title} className="text-base font-semibold text-[var(--danger)]">
        {t("settings.reset.eraseAccountPanelTitle")}
      </h3>
      <p id={ids.warning} className="text-sm text-[var(--text)]" data-testid="settings-reset-tenant-warning">
        {t("settings.reset.eraseAccountWarning")}
      </p>
      <p id={ids.people} className="text-sm font-medium text-[var(--text)]">
        {t("settings.reset.eraseAccountWarningPeople")} {t("settings.reset.eraseAccountWarningFinal")}
      </p>
      <p className="text-xs text-[var(--text-2)]">{t("settings.reset.eraseAccountContract")}</p>

      <div className="space-y-1">
        <label htmlFor={ids.input} className="block text-sm font-medium text-[var(--text)]">
          {t("settings.reset.eraseAccountInputLabel", { phrase: ERASE_ACCOUNT_CONFIRM_WORD })}
        </label>
        <p id={ids.instruction} className="text-xs text-[var(--text-2)]">
          {t("settings.reset.eraseAccountTypeToConfirm", { phrase: ERASE_ACCOUNT_CONFIRM_WORD })}
        </p>
        <input
          ref={inputRef}
          id={ids.input}
          aria-describedby={ids.instruction}
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          value={typed}
          onChange={(event) => onType(event.target.value)}
          placeholder={ERASE_ACCOUNT_CONFIRM_WORD}
          data-testid="settings-reset-tenant-confirm-name"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>

      {reason ? (
        <p role="alert" className="text-sm text-[var(--danger)]" data-testid="settings-reset-error">
          {reason === "forbidden"
            ? t("settings.reset.eraseAccountForbidden")
            : reason === "shared"
              ? t("settings.reset.eraseAccountShared")
              : t("settings.reset.failed")}
        </p>
      ) : null}

      <div className={buttonRowClass}>
        <button
          type="button"
          className={submitButtonClass}
          data-testid="settings-reset-tenant-submit"
          disabled={busy || !matches}
          onClick={onSubmit}
        >
          <WarningMark className="hidden shrink-0 [@container(min-width:22rem)]:block" />
          {busy ? t("settings.reset.eraseAccountWorking") : t("settings.reset.eraseAccountSubmit")}
        </button>
        <button
          type="button"
          className={cancelButtonClass}
          data-testid="settings-reset-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {t("settings.reset.cancel")}
        </button>
      </div>
    </div>
  );
}

export function SettingsEraseAccount() {
  const [state, dispatch] = useReducer(eraseAccountReducer, ERASE_ACCOUNT_IDLE);
  const base = useId();
  const ids: EraseAccountPanelIds = {
    title: `${base}-title`,
    warning: `${base}-warning`,
    people: `${base}-people`,
    instruction: `${base}-instruction`,
    input: `${base}-input`,
  };
  const panelOpen = isErasePanelOpen(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus follows the panel: into the phrase box when it opens, back to the red button when it is
  // cancelled, so a keyboard or screen-reader user is never left on something that has disappeared.
  useEffect(() => {
    if (panelOpen && !wasOpen.current) {
      inputRef.current?.focus();
    }
    if (!panelOpen && wasOpen.current && state.step === "idle") {
      triggerRef.current?.focus();
    }
    wasOpen.current = panelOpen;
  }, [panelOpen, state.step]);

  async function onSubmit() {
    if (!canSubmitErase(state)) {
      return;
    }
    // What the owner actually typed, trimmed as the box's enable check trims it: the host compares it,
    // and sending a constant would let a mismatched box through on the renderer's say-so.
    const typed = typedPhrase(state).trim();
    dispatch({ type: "submit" });
    try {
      const result = await resetApp("tenant", typed);
      if (!result.ok) {
        dispatch({
          type: "failed",
          reason: eraseFailureReasonOf(result.code),
        });
        return;
      }
      dispatch({ type: "succeeded" });
    } catch {
      dispatch({ type: "failed", reason: "generic" });
      return;
    }
    // The company, its people and every session are gone, this browser's included. Leave through the
    // ordinary sign-out: it clears the dead cookie and takes the portal hop.
    await signOutAndLeave(requestSignOut, (url) => window.location.replace(url));
  }

  return (
    <div className={zoneClass} data-testid="settings-reset-tenant-zone">
      <div className="space-y-1">
        <p className="text-sm font-medium text-[var(--text)]">{t("settings.reset.eraseAccount")}</p>
        <p className="text-xs text-[var(--text-3)]">{t("settings.reset.eraseAccountHelp")}</p>
      </div>

      {panelOpen ? (
        <EraseAccountPanel
          typed={typedPhrase(state)}
          busy={state.step === "erasing"}
          reason={state.step === "failed" ? state.reason : null}
          ids={ids}
          inputRef={inputRef}
          onType={(text) => dispatch({ type: "type", text })}
          onSubmit={() => void onSubmit()}
          onCancel={() => dispatch({ type: "cancel" })}
        />
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={openButtonClass}
          data-testid="settings-reset-tenant"
          aria-expanded="false"
          disabled={state.step === "done"}
          onClick={() => dispatch({ type: "open" })}
        >
          <WarningMark />
          {t("settings.reset.eraseAccountOpen")}
        </button>
      )}

      {state.step === "done" ? (
        <p role="status" className="text-sm text-[var(--text-2)]" data-testid="settings-reset-erased">
          {t("settings.reset.eraseAccountDone")}
        </p>
      ) : null}
    </div>
  );
}
