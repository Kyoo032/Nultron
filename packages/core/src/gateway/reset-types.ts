/**
 * Shared host/renderer contract for "Start over".
 *
 * The confirmation word is deliberately not localized: it is a safety latch, not copy. The host
 * (`handlers/settings.ts`) and the renderer (`apps/web/lib/reset-app.ts`) must agree on it exactly,
 * so it lives here rather than being spelled twice.
 */
export const RESET_CONFIRM_WORD = "RESET";

/**
 * The phrase an owner types to erase a whole hosted company account (`scope: "tenant"`).
 *
 * A different word from `RESET_CONFIRM_WORD` on purpose (owner decision 2026-10-01, SR-65): the desk's
 * "Start over" wipes one machine, while this deletes every person in the company and signs them all
 * out, and a client that still sends the old word must be refused rather than allowed through. It is
 * a fixed word and not the company's name because the host does not hold a reliable name: the portal
 * sends ids, and the org row's `name` is the org id (`packages/db/src/portal-owner.ts`). Never
 * translated; the renderer keeps a copy in `apps/web/lib/reset-app.ts` for the same reason
 * `RESET_CONFIRM_WORD` does, and `reset-app.test.ts` holds the two together.
 */
export const TENANT_ERASE_CONFIRM_WORD = "DELETE";

export type ResetScope = "key" | "all";
