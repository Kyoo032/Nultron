import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFakeShip, type FakeShip } from "./__fixtures__/fake-ship";
import { checkShip, findRepoRoot, locateShipDir, resetShipVerdictForTests, setShipDirForTests } from "./ship";

let ship: FakeShip | null = null;
const savedPackaged = process.env.AGENTFORGE_PACKAGED;

beforeEach(() => {
  resetShipVerdictForTests();
  setShipDirForTests(null);
});

afterEach(async () => {
  await ship?.cleanup();
  ship = null;
  setShipDirForTests(null);
  resetShipVerdictForTests();
  if (savedPackaged === undefined) {
    delete process.env.AGENTFORGE_PACKAGED;
  } else {
    process.env.AGENTFORGE_PACKAGED = savedPackaged;
  }
});

describe("locateShipDir", () => {
  it("prefers AGENTFORGE_SANDBOX_DIR", () => {
    expect(locateShipDir({ AGENTFORGE_SANDBOX_DIR: tmpdir() })).toBe(tmpdir());
  });

  it("ignores the environment hook in the packaged app and falls back to the repo location", () => {
    process.env.AGENTFORGE_PACKAGED = "1";
    const located = locateShipDir({ AGENTFORGE_SANDBOX_DIR: join(tmpdir(), "attacker-controlled") });
    expect(located).not.toContain("attacker-controlled");
  });

  it("falls back to vendor/sandbox-runtime under the repo root in webdev", () => {
    delete process.env.AGENTFORGE_PACKAGED;
    const located = locateShipDir({});
    expect(located?.replaceAll("\\", "/")).toMatch(/\/vendor\/sandbox-runtime$/);
  });

  it("finds the checkout root by its workspace file", () => {
    const root = findRepoRoot();
    expect(root).not.toBeNull();
    const nested = mkdtempSync(join(tmpdir(), "no-workspace-"));
    mkdirSync(join(nested, "a", "b"), { recursive: true });
    try {
      expect(findRepoRoot([join(nested, "a", "b")])).toBeNull();
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  });
});

describe("checkShip", () => {
  it("accepts a ship whose manifests match and reports the languages it can run", async () => {
    ship = makeFakeShip({ manifest: "root" });
    setShipDirForTests(ship.dir);
    const status = await checkShip();
    expect(status).toMatchObject({ ok: true, dir: ship.dir });
    expect(status.ok && [...status.languages].sort()).toEqual(["javascript", "python"]);
  });

  it("is unavailable when the directory does not exist", async () => {
    setShipDirForTests(join(tmpdir(), "no-such-sandbox-dir-xyz"));
    expect(await checkShip()).toEqual({ ok: false, why: "missing" });
  });

  it("rejects a pinned file whose bytes changed", async () => {
    ship = makeFakeShip();
    appendFileSync(ship.pinnedFile, " ");
    setShipDirForTests(ship.dir);
    expect(await checkShip()).toEqual({ ok: false, why: "mismatch" });
  });

  it("rejects a pinned file that was deleted", async () => {
    ship = makeFakeShip();
    rmSync(ship.pinnedFile);
    setShipDirForTests(ship.dir);
    expect(await checkShip()).toEqual({ ok: false, why: "mismatch" });
  });

  it("rejects a tampered child script when the ship-root manifest pins it", async () => {
    ship = makeFakeShip({ manifest: "root" });
    appendFileSync(join(ship.dir, "py-child.mjs"), "\n// changed\n");
    setShipDirForTests(ship.dir);
    expect(await checkShip()).toEqual({ ok: false, why: "mismatch" });
  });

  it("rejects an unreadable manifest", async () => {
    ship = makeFakeShip();
    writeFileSync(join(ship.dir, "vendor", "pyodide", "MANIFEST.json"), "{not json");
    setShipDirForTests(ship.dir);
    expect(await checkShip()).toEqual({ ok: false, why: "unreadable" });
  });

  it("runs only JavaScript when there is no Pyodide manifest", async () => {
    ship = makeFakeShip({ manifest: "none" });
    setShipDirForTests(ship.dir);
    const status = await checkShip();
    expect(status.ok && [...status.languages]).toEqual(["javascript"]);
  });

  it("is incomplete when neither engine is there", async () => {
    ship = makeFakeShip({ manifest: "none", withQuickJs: false });
    setShipDirForTests(ship.dir);
    expect(await checkShip()).toEqual({ ok: false, why: "incomplete" });
  });

  it("verifies once per process: a change after the first check is not noticed", async () => {
    ship = makeFakeShip();
    setShipDirForTests(ship.dir);
    expect((await checkShip()).ok).toBe(true);
    appendFileSync(ship.pinnedFile, " ");
    expect((await checkShip()).ok).toBe(true);
    resetShipVerdictForTests();
    expect((await checkShip()).ok).toBe(false);
  });
});
