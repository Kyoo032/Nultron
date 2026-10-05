/**
 * Best-effort sign-out at the portal for everybody an erased company had signed in (SR-65, owner
 * decision 2026-10-01).
 *
 * The portal has no "remove a company" or "remove a member" call. What it does have is
 * `POST /auth/logout { all_devices: true }`, which ends every portal session of the caller and the
 * portal's own browser sessions (SR-21), and the host holds a sealed refresh token for each browser
 * that is signed in. So the host presents each person's token once, to get an access token, and uses
 * that to sign them out everywhere. What these tests pin: it is one sign-out per person and never one
 * per browser; it can never fail an erase that has already happened; it never waits on a dead portal
 * for longer than its budget; and no token reaches a log line or a report.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalError, type PortalClient, type PortalRefreshInput, type PortalTokens } from "./portal-client";
import { endPortalSessionsBestEffort } from "./portal-sign-out";
import { hashSessionId } from "./session";
import { sealRefresh } from "./session-secrets";

const logged: Array<{ level: string; event: string; fields: unknown }> = [];
vi.mock("../log", () => ({
  log: {
    debug: (event: string, fields: unknown) => logged.push({ level: "debug", event, fields }),
    info: (event: string, fields: unknown) => logged.push({ level: "info", event, fields }),
    warn: (event: string, fields: unknown) => logged.push({ level: "warn", event, fields }),
    error: (event: string, fields: unknown) => logged.push({ level: "error", event, fields }),
  },
}));

const WRAP = createHash("sha256").update("wrap-key-one", "utf8").digest();
const OTHER_WRAP = createHash("sha256").update("wrap-key-two", "utf8").digest();
const CLIENT = { clientId: "host-client", clientSecret: "host-client-secret-value" };

/** A row's digest and the sealed token for it, the way sign-in leaves them in `auth_sessions`. */
function seal(cookieId: string, userId: string, refreshToken: string, wrap = WRAP) {
  const idHash = hashSessionId(cookieId);
  return {
    idHash,
    userId,
    refreshSealed: sealRefresh(idHash, { refreshToken, deviceId: `dev-of-${cookieId}` }, wrap),
  };
}

function tokensFor(refreshToken: string): PortalTokens {
  return {
    accessToken: `access-for-${refreshToken}`,
    expiresIn: 3600,
    refreshToken: `rotated-${refreshToken}`,
    refreshExpiresIn: 2592000,
    sessionId: "ses",
    deviceId: "dev",
    userId: "u",
    orgId: "o",
    tenantId: "t",
    role: null,
  };
}

type Recorded = { refreshes: PortalRefreshInput[]; logouts: Array<{ accessToken: string; allDevices?: boolean }> };

function fakePortal(overrides: { refresh?: PortalClient["refresh"]; logout?: PortalClient["logout"] } = {}): {
  portal: PortalClient;
  calls: Recorded;
} {
  const calls: Recorded = { refreshes: [], logouts: [] };
  const portal: PortalClient = {
    async exchangeCode() {
      throw new Error("not used");
    },
    async refresh(input) {
      calls.refreshes.push(input);
      return overrides.refresh ? overrides.refresh(input) : tokensFor(input.refreshToken);
    },
    async logout(input) {
      calls.logouts.push(input);
      if (overrides.logout) {
        await overrides.logout(input);
      }
    },
  };
  return { portal, calls };
}

const deps = (portal: PortalClient, extra: Partial<Parameters<typeof endPortalSessionsBestEffort>[1]> = {}) => ({
  portal,
  wrapKey: () => WRAP,
  clientCredentials: () => CLIENT,
  tenantId: "tenant-a",
  ...extra,
});

beforeEach(() => {
  logged.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("endPortalSessionsBestEffort", () => {
  it("refreshes with the host's client and the stored device id, then signs the person out of every device", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort([seal("cookie-1", "user-1", "refresh-1")], deps(portal));

    expect(calls.refreshes).toEqual([
      {
        refreshToken: "refresh-1",
        deviceId: "dev-of-cookie-1",
        clientId: "host-client",
        clientSecret: "host-client-secret-value",
      },
    ]);
    // The access token that came back from the rotation, not anything held before it.
    expect(calls.logouts).toEqual([{ accessToken: "access-for-refresh-1", allDevices: true }]);
    expect(report).toEqual({ people: 1, signedOut: 1, failed: 0, unreachable: 0, unfinished: 0 });
  });

  it("signs a person out once however many browsers they had", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort(
      [
        seal("cookie-a", "user-1", "refresh-a"),
        seal("cookie-b", "user-1", "refresh-b"),
        seal("cookie-c", "user-2", "refresh-c"),
      ],
      deps(portal),
    );
    // all_devices ends the other browsers' portal sessions too, so rotating their tokens as well
    // would only spend tokens the portal is about to revoke.
    expect(calls.refreshes.map((call) => call.refreshToken).sort()).toEqual(["refresh-a", "refresh-c"]);
    expect(calls.logouts).toHaveLength(2);
    expect(report.people).toBe(2);
    expect(report.signedOut).toBe(2);
  });

  it("falls through to the person's next browser when the first token does not open", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort(
      [seal("cookie-a", "user-1", "refresh-a", OTHER_WRAP), seal("cookie-b", "user-1", "refresh-b")],
      deps(portal),
    );
    expect(calls.refreshes.map((call) => call.refreshToken)).toEqual(["refresh-b"]);
    expect(report).toMatchObject({ people: 1, signedOut: 1, unreachable: 0 });
  });

  it("counts a person none of whose tokens open as unreachable, and does not call the portal for them", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort(
      [seal("cookie-a", "user-1", "refresh-a", OTHER_WRAP)],
      deps(portal),
    );
    expect(calls.refreshes).toEqual([]);
    expect(report).toEqual({ people: 1, signedOut: 0, failed: 0, unreachable: 1, unfinished: 0 });
  });

  it("reads a session the portal has already ended as signed out, and does not call logout", async () => {
    const { portal, calls } = fakePortal({
      refresh: async () => {
        throw new PortalError("session_revoked", 401);
      },
    });
    const report = await endPortalSessionsBestEffort([seal("cookie-1", "user-1", "refresh-1")], deps(portal));
    expect(calls.logouts).toEqual([]);
    expect(report).toMatchObject({ signedOut: 1, failed: 0 });
  });

  it("records a portal that cannot be reached as failed, and still handles the next person", async () => {
    let first = true;
    const { portal, calls } = fakePortal({
      refresh: async (input) => {
        if (first) {
          first = false;
          throw new PortalError("portal_unavailable", 503);
        }
        return tokensFor(input.refreshToken);
      },
    });
    const report = await endPortalSessionsBestEffort(
      [seal("cookie-1", "user-1", "refresh-1"), seal("cookie-2", "user-2", "refresh-2")],
      deps(portal, { concurrency: 1 }),
    );
    expect(report).toMatchObject({ people: 2, signedOut: 1, failed: 1 });
    expect(calls.logouts).toHaveLength(1);
    expect(logged.some((line) => line.event === "tenant_erase_portal_signout_failed")).toBe(true);
  });

  it("records a refused logout as failed", async () => {
    const { portal } = fakePortal({
      logout: async () => {
        throw new PortalError("portal_unavailable", 502);
      },
    });
    const report = await endPortalSessionsBestEffort([seal("cookie-1", "user-1", "refresh-1")], deps(portal));
    expect(report).toMatchObject({ people: 1, signedOut: 0, failed: 1 });
  });

  it("never throws, whatever the portal client does", async () => {
    const { portal } = fakePortal({
      refresh: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(
      endPortalSessionsBestEffort([seal("cookie-1", "user-1", "refresh-1")], deps(portal)),
    ).resolves.toMatchObject({ failed: 1 });
  });

  it("reads an unreadable wrap key as a deployment fault: everyone failed, nobody called", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort(
      [seal("cookie-1", "user-1", "refresh-1")],
      deps(portal, {
        wrapKey: () => {
          throw new Error("no wrap key");
        },
      }),
    );
    expect(calls.refreshes).toEqual([]);
    expect(report).toMatchObject({ people: 1, failed: 1 });
  });

  it("does nothing for a tenant with no sealed sessions", async () => {
    const { portal, calls } = fakePortal();
    const report = await endPortalSessionsBestEffort([], deps(portal));
    expect(calls).toEqual({ refreshes: [], logouts: [] });
    expect(report).toEqual({ people: 0, signedOut: 0, failed: 0, unreachable: 0, unfinished: 0 });
  });

  it("runs at most `concurrency` people at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const { portal } = fakePortal({
      refresh: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return tokensFor(input.refreshToken);
      },
    });
    const seals = Array.from({ length: 9 }, (_, index) => seal(`cookie-${index}`, `user-${index}`, `refresh-${index}`));
    const report = await endPortalSessionsBestEffort(seals, deps(portal, { concurrency: 3 }));
    expect(report.signedOut).toBe(9);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("stops waiting when the budget is spent, and says how many were still running", async () => {
    vi.useFakeTimers();
    const { portal } = fakePortal({ refresh: () => new Promise<PortalTokens>(() => undefined) });
    const running = endPortalSessionsBestEffort(
      [seal("cookie-1", "user-1", "refresh-1"), seal("cookie-2", "user-2", "refresh-2")],
      deps(portal, { waitMs: 1000 }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toEqual({ people: 2, signedOut: 0, failed: 0, unreachable: 0, unfinished: 2 });
  });

  it("never puts a token, a sealed blob or the client secret in a log line or in the report", async () => {
    const { portal } = fakePortal({
      refresh: async () => {
        throw new PortalError("portal_unavailable", 503);
      },
    });
    const sealed = seal("cookie-1", "user-1", "refresh-1");
    const report = await endPortalSessionsBestEffort([sealed], deps(portal));
    const everything = JSON.stringify({ logged, report });
    for (const secret of ["refresh-1", sealed.refreshSealed, sealed.idHash, "host-client-secret-value", "cookie-1"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
