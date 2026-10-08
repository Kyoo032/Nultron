import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortDesktopStream,
  getDesktopBrand,
  getDesktopBrandLogo,
  getDesktopUpdates,
  invokeDesktop,
  isElectron,
  pickDesktopFolder,
  relaunchDesktopApp,
  saveDesktopBytes,
} from "./desktop-bridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop-bridge", () => {
  it("is not Electron when the preload bridge is missing", () => {
    expect(isElectron()).toBe(false);
    expect(getDesktopBrand()).toBeUndefined();
    expect(getDesktopBrandLogo()).toBeUndefined();
    expect(getDesktopUpdates()).toBeUndefined();
  });

  it("reads brand, data-image logo, and updates from the preload bridge", () => {
    const updates = {
      supported: true,
      state: async () => ({ supported: true }),
      check: async () => ({ supported: true }),
      download: async () => ({ supported: true }),
      install: async () => undefined,
    };
    vi.stubGlobal("window", {
      agentforge: {
        isElectron: true,
        brand: { productName: "Kemenkeu AI", gatewayName: "AIHub" },
        brandLogo: "data:image/png;base64,abc",
        updates,
      },
    });
    expect(isElectron()).toBe(true);
    expect(getDesktopBrand()).toEqual({ productName: "Kemenkeu AI", gatewayName: "AIHub" });
    expect(getDesktopBrandLogo()).toBe("data:image/png;base64,abc");
    expect(getDesktopUpdates()).toBe(updates);
  });

  it("ignores a brand logo that is not a data image", () => {
    vi.stubGlobal("window", {
      agentforge: {
        isElectron: true,
        brandLogo: "https://example.test/logo.png",
      },
    });
    expect(getDesktopBrandLogo()).toBeUndefined();
  });

  it("invokes and saves through the bridge", async () => {
    const invoke = vi.fn(async () => ({ type: "json" as const, status: 200, body: { ok: true } }));
    const saveBytes = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      agentforge: { isElectron: true, invoke, saveBytes },
    });
    await expect(
      invokeDesktop({
        requestId: "r1",
        method: "GET",
        path: "/api/v1/ping",
        query: {},
      }),
    ).resolves.toEqual({ type: "json", status: 200, body: { ok: true } });
    await saveDesktopBytes("note.txt", [1, 2]);
    expect(saveBytes).toHaveBeenCalledWith("note.txt", [1, 2]);
  });

  it("hands back what the shell answered to a save, so a refusal is not lost", async () => {
    const answer = (value: unknown) => {
      vi.stubGlobal("window", { agentforge: { isElectron: true, saveBytes: vi.fn(async () => value) } });
      return saveDesktopBytes("note.txt", [1]);
    };
    await expect(answer({ ok: true })).resolves.toEqual({ ok: true });
    await expect(answer({ ok: false, reason: "write-failed" })).resolves.toEqual({
      ok: false,
      reason: "write-failed",
    });
    await expect(answer({ ok: false, reason: "canceled" })).resolves.toEqual({ ok: false, reason: "canceled" });
    // `ok: false` with no reason is still a refusal; a reason that is not text is dropped.
    await expect(answer({ ok: false, reason: 7 })).resolves.toEqual({ ok: false });
  });

  it("reads a shell that answered nothing, or something that is not an answer, as no answer", async () => {
    for (const value of [undefined, null, "saved", 1, {}, { ok: "yes" }]) {
      vi.stubGlobal("window", { agentforge: { isElectron: true, saveBytes: vi.fn(async () => value) } });
      await expect(saveDesktopBytes("note.txt", [1])).resolves.toBeUndefined();
    }
  });

  it("no-ops abort and save when the bridge is missing", async () => {
    abortDesktopStream("r1");
    await expect(saveDesktopBytes("note.txt", [1])).resolves.toBeUndefined();
  });

  it("passes a reset request through to the shell relaunch", async () => {
    const relaunch = vi.fn(async () => undefined);
    vi.stubGlobal("window", { agentforge: { isElectron: true, relaunch } });
    // The shell exits before it can answer, so an empty reply is the happy path.
    await expect(relaunchDesktopApp({ reset: true })).resolves.toEqual({ ok: true });
    expect(relaunch).toHaveBeenCalledWith({ reset: true });
    await expect(relaunchDesktopApp()).resolves.toEqual({ ok: true });
    expect(relaunch).toHaveBeenLastCalledWith(undefined);
  });

  it("reads an explicit ok from the shell", async () => {
    const relaunch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", { agentforge: { isElectron: true, relaunch } });
    await expect(relaunchDesktopApp({ reset: true })).resolves.toEqual({ ok: true });
  });

  it("surfaces a refusal instead of reporting a restart that is not coming", async () => {
    for (const reason of ["installing-update", "already-exiting", "forbidden"]) {
      const relaunch = vi.fn(async () => ({ ok: false, reason }));
      vi.stubGlobal("window", { agentforge: { isElectron: true, relaunch } });
      await expect(relaunchDesktopApp({ reset: true })).resolves.toEqual({ ok: false, reason });
    }
  });

  it("names a refusal the shell left blank", async () => {
    const relaunch = vi.fn(async () => ({ ok: false, reason: "  " }));
    vi.stubGlobal("window", { agentforge: { isElectron: true, relaunch } });
    await expect(relaunchDesktopApp()).resolves.toEqual({ ok: false, reason: "refused" });
  });

  it("has no folder picker on webdev or the hosted app", async () => {
    await expect(pickDesktopFolder()).resolves.toBeNull();
  });

  it("has no folder picker when the shell is an older build without one", async () => {
    vi.stubGlobal("window", { agentforge: { isElectron: true } });
    await expect(pickDesktopFolder()).resolves.toBeNull();
    vi.stubGlobal("window", { agentforge: { isElectron: true, pickFolder: "not a function" } });
    await expect(pickDesktopFolder()).resolves.toBeNull();
  });

  it("does not call a picker on a bridge that is not the Electron shell", async () => {
    const pickFolder = vi.fn(async () => ({ path: "C:\\Users\\rizky\\notes" }));
    vi.stubGlobal("window", { agentforge: { isElectron: false, pickFolder } });
    await expect(pickDesktopFolder()).resolves.toBeNull();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("hands back the folder the owner picked", async () => {
    const pickFolder = vi.fn(async () => ({ path: "C:\\Users\\rizky\\notes" }));
    vi.stubGlobal("window", { agentforge: { isElectron: true, pickFolder } });
    await expect(pickDesktopFolder()).resolves.toEqual({ path: "C:\\Users\\rizky\\notes" });
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(pickFolder).toHaveBeenCalledWith();
  });

  it("reports a closed dialog as canceled", async () => {
    const pickFolder = vi.fn(async () => ({ canceled: true }));
    vi.stubGlobal("window", { agentforge: { isElectron: true, pickFolder } });
    await expect(pickDesktopFolder()).resolves.toEqual({ canceled: true });
  });

  it("reads an answer that is not a usable path as nothing chosen", async () => {
    for (const answer of [undefined, null, "C:\\notes", {}, { path: "" }, { path: "   " }, { path: 7 }]) {
      const pickFolder = vi.fn(async () => answer);
      vi.stubGlobal("window", { agentforge: { isElectron: true, pickFolder } });
      await expect(pickDesktopFolder()).resolves.toEqual({ canceled: true });
    }
  });

  it("lets a shell failure surface instead of reading it as a cancel", async () => {
    const pickFolder = vi.fn(async () => {
      throw new Error("dialog failed");
    });
    vi.stubGlobal("window", { agentforge: { isElectron: true, pickFolder } });
    await expect(pickDesktopFolder()).rejects.toThrow("dialog failed");
  });

  it("reports no relaunch on webdev, where the bridge has none", async () => {
    await expect(relaunchDesktopApp({ reset: true })).resolves.toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("window", { agentforge: { isElectron: true } });
    await expect(relaunchDesktopApp({ reset: true })).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
