import { describe, expect, it } from "vitest";
import { RESET_CONFIRM_WORD as CORE_RESET_WORD, TENANT_ERASE_CONFIRM_WORD } from "@agentforge/core";
import {
  ERASE_ACCOUNT_CONFIRM_WORD,
  parseCancelResetResult,
  parseResetResult,
  RESET_CONFIRM_WORD,
  RESET_SCOPES,
} from "./reset-app";

const gateway = {
  status: "needs_key",
  allowed: false,
  grace: false,
  endpoint: "https://api.tokotokenai.com/v1",
  endpointLocked: true,
  checkedAt: "2026-09-15T04:00:00.000Z",
  lastOkAt: null,
};

describe("parseResetResult", () => {
  it("reads a signed-out key reset", () => {
    expect(parseResetResult(200, { ok: true, scope: "key", relaunch: false, gateway }, "key")).toEqual({
      ok: true,
      scope: "key",
      relaunch: false,
      resetPending: false,
      gateway: {
        status: "needs_key",
        allowed: false,
        grace: false,
        endpoint: "https://api.tokotokenai.com/v1",
        endpointLocked: true,
        checkedAt: "2026-09-15T04:00:00.000Z",
        lastOkAt: null,
      },
    });
  });

  it("reads a fresh-install reset that needs a relaunch", () => {
    const result = parseResetResult(200, { ok: true, scope: "all", relaunch: true, gateway }, "all");
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("all");
    expect(result.relaunch).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("reads a 400 invalid_request with its message", () => {
    expect(
      parseResetResult(400, { error: { code: "invalid_request", message: " confirm must be RESET " } }, "all"),
    ).toEqual({
      ok: false,
      scope: "all",
      relaunch: false,
      resetPending: false,
      gateway: null,
      error: "confirm must be RESET",
    });
  });

  it("keeps the requested scope when the host echoes none", () => {
    expect(parseResetResult(400, { error: { code: "invalid_request" } }, "all").scope).toBe("all");
    expect(parseResetResult(400, { error: { code: "invalid_request" } }).scope).toBe("key");
    expect(parseResetResult(200, { ok: true, scope: "banana" }, "all").scope).toBe("all");
  });

  it("reports a plain string error body", () => {
    expect(parseResetResult(400, { error: " nope " }, "key").error).toBe("nope");
  });

  it("never reports done for a malformed body", () => {
    for (const body of [null, undefined, "ok", 42, [], { ok: "true" }, {}]) {
      const result = parseResetResult(200, body, "all");
      expect(result.ok).toBe(false);
      expect(result.relaunch).toBe(false);
      expect(result.gateway).toBeNull();
      expect(result.scope).toBe("all");
    }
  });

  it("never reports done on a non-200 that still says ok", () => {
    const result = parseResetResult(500, { ok: true, scope: "all", relaunch: true }, "all");
    expect(result.ok).toBe(false);
    expect(result.relaunch).toBe(false);
  });

  it("never relaunches unless the host asked in so many words", () => {
    expect(parseResetResult(200, { ok: true, scope: "all", relaunch: "yes" }, "all").relaunch).toBe(false);
    expect(parseResetResult(200, { ok: true, scope: "all" }, "all").relaunch).toBe(false);
  });

  it("reads the queued wipe the host reports", () => {
    expect(
      parseResetResult(200, { ok: true, scope: "all", relaunch: true, resetPending: true }, "all").resetPending,
    ).toBe(true);
    expect(parseResetResult(200, { ok: true, scope: "all", relaunch: true }, "all").resetPending).toBe(false);
    expect(parseResetResult(200, { ok: true, scope: "all", resetPending: "yes" }, "all").resetPending).toBe(false);
    expect(parseResetResult(500, { resetPending: true }, "all").resetPending).toBe(true);
  });

  it("reads the host's error code beside its message, so the card can use its own words for it", () => {
    const refused = parseResetResult(
      403,
      { error: { code: "tenant_reset_forbidden", message: "Only an owner of this account can erase it." } },
      "tenant",
    );
    expect(refused).toMatchObject({ ok: false, code: "tenant_reset_forbidden" });
    expect(parseResetResult(403, { error: "nope" }, "tenant").code).toBeUndefined();
  });

  it("leaves a desk's refusal exactly the shape it always had: no code, whatever the host sent", () => {
    // The company erase is the only reset with words of its own for a refusal (owner rule 2026-10-01:
    // change the hosted version only), so Start over and Sign out of the gateway never see the field.
    for (const scope of ["key", "all"] as const) {
      const refused = parseResetResult(400, { error: { code: "invalid_request", message: "nope" } }, scope);
      expect(refused).toEqual({
        ok: false,
        scope,
        relaunch: false,
        resetPending: false,
        gateway: null,
        error: "nope",
      });
      expect(refused).not.toHaveProperty("code");
    }
  });

  it("reads a company erase that signed the caller out", () => {
    const erased = parseResetResult(
      200,
      { ok: true, scope: "tenant", relaunch: false, resetPending: false, signedOut: true, bytesFreed: 512 },
      "tenant",
    );
    expect(erased).toMatchObject({ ok: true, scope: "tenant", signedOut: true, bytesFreed: 512 });
    // Anything but an explicit true is not a sign-out the renderer may act on.
    expect(parseResetResult(200, { ok: true, scope: "tenant", signedOut: "yes" }, "tenant").signedOut).toBeUndefined();
  });

  it("keeps both confirm words in step with the host's", () => {
    // The renderer keeps its own copies (the core barrel is Node-only), so this is the only thing
    // that stops the box and the check drifting apart.
    expect(RESET_CONFIRM_WORD).toBe(CORE_RESET_WORD);
    expect(ERASE_ACCOUNT_CONFIRM_WORD).toBe(TENANT_ERASE_CONFIRM_WORD);
    // And the company erase does not ask for the lighter word the desk uses.
    expect(ERASE_ACCOUNT_CONFIRM_WORD).not.toBe(RESET_CONFIRM_WORD);
  });

  it("ships the literal confirm word and all three scopes", () => {
    expect(RESET_CONFIRM_WORD).toBe("RESET");
    // Phase 8 added `tenant`: the hosted account erase. It is a third scope rather than a hosted
    // branch inside `all`, so an existing desk client's request never changes meaning and neither
    // target's button can reach the other's behaviour.
    expect([...RESET_SCOPES]).toEqual(["key", "all", "tenant"]);
  });
});

describe("parseCancelResetResult", () => {
  it("reads a cancelled wipe", () => {
    expect(parseCancelResetResult(200, { ok: true, resetPending: false })).toEqual({ ok: true, resetPending: false });
  });

  it("keeps the wipe queued for anything that is not an explicit success", () => {
    for (const [status, body] of [
      [500, { ok: true, resetPending: false }],
      [200, { ok: false }],
      [200, null],
      [200, "ok"],
      [404, { error: { code: "not_found", message: " nothing queued " } }],
    ] as const) {
      const result = parseCancelResetResult(status, body);
      expect(result.ok).toBe(false);
      expect(result.resetPending).toBe(true);
    }
  });

  it("carries the host's message for a refused cancel", () => {
    expect(parseCancelResetResult(409, { error: { message: " too late " } }).error).toBe("too late");
    expect(parseCancelResetResult(200, { ok: true, resetPending: false }).error).toBeUndefined();
  });

  it("believes the host when it says the wipe is still queued", () => {
    expect(parseCancelResetResult(200, { ok: true, resetPending: true })).toEqual({ ok: true, resetPending: true });
  });
});
