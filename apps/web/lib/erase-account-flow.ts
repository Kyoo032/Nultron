/**
 * The hosted "Erase company account" flow, as a state machine with no React in it.
 *
 * Owner decision 2026-10-01 (SR-65): erasing the company account deletes every person in it and signs
 * everyone out, so it sits behind a bright red button that has to be clicked **twice**, with something
 * typed in between, so nobody does it by accident. The two clicks and the phrase are the whole safety,
 * so they live here, where a test can ask "can the final step happen without them?" and get a plain
 * answer. The component renders this state and dispatches into it; it decides nothing of its own.
 *
 *   idle ──open──▶ confirming ──type──▶ confirming (phrase matches → the final click is allowed)
 *                      │                      │
 *                   cancel                 submit
 *                      ▼                      ▼
 *                    idle                  erasing ──succeeded──▶ done
 *                                             └──────failed────▶ failed ──type──▶ confirming
 *
 * This is the renderer's courtesy. The host compares the typed word again and refuses a wrong one with
 * a 400 (`packages/host/src/tenant-reset.ts`), so a client that skips this file gets nothing from it.
 */
import { eraseAccountPhraseMatches } from "./reset-app";

/**
 * Why the host said no, as far as the screen has different words for it. `shared` is the hosted server
 * that holds several companies under one account and so refuses the erase (SR-163).
 */
export type EraseFailureReason = "forbidden" | "shared" | "generic";

/** The host's refusal code (`ResetResult.code`) as the reason the panel shows. Anything else is generic. */
export function eraseFailureReasonOf(code: string | undefined): EraseFailureReason {
  if (code === "tenant_reset_forbidden") {
    return "forbidden";
  }
  return code === "tenant_erase_shared_partner" ? "shared" : "generic";
}

export type EraseAccountState =
  | { readonly step: "idle" }
  | { readonly step: "confirming"; readonly typed: string }
  | { readonly step: "erasing"; readonly typed: string }
  | { readonly step: "failed"; readonly typed: string; readonly reason: EraseFailureReason }
  | { readonly step: "done" };

export type EraseAccountEvent =
  | { readonly type: "open" }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "cancel" }
  | { readonly type: "submit" }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly reason: EraseFailureReason };

export const ERASE_ACCOUNT_IDLE: EraseAccountState = Object.freeze({ step: "idle" });

/** Is the confirmation panel on screen? True through a refusal, so the reason is read where it was earned. */
export function isErasePanelOpen(state: EraseAccountState): boolean {
  return state.step === "confirming" || state.step === "erasing" || state.step === "failed";
}

/** What has been typed so far; empty when no panel is open. */
export function typedPhrase(state: EraseAccountState): string {
  return state.step === "confirming" || state.step === "erasing" || state.step === "failed" ? state.typed : "";
}

/** May the final click go through right now? Needs the panel open, the exact phrase, and nothing running. */
export function canSubmitErase(state: EraseAccountState): boolean {
  return (state.step === "confirming" || state.step === "failed") && eraseAccountPhraseMatches(state.typed);
}

/** Returns the same object when an event changes nothing, so a caller can compare by identity. */
export function eraseAccountReducer(state: EraseAccountState, event: EraseAccountEvent): EraseAccountState {
  switch (event.type) {
    case "open":
      return state.step === "idle" ? { step: "confirming", typed: "" } : state;
    case "type":
      // Editing after a refusal clears the reason: what was said no to is no longer what is typed.
      return state.step === "confirming" || state.step === "failed" ? { step: "confirming", typed: event.text } : state;
    case "cancel":
      // A running erase cannot be called off; it has already started deleting.
      return state.step === "confirming" || state.step === "failed" ? ERASE_ACCOUNT_IDLE : state;
    case "submit":
      return canSubmitErase(state) && (state.step === "confirming" || state.step === "failed")
        ? { step: "erasing", typed: state.typed }
        : state;
    case "succeeded":
      return state.step === "erasing" ? { step: "done" } : state;
    case "failed":
      return state.step === "erasing" ? { step: "failed", typed: state.typed, reason: event.reason } : state;
  }
}
