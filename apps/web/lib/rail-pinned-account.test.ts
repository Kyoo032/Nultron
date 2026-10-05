/**
 * The rail's Account group is pinned to the bottom of the scrolling nav, and the rows tighten on a
 * short window. Both are layout, which a node-only vitest run cannot measure, so the contract is
 * pinned against the sources the way the other rail tests do; the measured proof is the 1366x768
 * and 1280x800 drives recorded in the changelog (Settings fully visible at both).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");

const appRail = read("components/app-rail.tsx");
const skeleton = read("components/rail-modes-skeleton.tsx");
const hook = read("lib/use-more-below.ts");
const css = read("app/globals.css");

describe("rail account group", () => {
  it("sits in one pinned wrapper inside the scrolling nav, after the job modes", () => {
    const nav = appRail.slice(appRail.indexOf("<nav"), appRail.indexOf("</nav>"));
    const pinned = nav.indexOf('className="rail-pinned shrink-0 pb-2"');
    expect(pinned).toBeGreaterThan(nav.indexOf("jobModes.map"));
    const group = nav.slice(pinned);
    for (const testId of ["mode-knowledge", "channels-link", "workspaces-link", "usage-link", "settings-link"]) {
      expect(group, testId).toContain(`testId="${testId}"`);
    }
    // Only the Account rows live in it: the other groups scroll.
    for (const other of ["rail.groupConverse", "rail.groupJobs", "<RailRecentThreads"]) {
      expect(group, other).not.toContain(other);
    }
  });

  it("is sticky and opaque, so rows scroll behind it", () => {
    const rule = css.slice(css.indexOf("\n.rail-pinned {"), css.indexOf("\n}", css.indexOf("\n.rail-pinned {")));
    expect(rule).toContain("position: sticky;");
    expect(rule).toContain("bottom: 0;");
    expect(rule).toContain("background: var(--rail);");
  });

  it("shows a fade and a hairline only while rows are hidden below", () => {
    expect(appRail).toContain("const { ref: navRef, more: moreBelow } = useMoreBelow<HTMLElement>();");
    expect(appRail).toContain("ref={navRef}");
    expect(appRail).toContain("data-more={moreBelow}");
    expect(css).toContain('.rail-pinned[data-more="true"]::before {');
    expect(css).toContain('.rail-pinned[data-more="true"] {');
    // The state moves only when the answer flips, and it re-measures when the content changes size.
    expect(hook).toContain("node.scrollTop + node.clientHeight < node.scrollHeight - 1");
    expect(hook).toContain("new MutationObserver(schedule)");
    expect(hook).toContain("new ResizeObserver(schedule)");
  });
});

describe("rail on a short window", () => {
  it("steps rows from 32px to 28px under 940px tall, tile and labels with them", () => {
    const start = css.indexOf("@media (max-height: 940px) {\n  [data-rail-row] {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}\n", start));
    expect(block).toContain("height: 28px;");
    expect(block).toContain("[data-rail-row] [data-tile] {");
    expect(block).toContain('[data-tour="rail-modes"] > p');
  });

  it("marks every row shape the rail draws, the skeleton included", () => {
    // `RailItem` draws two shapes (a bare link, and a card with a trailing control); a skeleton row
    // that stayed 32px would jump when the real rows replaced it.
    expect(appRail.match(/data-rail-row/g)?.length).toBe(2);
    expect(skeleton).toContain("data-rail-row");
  });

  it("keeps the 28px sub-list rows the rail's reserve arithmetic assumes", () => {
    expect(read("components/rail-submenu.tsx")).toContain("export const ROW_PX = 28");
  });
});
