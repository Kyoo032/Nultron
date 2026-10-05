import { noteGatewayBlocked } from "./gate-state";
import { parseGatewayBlocked, type GatewayBlocked } from "./gateway-gate";
import { isHostedBuild } from "./hosted-build";
import { t } from "./i18n";

/**
 * `403 gateway_blocked` on the hosted app: a tenant with no usable gateway key pressed something that
 * calls a model. The host refused, as it must (`requireGatewayAllowed`), and this is the renderer's
 * half: say so calmly and point at Settings, instead of the generic failure every studio would
 * otherwise print ("Request failed", "Could not generate").
 *
 * **Hosted only.** On the Personal app a closed gate is onboarding's key step and no studio is
 * mounted behind it, so nothing here fires; and where it could (a verdict that expired while a desk
 * was open) the Personal app keeps the generic error it has always shown. Every reader below answers
 * "nothing" off the hosted build, which is what keeps every Personal path as it was.
 */

/** The flat 403 body → a typed block, on the hosted build only. Anything else, or anywhere else, is `null`. */
export function hostedGatewayBlocked(body: unknown): GatewayBlocked | null {
  return isHostedBuild() ? parseGatewayBlocked(body) : null;
}

/**
 * One plain sentence for an error banner or an error object's `message`: catalog copy, in the desk's
 * language, naming Settings. Never the host's own English `message`, which can say where a key lives
 * and is for the log. Studios that can draw a link render `NeedsKeyNote` instead of this text.
 */
export function gatewayBlockedMessage(): string {
  return t("common.needsKey.blocked", { settings: t("rail.settings") });
}

/**
 * Is this banner text the refused-for-no-key sentence? A studio hides exactly that banner, because its
 * `NeedsKeyNote` already says it with a link, and shows every other error as it always did: an
 * upload that failed, a gallery that did not load and a file that was too big are not about the key.
 */
export function isGatewayBlockedText(text: string | null | undefined): boolean {
  return Boolean(text) && text === gatewayBlockedMessage();
}

/** `otherwise()` unless the body is a hosted `403 gateway_blocked`, which reads as the catalog sentence. */
export function messageUnlessBlocked(body: unknown, otherwise: () => string): string {
  return hostedGatewayBlocked(body) ? gatewayBlockedMessage() : otherwise();
}

/** The shortest gap between two re-reads of the host's gate after a refusal. */
export const RECONCILE_MIN_GAP_MS = 10_000;

let lastReconcileAt = 0;

/**
 * A refusal is a local flag; the host's own gate is the truth. Ask for it again (throttled), so a
 * refusal that came from a verdict that has since recovered cannot leave every pane quiet until the
 * person happens to visit Settings. The read publishes the host's gate (`settings-read.ts`), and an
 * open gate clears the flag. Loaded lazily: `settings-read` imports `api-client`, which imports this.
 */
function reconcileGate(now: number = Date.now()): void {
  if (now - lastReconcileAt < RECONCILE_MIN_GAP_MS) {
    return;
  }
  lastReconcileAt = now;
  void import("./settings-read")
    .then((module) => module.readSettings({ fresh: true }))
    .catch(() => {
      // The host could not be asked; the flag stays until a later read answers.
    });
}

/** Test seam. */
export function resetGatewayBlockedForTests(): void {
  lastReconcileAt = 0;
}

/**
 * Every `403 gateway_blocked`, from every call, noted once — shaped exactly like `notePlanResponse`
 * (`plan-block.ts`) and called beside it in the one place every HTTP answer passes through:
 *
 * - **A clone, always.** The caller's body is untouched and still unread.
 * - **Nothing at all off a 403, or off the hosted build.** No clone, no read, no promise.
 * - **Silent for every other 403.** A plan refusal belongs to `plan-block`, a session to `session-signal`.
 */
export function noteGatewayResponse(response: Response): void {
  if (response.status !== 403 || typeof response.clone !== "function" || !isHostedBuild()) {
    return;
  }
  void response
    .clone()
    .json()
    .then((body: unknown) => {
      if (parseGatewayBlocked(body)) {
        noteGatewayBlocked();
        reconcileGate();
      }
    })
    .catch(() => {
      // A refusal with no readable body says nothing about the key; leave the desk as it is.
    });
}
