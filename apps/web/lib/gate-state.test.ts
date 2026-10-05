/**
 * What the desk has been told about the gateway key, shared by every pane.
 *
 * The work-mode panes are kept alive (`work-mode-keep-alive.tsx`), so a pane that read the gate once
 * at mount would keep telling a signed-in tenant to add a key long after they had saved one in
 * Settings. This store is how a pane hears the host's newer answer, and how it hears a
 * `403 gateway_blocked` the instant any call gets one.
 *
 * **Hosted only.** The Personal app mounts no pane on a closed gate and has never needed this, so
 * off the hosted build nothing here changes anything: that is the first thing pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deskNeedsKey,
  getGateState,
  noteGatewayBlocked,
  publishGate,
  resetGateStateForTests,
  resolveNeedsKey,
  subscribeGateState,
} from "./gate-state";
import type { GatewayGatePayload } from "./gateway-gate";

function gate(patch: Partial<GatewayGatePayload> = {}): GatewayGatePayload {
  return {
    status: "needs_key",
    allowed: false,
    grace: false,
    endpoint: "https://api.tokotokenai.com/v1",
    endpointLocked: true,
    checkedAt: null,
    lastOkAt: null,
    ...patch,
  };
}

const OPEN = gate({ status: "ok", allowed: true });

function asHosted(): void {
  vi.stubGlobal("__AGENTFORGE_SERVER__", "1");
}

beforeEach(() => resetGateStateForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  resetGateStateForTests();
});

describe("off the hosted build the store does nothing", () => {
  it("ignores a published gate and a 403 alike", () => {
    publishGate(gate());
    noteGatewayBlocked();

    expect(getGateState()).toEqual({ gate: null, blocked: false });
    expect(deskNeedsKey(getGateState())).toBe(false);
  });

  it("tells nobody about either", () => {
    const listener = vi.fn();
    subscribeGateState(listener);

    publishGate(gate());
    noteGatewayBlocked();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("on the hosted build", () => {
  beforeEach(asHosted);

  it("starts unknown, and unknown does not block", () => {
    expect(getGateState()).toEqual({ gate: null, blocked: false });
    expect(deskNeedsKey(getGateState())).toBe(false);
  });

  it("needs a key when the host reports a closed gate", () => {
    publishGate(gate());
    expect(deskNeedsKey(getGateState())).toBe(true);
  });

  it("stops needing one the moment the host reports an open gate", () => {
    publishGate(gate());
    publishGate(OPEN);
    expect(deskNeedsKey(getGateState())).toBe(false);
  });

  it("needs a key after a 403 gateway_blocked even when the last gate it read was open", () => {
    publishGate(OPEN);
    noteGatewayBlocked();
    expect(deskNeedsKey(getGateState())).toBe(true);
  });

  it("forgets the 403 only when the host later reports an open gate, not a closed one", () => {
    noteGatewayBlocked();
    publishGate(gate({ status: "invalid_key" }));
    expect(getGateState().blocked).toBe(true);

    publishGate(OPEN);
    expect(getGateState().blocked).toBe(false);
    expect(deskNeedsKey(getGateState())).toBe(false);
  });

  it("ignores a null gate: the host said nothing usable, which is not a decision", () => {
    publishGate(gate());
    publishGate(null);
    expect(getGateState().gate?.allowed).toBe(false);
  });

  it("notifies subscribers once per change and not at all for a repeat", () => {
    const listener = vi.fn();
    const stop = subscribeGateState(listener);
    const closed = gate();

    publishGate(closed);
    publishGate(closed);
    noteGatewayBlocked();
    noteGatewayBlocked();
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    publishGate(OPEN);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not call a repeat of the same verdict news, so a settings read does not re-render every pane", () => {
    const listener = vi.fn();
    subscribeGateState(listener);

    publishGate(gate());
    publishGate({ ...gate() });
    expect(listener).toHaveBeenCalledTimes(1);

    publishGate({ ...gate(), status: "invalid_key" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("hands useSyncExternalStore a stable snapshot between changes", () => {
    publishGate(gate());
    expect(getGateState()).toBe(getGateState());
  });
});

describe("resolveNeedsKey: which of the two answers a pane believes", () => {
  const closedShared = { gate: gate(), blocked: true };

  it("believes the shared store on the hosted build, so a saved key unlocks the kept-alive pane", () => {
    expect(resolveNeedsKey(true, true, { gate: OPEN, blocked: false })).toBe(false);
    expect(resolveNeedsKey(true, false, closedShared)).toBe(true);
  });

  it("believes only its own mount-time read off the hosted build: Personal is exactly as it was", () => {
    // A store that somehow holds a closed gate and a 403 changes nothing for a Personal pane.
    expect(resolveNeedsKey(false, false, closedShared)).toBe(false);
    expect(resolveNeedsKey(false, true, { gate: OPEN, blocked: false })).toBe(true);
  });
});
