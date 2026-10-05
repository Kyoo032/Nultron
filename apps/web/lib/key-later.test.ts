/**
 * "Add the key later", the renderer's half (Nultron Enterprise only).
 *
 * The host keeps the choice (`POST /api/v1/settings/key-later`, `keyLater` on the settings answer);
 * this module reads it, writes it, and decides who may be offered it. Every one of those is hosted
 * only: a Personal app has no session and no such route, so nothing here may let it reach either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({ apiFetch }));

import { canOfferKeyLater, deskDeferral, KEY_LATER_PATH, parseKeyLater, recordKeyLater } from "./key-later";

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ keyLater: { chosen: true, at: 5 } }), { status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseKeyLater", () => {
  it("reads only an explicit chosen: true", () => {
    expect(parseKeyLater({ chosen: true, at: 5 })).toBe(true);
    expect(parseKeyLater({ chosen: false, at: null })).toBe(false);
  });

  it("reads anything else as not chosen, so a welcome shown once too often is the worst case", () => {
    for (const junk of [undefined, null, 1, "yes", [], {}, { chosen: "true" }, { chosen: 1 }]) {
      expect(parseKeyLater(junk), String(junk)).toBe(false);
    }
  });
});

describe("canOfferKeyLater", () => {
  it("is true for a signed-in person on the hosted build, and nowhere else", () => {
    expect(canOfferKeyLater(true, "signed-in")).toBe(true);
    // Personal: no sessions on webdev or the desktop, and the marker is absent.
    expect(canOfferKeyLater(false, "unavailable")).toBe(false);
    expect(canOfferKeyLater(false, "signed-in")).toBe(false);
    // Hosted but not (yet) signed in: the sign-in screen has no key step.
    for (const status of ["unknown", "signed-out", "unavailable"] as const) {
      expect(canOfferKeyLater(true, status), status).toBe(false);
    }
  });
});

describe("deskDeferral", () => {
  const body = { keyLater: { chosen: true, at: 5 } };

  it("carries the host's record only for a signed-in person on the hosted build", () => {
    expect(deskDeferral(true, "signed-in", body)).toEqual({ hasSession: true, later: true });
    expect(deskDeferral(true, "signed-in", { keyLater: { chosen: false, at: null } })).toEqual({
      hasSession: true,
      later: false,
    });
  });

  it("is empty off the hosted build, whatever the answer says", () => {
    expect(deskDeferral(false, "unavailable", body)).toEqual({ hasSession: false, later: false });
    expect(deskDeferral(false, "signed-in", body)).toEqual({ hasSession: false, later: false });
  });

  it("is empty for a hosted visitor with no session", () => {
    expect(deskDeferral(true, "signed-out", body)).toEqual({ hasSession: false, later: false });
  });

  it("survives a settings answer that is not an object", () => {
    for (const junk of [null, undefined, "x", 3]) {
      expect(deskDeferral(true, "signed-in", junk)).toEqual({ hasSession: true, later: false });
    }
  });
});

describe("recordKeyLater", () => {
  it("posts to the host's route with no body to trust", async () => {
    await expect(recordKeyLater()).resolves.toBe(true);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(KEY_LATER_PATH);
    expect(KEY_LATER_PATH).toBe("/api/v1/settings/key-later");
    expect(init.method).toBe("POST");
  });

  it("says false and never throws when the host refuses or cannot be reached", async () => {
    apiFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(recordKeyLater()).resolves.toBe(false);

    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(recordKeyLater()).resolves.toBe(false);
  });
});
