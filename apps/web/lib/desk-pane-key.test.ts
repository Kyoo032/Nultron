/**
 * The key the work-mode panes mount under (`WorkModeKeepAlive`).
 *
 * On a cold load the shell has no desk id for the first round trip, then `GET /api/v1/workspaces`
 * names one. The panes used to be keyed on `id ?? "boot"`, so that answer remounted every pane that
 * had just mounted: Chat's key status flipped invisible → connected → invisible → connected within
 * about 160 ms, every first read ran twice, and an attachment made in the gap was dropped (found
 * driving webdev, 2026-10-01). The first id is now adopted without a remount; only a move from one
 * real desk to another still starts the panes over, which is the point of the key.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOOT_DESK_KEY, nextDeskKey, type DeskKey } from "./desk-pane-key";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The key after each id in turn, starting from a cold load. */
function keysFor(ids: ReadonlyArray<string | null>): string[] {
  const out: string[] = [];
  let state: DeskKey = BOOT_DESK_KEY;
  for (const id of ids) {
    state = nextDeskKey(state, id);
    out.push(state.key);
  }
  return out;
}

describe("nextDeskKey", () => {
  it("starts on the boot key with no desk known", () => {
    expect(BOOT_DESK_KEY).toEqual({ key: "boot", id: null });
  });

  it("keeps the panes mounted when the first desk id arrives", () => {
    expect(keysFor([null, "ws_home"])).toEqual(["boot", "boot"]);
    expect(nextDeskKey(BOOT_DESK_KEY, "ws_home")).toEqual({ key: "boot", id: "ws_home" });
  });

  it("returns the same object while nothing changed, so a render does not set state", () => {
    const settled = nextDeskKey(BOOT_DESK_KEY, "ws_home");
    expect(nextDeskKey(settled, "ws_home")).toBe(settled);
    expect(nextDeskKey(BOOT_DESK_KEY, null)).toBe(BOOT_DESK_KEY);
  });

  it("starts the panes over when the desk changes to another", () => {
    expect(keysFor([null, "ws_a", "ws_b"])).toEqual(["boot", "boot", "ws_b"]);
    expect(keysFor(["ws_a", "ws_b", "ws_a"])).toEqual(["boot", "ws_b", "ws_a"]);
  });

  it("never remounts on an unknown id once a desk is known", () => {
    // `shellWorkspaceFrom` only ever hands the shell a real id, but a lapsed read must not blow the
    // panes away (a live Meeting recording would end with them).
    expect(keysFor(["ws_a", null, "ws_a"])).toEqual(["boot", "boot", "boot"]);
    expect(keysFor(["ws_a", "ws_b", null])).toEqual(["boot", "ws_b", "ws_b"]);
  });
});

describe("WorkModeKeepAlive", () => {
  it("keys its panes on nextDeskKey, not on the raw desk id", () => {
    const source = readFileSync(join(web, "components", "work-mode-keep-alive.tsx"), "utf8");
    expect(source).toContain("nextDeskKey");
    expect(source).not.toMatch(/key=\{id \?\? "boot"\}/);
  });
});
