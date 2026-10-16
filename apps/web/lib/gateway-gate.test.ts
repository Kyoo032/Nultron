import { GATEWAY_BASE_URL } from "@agentforge/core/gateway";
import { describe, expect, it } from "vitest";
import {
  announceGate,
  formatGateTimestamp,
  gatewayReasonKey,
  gatewayStatusKey,
  GATE_EVENT,
  GATEWAY_GATE_STATUSES,
  MISSING_GATEWAY_GATE,
  parseGatewayBlocked,
  parseGatewayGate,
  readGateEvent,
  resolveGate,
  type GatewayGatePayload,
  type GatewayGateStatus,
} from "./gateway-gate";

function gate(patch: Partial<GatewayGatePayload> = {}): GatewayGatePayload {
  return {
    status: "ok",
    allowed: true,
    grace: false,
    endpoint: "https://api.tokotokenai.com/v1",
    endpointLocked: true,
    checkedAt: "2026-09-14T04:00:00.000Z",
    lastOkAt: "2026-09-14T04:00:00.000Z",
    ...patch,
  };
}

describe("resolveGate", () => {
  const openers: Array<[GatewayGateStatus, boolean]> = [
    ["ok", true],
    ["stub", true],
  ];

  for (const [status, allowed] of openers) {
    it(`opens the app on ${status} when the host allows it`, () => {
      expect(resolveGate(gate({ status, allowed }), true)).toBe("app");
      expect(resolveGate(gate({ status, allowed }), false)).toBe("app");
    });
  }

  const blockers: GatewayGateStatus[] = ["needs_key", "invalid_key", "unreachable", "error"];

  for (const status of blockers) {
    it(`shows onboarding on ${status}`, () => {
      expect(resolveGate(gate({ status, allowed: false }), true)).toBe("onboarding");
      expect(resolveGate(gate({ status, allowed: false }), false)).toBe("onboarding");
    });
  }

  it("follows the host, not the status name, when the host says allowed", () => {
    // Offline grace can arrive with a non-ok status; the host still decides.
    expect(resolveGate(gate({ status: "unreachable", allowed: true, grace: true }), true)).toBe("app");
  });

  it("never opens on a status the host marked as not allowed", () => {
    for (const status of GATEWAY_GATE_STATUSES) {
      expect(resolveGate(gate({ status, allowed: false }), true)).toBe("onboarding");
    }
  });

  it("fails closed in Electron when the host reports no gate", () => {
    expect(resolveGate(undefined, true)).toBe("onboarding");
    expect(resolveGate(null, true)).toBe("onboarding");
    expect(resolveGate({}, true)).toBe("onboarding");
    expect(resolveGate({ status: "ok" }, true)).toBe("onboarding");
    expect(resolveGate({ allowed: true }, true)).toBe("onboarding");
    expect(resolveGate({ status: "yes", allowed: true }, true)).toBe("onboarding");
    expect(resolveGate("ok", true)).toBe("onboarding");
  });

  const unreported = [undefined, null, {}, { status: "ok" }, { allowed: true }, { status: "yes", allowed: true }, "ok"];

  it("fails closed on the hosted build when the host reports no gate", () => {
    for (const payload of unreported) {
      expect(resolveGate(payload, false, true)).toBe("onboarding");
      expect(resolveGate(payload, true, true)).toBe("onboarding");
    }
  });

  it("fails closed off the hosted build too when the host reports no gate", () => {
    for (const payload of unreported) {
      expect(resolveGate(payload, false, false)).toBe("onboarding");
      expect(resolveGate(payload, true, false)).toBe("onboarding");
    }
  });

  it("fails closed with `hosted` left to the page marker, which no test page carries", () => {
    expect(resolveGate(undefined, false)).toBe("onboarding");
    expect(resolveGate(undefined, true)).toBe("onboarding");
  });

  it("obeys a reported gate the same way whether or not this is the hosted build", () => {
    for (const hosted of [true, false]) {
      expect(resolveGate(gate({ status: "stub", allowed: true }), false, hosted)).toBe("app");
      expect(resolveGate(gate({ status: "error", allowed: false }), false, hosted)).toBe("onboarding");
    }
  });

  it("still opens webdev on the stub gate the host actually reports", () => {
    const reported = { status: "stub", allowed: true, grace: false, endpoint: GATEWAY_BASE_URL, endpointLocked: true };
    expect(resolveGate(reported, false)).toBe("app");
    expect(resolveGate(parseGatewayGate(reported), false)).toBe("app");
  });

  it("has no bypass for a truthy-looking extra field", () => {
    expect(resolveGate({ status: "invalid_key", allowed: false, bypass: true }, true)).toBe("onboarding");
  });
});

/**
 * "Add the key later" (Nultron Enterprise, owner decision 2026-10-01).
 *
 * A signed-in hosted person who chose to wait for a key opens the desk on a gate the host still
 * reports closed. Everything about it is hosted-only: on the Personal app (desktop, webdev) a closed
 * gate is the onboarding key step with no way out but a key, whatever the deferral says.
 */
describe("resolveGate — the hosted deferral", () => {
  const closed: GatewayGateStatus[] = ["needs_key", "invalid_key", "unreachable", "error"];
  const chose = { hasSession: true, later: true };

  it("opens the desk for a signed-in hosted person who chose to add the key later", () => {
    for (const status of closed) {
      expect(resolveGate(gate({ status, allowed: false }), false, true, chose), status).toBe("app");
    }
  });

  it("keeps the welcome in front of them until they have chosen", () => {
    expect(resolveGate(gate({ status: "needs_key", allowed: false }), false, true, { hasSession: true, later: false })).toBe(
      "onboarding",
    );
  });

  it("does not open for a hosted visitor with no session, whatever the record says", () => {
    expect(resolveGate(gate({ status: "needs_key", allowed: false }), false, true, { hasSession: false, later: true })).toBe(
      "onboarding",
    );
  });

  it("does not turn a gate nobody reported into an open desk", () => {
    for (const payload of [undefined, null, {}, { status: "ok" }, "ok"]) {
      expect(resolveGate(payload, false, true, chose)).toBe("onboarding");
    }
  });

  it("still opens on an allowed gate and still closes on nothing else", () => {
    expect(resolveGate(gate({ status: "ok", allowed: true }), false, true, { hasSession: false, later: false })).toBe("app");
  });

  describe("on the Personal app nothing changes", () => {
    it("ignores the deferral entirely: a closed gate is onboarding on webdev and on the packaged app", () => {
      for (const isElectron of [true, false]) {
        for (const status of closed) {
          const reported = gate({ status, allowed: false });
          expect(resolveGate(reported, isElectron, false, chose), `${status} electron=${isElectron}`).toBe("onboarding");
          // Same answer as the call that never heard of a deferral, which is what Personal makes.
          expect(resolveGate(reported, isElectron, false, chose)).toBe(resolveGate(reported, isElectron, false));
        }
      }
    });

    it("never opens a missing gate off the hosted build, whatever was chosen", () => {
      expect(resolveGate(undefined, false, false, chose)).toBe("onboarding");
      expect(resolveGate(undefined, true, false, chose)).toBe("onboarding");
    });

    it("defaults to no deferral, so the two-argument call every Personal path makes is unchanged", () => {
      expect(resolveGate(gate({ status: "needs_key", allowed: false }), true)).toBe("onboarding");
      expect(resolveGate(gate({ status: "needs_key", allowed: false }), false)).toBe("onboarding");
    });
  });
});

describe("parseGatewayGate", () => {
  it("keeps the reported gate and pins endpointLocked", () => {
    const parsed = parseGatewayGate({
      status: "invalid_key",
      allowed: false,
      grace: false,
      endpoint: "https://api.tokotokenai.com/v1 ",
      endpointLocked: true,
      checkedAt: "2026-09-14T04:00:00.000Z",
      lastOkAt: null,
      message: " 401 from gateway ",
    });
    expect(parsed).toEqual({
      status: "invalid_key",
      allowed: false,
      grace: false,
      endpoint: "https://api.tokotokenai.com/v1",
      endpointLocked: true,
      checkedAt: "2026-09-14T04:00:00.000Z",
      lastOkAt: null,
      message: "401 from gateway",
    });
  });

  it("reads grace only when the host set it", () => {
    expect(parseGatewayGate(gate({ grace: true }))?.grace).toBe(true);
    expect(parseGatewayGate({ ...gate(), grace: "yes" })?.grace).toBe(false);
    expect(parseGatewayGate(gate())?.grace).toBe(false);
  });

  it("falls back to the pinned endpoint and drops an empty message", () => {
    const parsed = parseGatewayGate({ status: "needs_key", allowed: false, endpoint: "  ", message: "  " });
    expect(parsed?.endpoint).toBe(MISSING_GATEWAY_GATE.endpoint);
    expect(parsed?.message).toBeUndefined();
    expect(parsed?.checkedAt).toBeNull();
    expect(parsed?.lastOkAt).toBeNull();
  });

  it("returns null for anything that is not a gate", () => {
    expect(parseGatewayGate(undefined)).toBeNull();
    expect(parseGatewayGate(null)).toBeNull();
    expect(parseGatewayGate("ok")).toBeNull();
    expect(parseGatewayGate({ status: "ok", allowed: "true" })).toBeNull();
  });

  it("ships a fail-closed fallback", () => {
    expect(MISSING_GATEWAY_GATE.allowed).toBe(false);
    expect(MISSING_GATEWAY_GATE.status).toBe("error");
    expect(resolveGate(MISSING_GATEWAY_GATE, true)).toBe("onboarding");
  });
});

describe("copy keys", () => {
  it("explains only the statuses that need a reason", () => {
    expect(gatewayReasonKey("invalid_key")).toBe("onboarding.gate.invalidKey");
    expect(gatewayReasonKey("unreachable")).toBe("onboarding.gate.unreachable");
    expect(gatewayReasonKey("error")).toBe("onboarding.gate.error");
    expect(gatewayReasonKey("needs_key")).toBeNull();
    expect(gatewayReasonKey("ok")).toBeNull();
    expect(gatewayReasonKey("stub")).toBeNull();
    expect(gatewayReasonKey(null)).toBeNull();
  });

  it("names a settings status key for every status", () => {
    for (const status of GATEWAY_GATE_STATUSES) {
      expect(gatewayStatusKey(status)).toBe(`settings.gateway.status.${status}`);
    }
  });
});

describe("parseGatewayBlocked", () => {
  it("reads a 403 gateway_blocked body", () => {
    expect(parseGatewayBlocked({ error: "gateway_blocked", status: "invalid_key", message: " key rejected " })).toEqual(
      { status: "invalid_key", message: "key rejected" },
    );
  });

  it("falls back to error for an unknown status and a missing message", () => {
    expect(parseGatewayBlocked({ error: "gateway_blocked", status: "banana" })).toEqual({
      status: "error",
      message: null,
    });
    expect(parseGatewayBlocked({ error: "gateway_blocked" })).toEqual({ status: "error", message: null });
  });

  it("ignores any other error body", () => {
    expect(parseGatewayBlocked({ error: "runtime_stub" })).toBeNull();
    expect(parseGatewayBlocked({ error: { message: "nope" } })).toBeNull();
    expect(parseGatewayBlocked(null)).toBeNull();
    expect(parseGatewayBlocked("gateway_blocked")).toBeNull();
  });
});

describe("formatGateTimestamp", () => {
  it("formats an ISO date per locale", () => {
    expect(formatGateTimestamp("2026-09-14T04:00:00.000Z", "en")).toMatch(/2026/);
    expect(formatGateTimestamp("2026-09-14T04:00:00.000Z", "id")).toMatch(/2026/);
  });

  it("returns null when there is nothing to show", () => {
    expect(formatGateTimestamp(null, "en")).toBeNull();
    expect(formatGateTimestamp(undefined, "en")).toBeNull();
    expect(formatGateTimestamp("not-a-date", "en")).toBeNull();
  });

  it("adds a time only when asked", () => {
    const dateOnly = formatGateTimestamp("2026-09-14T04:00:00.000Z", "en");
    const withTime = formatGateTimestamp("2026-09-14T04:00:00.000Z", "en", true);
    expect(withTime).not.toBe(dateOnly);
    expect(withTime?.length).toBeGreaterThan((dateOnly ?? "").length);
  });
});

describe("gate events", () => {
  it("names one event for the whole renderer", () => {
    expect(GATE_EVENT).toBe("agentforge-gate");
  });

  it("reads a gate back out of an event detail", () => {
    const event = { type: GATE_EVENT, detail: gate({ status: "needs_key", allowed: false }) } as unknown as Event;
    expect(readGateEvent(event)).toEqual(gate({ status: "needs_key", allowed: false }));
  });

  it("returns null when the detail is not a gate", () => {
    for (const detail of [null, undefined, "needs_key", {}, { status: "ok" }, { status: "yes", allowed: true }]) {
      expect(readGateEvent({ type: GATE_EVENT, detail } as unknown as Event)).toBeNull();
    }
    expect(readGateEvent({ type: GATE_EVENT } as unknown as Event)).toBeNull();
  });

  it("re-parses the detail rather than trusting it", () => {
    const event = {
      type: GATE_EVENT,
      detail: { status: "ok", allowed: true, endpoint: "  ", grace: "yes", bypass: true },
    } as unknown as Event;
    const read = readGateEvent(event);
    expect(read?.grace).toBe(false);
    expect(read?.endpointLocked).toBe(true);
    expect(read).not.toHaveProperty("bypass");
  });

  it("does nothing when there is no window to announce on", () => {
    expect(typeof window).toBe("undefined");
    expect(() => announceGate(gate())).not.toThrow();
    expect(() => announceGate(null)).not.toThrow();
  });
});
