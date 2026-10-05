import { isHostedBuild } from "./hosted-build";
import type { GatewayGatePayload } from "./gateway-gate";

/**
 * What the desk has been told about the gateway key, shared by every pane.
 *
 * Why a store at all: the work-mode panes are kept alive (`components/work-mode-keep-alive.tsx`), so a
 * pane that read the host's gate once, at mount, keeps its answer for as long as the page lives. On
 * the hosted app a signed-in person may open the desk with no key and then add one in Settings, and
 * every pane they already visited has to hear that without a reload. The same store is where a
 * `403 gateway_blocked` lands (`gateway-blocked.ts`), so the pane that got it and the panes that did
 * not all show the same calm "add your key" state.
 *
 * **Hosted only, by construction.** Both writers are no-ops off the hosted build. The Personal app
 * never mounts a pane on a closed gate (a closed gate is onboarding there) and has never needed
 * this; keeping the writers inert is what guarantees it behaves exactly as it did.
 *
 * Nothing here decides anything. The host reports a gate, or refuses a call; this only remembers the
 * newest of those so panes can display it.
 */
export type GateState = {
  /** The newest gate the host reported, or null before it has said anything. */
  readonly gate: GatewayGatePayload | null;
  /** A gateway-calling route answered `403 gateway_blocked` since the host last reported an open gate. */
  readonly blocked: boolean;
};

const INITIAL: GateState = Object.freeze({ gate: null, blocked: false });

let state: GateState = INITIAL;
const listeners = new Set<() => void>();

/** Two reports of the same verdict. A settings read repeats the answer it gave a minute ago; that is not news. */
function sameGate(a: GatewayGatePayload | null, b: GatewayGatePayload | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.status === b.status &&
    a.allowed === b.allowed &&
    a.grace === b.grace &&
    a.checkedAt === b.checkedAt &&
    a.lastOkAt === b.lastOkAt
  );
}

function publish(next: GateState): void {
  if (sameGate(next.gate, state.gate) && next.blocked === state.blocked) {
    return;
  }
  state = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeGateState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable between changes, as `useSyncExternalStore` requires. Also its server snapshot. */
export function getGateState(): GateState {
  return state;
}

/**
 * The host reported a gate (a settings read, a save, a re-check). An open gate also clears a
 * remembered 403: the host has just said the key works, whatever the last refused call said. A
 * closed one leaves it alone. `null` is the host saying nothing usable, which is not a decision.
 */
export function publishGate(gate: GatewayGatePayload | null): void {
  if (!gate || !isHostedBuild()) {
    return;
  }
  publish({ gate, blocked: gate.allowed ? false : state.blocked });
}

/** A gateway-calling route answered `403 gateway_blocked`. */
export function noteGatewayBlocked(): void {
  if (!isHostedBuild()) {
    return;
  }
  publish({ gate: state.gate, blocked: true });
}

/** True when the desk should show its "add your key" state instead of offering a model call. */
export function deskNeedsKey(shared: GateState): boolean {
  return shared.blocked || shared.gate?.allowed === false;
}

/**
 * Which of two answers a pane believes.
 *
 * On the hosted build, the shared store: it is newer than the pane's mount-time read, so a key saved
 * in Settings unlocks a pane that was already open. Everywhere else, the pane's own read, as it has
 * always been; the store is never consulted.
 */
export function resolveNeedsKey(hosted: boolean, own: boolean, shared: GateState): boolean {
  return hosted ? deskNeedsKey(shared) : own;
}

/** Test seam. */
export function resetGateStateForTests(): void {
  state = INITIAL;
  listeners.clear();
}
