import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BuddyBody, BuddyChip, DeskBuddyChip, DeskBuddyDock } from "@/components/desk-buddy";
import { pictureUrls } from "@/components/nultron/nx-picture";
import { BUDDY_NEXT } from "./desk-buddy-state";
import { applyLocale, resetLocaleForTests, t } from "./i18n";
import { isMascotBusy, MASCOT_STATES } from "./mascot-states";

/**
 * Where the desk buddy stands, and what that means for everything else. The measured proof is a drive
 * (`features/mascot.md`); these hold the shape of it so a later change cannot quietly put it somewhere that
 * can lie on a control.
 */

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(web, ...parts), "utf8").replace(/\r\n/g, "\n");
const imagesDir = join(web, "components", "nultron", "images");
const fileOf = (url: string) => url.split("?")[0].split("/").slice(-2).join("/");

afterEach(() => resetLocaleForTests());

describe("the rail is where the buddy stands", () => {
  const rail = read("components", "app-rail.tsx");

  it("mounts the dock as the last thing in the list, after the pinned Account group", () => {
    const pinned = rail.indexOf("rail-pinned");
    const dock = rail.indexOf("<DeskBuddyDock collapsed={collapsed} />");
    const end = rail.indexOf("</nav>");
    expect(pinned).toBeGreaterThan(-1);
    expect(dock).toBeGreaterThan(pinned);
    expect(end).toBeGreaterThan(dock);
  });

  it("mounts the chip in the footer row, beside the theme control", () => {
    const footer = rail.indexOf('data-testid="rail-footer"');
    const theme = rail.indexOf("<ThemeToggle />", footer);
    const chip = rail.indexOf("<DeskBuddyChip />", footer);
    expect(footer).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(theme);
  });

  it("gives the shell its reactions once, beside the rail", () => {
    const shell = read("components", "app-shell.tsx");
    expect(shell.match(/<DeskBuddyReactions \/>/g)).toHaveLength(1);
    expect(shell.indexOf("<DeskBuddyReactions />")).toBeGreaterThan(shell.indexOf("<AppRail"));
  });

  it("never floats over the desk: nothing about the buddy is fixed to the viewport or the desk pane", () => {
    const css = read("components", "desk-buddy.css");
    const tsx = read("components", "desk-buddy.tsx");
    expect(css).not.toMatch(/position:\s*fixed/);
    expect(tsx).not.toMatch(/\bfixed\b/);
    // the one absolute box is the minimise control and the contact shadow, both inside the buddy's own box
    const dock = css.match(/\.desk-buddy-dock \{([^}]*)\}/)?.[1] ?? "";
    expect(dock).not.toMatch(/position:/);
  });

  it("takes only the room the last row leaves over, and none when the list scrolls", () => {
    const dock = read("components", "desk-buddy.css").match(/\.desk-buddy-dock \{([^}]*)\}/)?.[1] ?? "";
    expect(dock).toMatch(/flex:\s*1 1 0/);
    expect(dock).toMatch(/min-height:\s*0/);
    expect(dock).toMatch(/overflow:\s*hidden/);
  });

  it("has no dock in a collapsed rail and no chip without a dock", () => {
    expect(renderToStaticMarkup(<DeskBuddyDock collapsed />)).toBe("");
    expect(renderToStaticMarkup(<DeskBuddyChip />)).toBe("");
  });

  it("is an empty, measured dock until a rail has mounted it", () => {
    const html = renderToStaticMarkup(<DeskBuddyDock collapsed={false} />);
    expect(html).toContain('data-testid="desk-buddy-dock"');
    expect(html).toContain('data-view="none"');
    expect(html).not.toContain("chat-mascot");
  });
});

describe("what it draws", () => {
  it("is a decorative picture inside a button that carries the name, in both languages", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<BuddyBody size={96} />);
    expect(html).toContain(`aria-label="${t("common.buddy.tap")}"`);
    expect(html).toContain(`aria-label="${t("common.buddy.minimise")}"`);
    expect(html).toContain('data-placement="buddy"');
    expect(html).toContain('data-variant="full"');
    // the character itself says nothing: the button next to it does
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    applyLocale("id");
    expect(renderToStaticMarkup(<BuddyBody size={96} />)).toContain(`aria-label="${t("common.buddy.tap")}"`);
  });

  it("rests on idle and holds still: nothing loops until a run says so", () => {
    const html = renderToStaticMarkup(<BuddyBody size={80} />);
    expect(html).toContain('data-state="idle"');
    expect(html).not.toContain("data-busy");
  });

  it("is a head in the footer, 32 px, and the same button gets another name once the person made it small", () => {
    applyLocale("en");
    const chip = renderToStaticMarkup(<BuddyChip restore={false} />);
    expect(chip).toContain('data-variant="head"');
    expect(chip).toContain("--nx-size:32px");
    expect(chip).toContain(`aria-label="${t("common.buddy.tap")}"`);
    expect(renderToStaticMarkup(<BuddyChip restore />)).toContain(`aria-label="${t("common.buddy.restore")}"`);
  });

  it("loops a working pose in the rail, where a status character belongs", () => {
    for (const state of MASCOT_STATES) {
      expect(isMascotBusy(state, "buddy"), state).toBe(isMascotBusy(state, "beside"));
    }
  });

  it("fetches at idle only what a run can end on, and its clips only once a run is under way", () => {
    const stills = BUDDY_NEXT.flatMap((state) => pictureUrls(state, "full", { sheet: false }));
    const bytes = stills.reduce((sum, url) => sum + statSync(join(imagesDir, fileOf(url))).size, 0);
    expect(stills.every((url) => /\/full\//.test(url))).toBe(true);
    expect(bytes).toBeLessThan(100_000);
  });
});

describe("one character on screen", () => {
  it("tells the buddy about every full body but its own", () => {
    const mascot = read("components", "nultron", "nultron-mascot.tsx");
    expect(mascot).toMatch(/useFullBodyPresence\(rootRef, rig === "full" && placement !== "buddy"\)/);
  });

  it("hands a chip beside a job over to the buddy, and keeps drawing it when there is no buddy", () => {
    const slot = read("components", "mascot-slot.tsx");
    expect(slot).toMatch(/if \(beside && takesStatus\) \{\s*return null;/);
    const turn = read("components", "chat-turn.tsx");
    expect(turn).toMatch(/live && liveState && !takesStatus \?/);
    const session = read("components", "chat-session.tsx");
    expect(session).toMatch(/buddyTakesStatus \? null/);
    expect(read("components", "app-updates.tsx")).toMatch(/face && !takesStatus/);
    expect(read("components", "component-setup.tsx")).toMatch(/face && !takesStatus/);
  });

  it("keeps the preview hook working: a forced state is drawn where it stands", () => {
    expect(read("components", "mascot-slot.tsx")).toMatch(/const beside = context\.placement === "beside" && !preview\.state;/);
  });
});

describe("who tells it what", () => {
  it("hears from a streamed job, the chat run, the installer and updates", () => {
    expect(read("lib", "use-job-stream.ts")).toMatch(/useBuddyRunEnd\(busy, Boolean\(error\) \|\| Boolean\(progress\.error\), progress\.done\)/);
    expect(read("lib", "use-component-setup.ts")).toMatch(/useBuddyStatus\(componentSetupMascot\(setup\.status\), setup\.status === "running"\)/);
    expect(read("components", "app-updates.tsx")).toMatch(/useBuddyStatus\(buddyFace, buddyFace === "charging"\)/);
    expect(read("components", "chat-session.tsx")).toMatch(/useChatBuddyReactions\(\{ running, failed: sendFailed, error: Boolean\(error\) \}\)/);
    expect(read("components", "chat-turn.tsx")).toMatch(/useBuddyClaim\(/);
    expect(read("components", "mascot-slot.tsx")).toMatch(/useBuddyClaim\(working \?/);
  });

  it("has a drive hook that holds a state over everything else, and the gate and tour reactions", () => {
    const reactions = read("components", "desk-buddy-reactions.tsx");
    expect(reactions).toMatch(/params\.get\("buddy"\)/);
    expect(reactions).toMatch(/DRIVE_HOOK_PRIORITY = 100/);
    expect(reactions).toMatch(/flashBuddy\("surprised"\)/);
    expect(reactions).toMatch(/state: "presenting"/);
    expect(reactions).toMatch(/GATE_EVENT/);
  });
});

describe("what it says", () => {
  it("has its words in both catalogs", () => {
    for (const locale of ["en", "id"]) {
      const common = JSON.parse(read("locales", locale, "common.json")) as { buddy?: Record<string, string> };
      expect(Object.keys(common.buddy ?? {}).sort()).toEqual(["minimise", "region", "restore", "tap"]);
    }
  });
});
