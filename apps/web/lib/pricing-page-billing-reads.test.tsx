/**
 * What `/pricing` asks the host, and of whom — the effects, actually run.
 *
 * `pricing-page-render.test.tsx` renders the page with `renderToStaticMarkup`, which runs no effects,
 * so it can say what the page looks like but not what it *posts*. The page's own comment promises
 * that a signed-out visitor never posts to a billing route; `/pricing` is public and is where a
 * `seat_cap_reached` refusal sends people, so a visitor who is signed out by definition lands on it.
 * The tier read honoured that and the checkout probe (`POST /api/v1/billing/top-up`) did not: it ran
 * on `capabilities.plans` alone, so every signed-out visit put a `401 session_required` in the hosted
 * server's log and in the browser console, for an answer the page discards.
 *
 * There is no DOM in this package's test environment, so the effects are collected by a stand-in for
 * `useEffect` while the real `renderToStaticMarkup` renders the real component, and then run by hand
 * exactly as React would after a commit. The seam that is asserted is `apiFetch` — the network — not
 * `fetchCheckoutOffer`, so a future second caller of the route would be caught too.
 */
import type { EffectCallback, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostCapabilities, type HostCapabilities } from "@agentforge/core/capabilities";
import { PricingPage } from "@/components/pricing-page";
import { EVERYTHING_OFF, HostCapabilitiesFixture } from "./host-capabilities";
import { applyLocale, resetLocaleForTests } from "./i18n";
import { SESSIONS_OFF, SESSION_BOOTING, SessionFixture, type SessionSnapshot } from "./session";

const harness = vi.hoisted(() => ({
  armed: false,
  effects: [] as EffectCallback[],
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ apiFetch: harness.apiFetch }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const reactsOwn = actual.useEffect;
  const collect = (effect: EffectCallback): void => {
    harness.effects.push(effect);
  };
  return {
    ...actual,
    // Armed only around one render in this file; every other caller gets React's own hook. Both
    // branches are a call made on every render, so this is not a conditional hook.
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
      harness.armed ? collect(effect) : reactsOwn(effect, deps),
  };
});

const HOSTED = hostCapabilities({ AGENTFORGE_SERVER: "1" });
const DESK = hostCapabilities({});

const SIGNED_IN: SessionSnapshot = {
  status: "signed-in",
  identity: { userId: "u_1", orgId: "o_1", tenantId: "t_1", expiresAt: 0 },
  reason: null,
};
const SIGNED_OUT: SessionSnapshot = { status: "signed-out", identity: null, reason: null };

const TOP_UP = "/api/v1/billing/top-up";
const PLANS = "/api/v1/billing/plans";

type Reads = { readonly topUps: number; readonly tierReads: number; readonly billingPaths: readonly string[] };

/** Render `/pricing`, run the effects it scheduled, let their requests settle, and count them. */
async function visit(capabilities: HostCapabilities, session: SessionSnapshot): Promise<Reads> {
  harness.apiFetch.mockClear();
  harness.effects.length = 0;
  const tree: ReactElement = (
    <MemoryRouter initialEntries={["/pricing"]}>
      <HostCapabilitiesFixture capabilities={capabilities}>
        <SessionFixture value={session}>
          <PricingPage />
        </SessionFixture>
      </HostCapabilitiesFixture>
    </MemoryRouter>
  );

  harness.armed = true;
  try {
    renderToStaticMarkup(tree);
  } finally {
    harness.armed = false;
  }

  const cleanups = harness.effects.map((effect) => effect());
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const cleanup of cleanups) {
    if (typeof cleanup === "function") {
      cleanup();
    }
  }

  const billingPaths = harness.apiFetch.mock.calls
    .map((call) => String(call[0]))
    .filter((path) => path.startsWith("/api/v1/billing/"));
  return {
    topUps: billingPaths.filter((path) => path === TOP_UP).length,
    tierReads: billingPaths.filter((path) => path === PLANS).length,
    billingPaths,
  };
}

beforeEach(() => {
  applyLocale("en");
  harness.apiFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ available: false, current: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
});

afterEach(() => {
  resetLocaleForTests();
});

describe("the billing reads /pricing makes", () => {
  it("posts nothing to a billing route for a signed-out visitor on the hosted server", async () => {
    const reads = await visit(HOSTED, SIGNED_OUT);
    expect(reads.topUps).toBe(0);
    expect(reads.tierReads).toBe(0);
    expect(reads.billingPaths).toEqual([]);
  });

  it("waits, and posts nothing, while the session is still unresolved", async () => {
    // `/pricing` is a public path, so it mounts during boot, before the session read has answered.
    const reads = await visit(HOSTED, SESSION_BOOTING);
    expect(reads.billingPaths).toEqual([]);
  });

  it("probes the checkout exactly once for a signed-in tenant, beside the tier read", async () => {
    const reads = await visit(HOSTED, SIGNED_IN);
    expect(reads.topUps).toBe(1);
    expect(reads.tierReads).toBe(1);
  });

  it("makes no billing request at all where plans are not enforced", async () => {
    // Webdev and the desktop: no route, and a 404 in the console of an app that works.
    expect((await visit(DESK, SESSIONS_OFF)).billingPaths).toEqual([]);
    // Before ping has answered, every capability reads false and the session is unknown.
    expect((await visit(EVERYTHING_OFF, SESSION_BOOTING)).billingPaths).toEqual([]);
    // Not hosted but somehow signed in: still no plans, still no billing request.
    expect((await visit(DESK, SIGNED_IN)).billingPaths).toEqual([]);
  });
});
