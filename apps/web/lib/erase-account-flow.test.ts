/**
 * The hosted "Erase company account" flow, as a state machine (owner decision 2026-10-01, SR-65).
 *
 * The owner asked for a bright red button that has to be clicked twice with something typed in between,
 * so nobody deletes a company by accident. The two clicks and the phrase are the whole safety, so they
 * are held here, in a reducer with no React in it, where "can the final step happen without them?" is
 * a question a test can answer. The component is a thin renderer of this state.
 */
import { describe, expect, it } from "vitest";
import {
  ERASE_ACCOUNT_IDLE,
  canSubmitErase,
  eraseAccountReducer,
  eraseFailureReasonOf,
  isErasePanelOpen,
  type EraseAccountState,
} from "./erase-account-flow";
import { ERASE_ACCOUNT_CONFIRM_WORD } from "./reset-app";

function run(...events: Parameters<typeof eraseAccountReducer>[1][]): EraseAccountState {
  return events.reduce(eraseAccountReducer, ERASE_ACCOUNT_IDLE);
}

describe("the phrase", () => {
  it("is DELETE, and not the desk's RESET", () => {
    expect(ERASE_ACCOUNT_CONFIRM_WORD).toBe("DELETE");
  });
});

describe("two deliberate clicks", () => {
  it("starts closed, and the first click only opens the confirmation", () => {
    expect(isErasePanelOpen(ERASE_ACCOUNT_IDLE)).toBe(false);
    const opened = run({ type: "open" });
    expect(isErasePanelOpen(opened)).toBe(true);
    expect(opened.step).toBe("confirming");
    // Opening does not erase anything and does not enable the final step.
    expect(canSubmitErase(opened)).toBe(false);
  });

  it("cannot submit without opening the panel first", () => {
    const state = run({ type: "type", text: ERASE_ACCOUNT_CONFIRM_WORD }, { type: "submit" });
    expect(state).toBe(ERASE_ACCOUNT_IDLE);
    expect(state.step).toBe("idle");
  });

  it("cannot submit with nothing typed, or with the wrong thing typed", () => {
    for (const text of ["", "yes", "RESET", "delete", "Delete", "DELETE everything", "DELET"]) {
      const state = run({ type: "open" }, { type: "type", text }, { type: "submit" });
      expect(state.step, text).toBe("confirming");
      expect(canSubmitErase(state), text).toBe(false);
    }
  });

  it("submits only with the exact phrase: the second click", () => {
    const ready = run({ type: "open" }, { type: "type", text: "DELETE" });
    expect(canSubmitErase(ready)).toBe(true);
    const submitted = eraseAccountReducer(ready, { type: "submit" });
    expect(submitted.step).toBe("erasing");
  });

  it("ignores spaces around the phrase, because that is what is sent", () => {
    // The client trims before it sends, so the host compares exactly `DELETE`.
    const ready = run({ type: "open" }, { type: "type", text: "  DELETE " });
    expect(canSubmitErase(ready)).toBe(true);
  });

  it("goes back to disabled when the phrase is edited away", () => {
    const edited = run({ type: "open" }, { type: "type", text: "DELETE" }, { type: "type", text: "DELET" });
    expect(canSubmitErase(edited)).toBe(false);
  });

  it("does not submit twice while an erase is in flight", () => {
    const erasing = run({ type: "open" }, { type: "type", text: "DELETE" }, { type: "submit" });
    expect(canSubmitErase(erasing)).toBe(false);
    expect(eraseAccountReducer(erasing, { type: "submit" })).toBe(erasing);
  });
});

describe("cancel", () => {
  it("closes the panel and forgets what was typed", () => {
    const cancelled = run({ type: "open" }, { type: "type", text: "DELETE" }, { type: "cancel" });
    expect(cancelled).toEqual(ERASE_ACCOUNT_IDLE);
    // And opening again starts empty: a phrase typed once is never left armed.
    const reopened = eraseAccountReducer(cancelled, { type: "open" });
    expect(canSubmitErase(reopened)).toBe(false);
  });

  it("cannot call off an erase that is already running", () => {
    const erasing = run({ type: "open" }, { type: "type", text: "DELETE" }, { type: "submit" });
    expect(eraseAccountReducer(erasing, { type: "cancel" })).toBe(erasing);
  });
});

describe("the answer", () => {
  const erasing = run({ type: "open" }, { type: "type", text: "DELETE" }, { type: "submit" });

  it("is done on success, with the panel closed", () => {
    const done = eraseAccountReducer(erasing, { type: "succeeded" });
    expect(done.step).toBe("done");
    expect(isErasePanelOpen(done)).toBe(false);
    expect(canSubmitErase(done)).toBe(false);
  });

  it("keeps the panel and the phrase open on a refusal, with the reason, so it can be read and retried", () => {
    const failed = eraseAccountReducer(erasing, { type: "failed", reason: "forbidden" });
    expect(failed.step).toBe("failed");
    expect(isErasePanelOpen(failed)).toBe(true);
    expect(failed).toMatchObject({ reason: "forbidden", typed: "DELETE" });
    // Retrying is the same second click; nothing else has to be repeated.
    expect(canSubmitErase(failed)).toBe(true);
  });

  it("clears the reason as soon as the person edits the phrase", () => {
    const failed = eraseAccountReducer(erasing, { type: "failed", reason: "generic" });
    const edited = eraseAccountReducer(failed, { type: "type", text: "DELET" });
    expect(edited.step).toBe("confirming");
    expect(edited).not.toHaveProperty("reason");
  });

  it("ignores an answer nobody asked for", () => {
    expect(eraseAccountReducer(ERASE_ACCOUNT_IDLE, { type: "succeeded" })).toBe(ERASE_ACCOUNT_IDLE);
    expect(eraseAccountReducer(ERASE_ACCOUNT_IDLE, { type: "failed", reason: "generic" })).toBe(ERASE_ACCOUNT_IDLE);
  });
});

describe("which host refusals have words of their own", () => {
  it("maps the two codes the screen explains, and everything else to the generic line", () => {
    expect(eraseFailureReasonOf("tenant_reset_forbidden")).toBe("forbidden");
    // SR-163: a server that holds several companies under one account refuses the erase.
    expect(eraseFailureReasonOf("tenant_erase_shared_partner")).toBe("shared");
    expect(eraseFailureReasonOf("invalid_request")).toBe("generic");
    expect(eraseFailureReasonOf(undefined)).toBe("generic");
  });

  it("keeps the panel open on a shared-account refusal, so the sentence can be read", () => {
    const erasing = run({ type: "open" }, { type: "type", text: ERASE_ACCOUNT_CONFIRM_WORD }, { type: "submit" });
    const failed = eraseAccountReducer(erasing, { type: "failed", reason: "shared" });
    expect(failed).toMatchObject({ step: "failed", reason: "shared", typed: "DELETE" });
    expect(isErasePanelOpen(failed)).toBe(true);
  });
});
