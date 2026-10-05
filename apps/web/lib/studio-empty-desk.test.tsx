/**
 * The empty-desk character is back on the seven studios that lost it (2026-10-01): Documents, Research,
 * Data, Images, Videos, Music and Presentations. The owner asked for "the mascot back on the empty desks"
 * once the desk buddy took the status role, and the 2026-09-27 layout rule still holds: the character
 * never moves the prompt dock or the template list, so it sits at the end of the page, after the dock.
 *
 * Node has no layout engine, so three things are held here and the rest is a browser drive
 * (`.cursor/skills/verify-agentforge/features/mascot.md`, "Empty desks"):
 *  - each studio, rendered as a first visit (no result, no saved items, nothing running), draws the
 *    character exactly once, as an empty-desk body for its mode, after its prompt dock;
 *  - each studio mounts it only while nothing real is on the desk (the condition is in the source,
 *    next to the mount, and names the studio's own busy flag, result and saved items);
 *  - the room rule (`emptyDeskTier`): the whole scene when it fits or the page already scrolls, the
 *    character alone when only that fits, nothing when not even that does.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { DataStudio } from "@/components/data-studio";
import { DocumentsStudio } from "@/components/documents-studio";
import { ImagesStudio } from "@/components/images-studio";
import { MusicStudio } from "@/components/music-studio";
import { PresentationsStudio } from "@/components/presentations-studio";
import { ResearchStudio } from "@/components/research-studio";
import {
  EMPTY_DESK_FULL_PX,
  EMPTY_DESK_MASCOT_PX,
  EMPTY_DESK_PAD_PX,
  emptyDeskTier,
} from "@/components/studio-empty-desk";
import { VideosStudio } from "@/components/videos-studio";
import { resetLocaleForTests } from "./i18n";
import { MASCOT_MODE_HOME, type MascotMode } from "./mascot-states";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(join(web, "components", file), "utf8").replace(/\r\n/g, "\n");
const count = (html: string, needle: string) => html.split(needle).length - 1;

type Row = { mode: MascotMode; render: () => React.ReactElement; file: string; dock: string };

const STUDIOS: Row[] = [
  { mode: "documents", render: () => <DocumentsStudio />, file: "documents-studio.tsx", dock: "documents-studio-prompt-bar" },
  { mode: "research", render: () => <ResearchStudio />, file: "research-studio.tsx", dock: "research-studio-prompt-bar" },
  { mode: "data", render: () => <DataStudio />, file: "data-studio.tsx", dock: "data-studio-prompt-bar" },
  { mode: "images", render: () => <ImagesStudio />, file: "images-studio.tsx", dock: "images-studio-prompt-bar" },
  { mode: "videos", render: () => <VideosStudio />, file: "videos-studio.tsx", dock: "videos-studio-prompt-bar" },
  { mode: "music", render: () => <MusicStudio />, file: "music-studio.tsx", dock: "music-studio-prompt-bar" },
  {
    mode: "presentations",
    render: () => <PresentationsStudio />,
    file: "presentations-studio.tsx",
    dock: "presentations-studio-prompt-bar",
  },
];

afterEach(() => resetLocaleForTests());

describe("a studio's first visit", () => {
  for (const { mode, render, dock } of STUDIOS) {
    it(`${mode}: draws the character once, after the prompt dock, waving`, () => {
      const html = renderToStaticMarkup(<MemoryRouter>{render()}</MemoryRouter>);
      // The gallery of Images, Videos and Music is `loading` on the first render, so the character joins
      // once the host has answered; those three are held by the source check below. The rest draw it now.
      const drawnOnFirstRender = !["images", "videos", "music"].includes(mode);
      if (!drawnOnFirstRender) {
        // The header hosts Nultron (`BuddyStage`); the empty desk adds no character of its own yet.
        expect(count(html, 'data-placement="empty"')).toBe(0);
        return;
      }
      expect(count(html, `data-testid="${mode}-studio-empty"`)).toBe(1);
      // One empty-desk character, plus the header stage that takes over from it in a browser once the header is
      // on screen (`announceStage` -> `staged`; held by desk-buddy-store.test.ts). A server render sees both.
      expect(count(html, 'data-placement="empty"')).toBe(1);
      expect(count(html, 'data-testid="buddy-stage-header"')).toBe(1);
      expect(html).toContain('data-placement="empty"');
      // An empty desk waves first and settles on the mode's home pose after 1.4 s (`MascotSlot`, `mascot-states.test.ts`).
      expect(html).toContain(`data-mode="${mode}"`);
      expect(html).toContain('data-state="wave"');
      expect(MASCOT_MODE_HOME[mode]).toBeTruthy();
      expect(html.indexOf(`data-testid="${mode}-studio-empty"`)).toBeGreaterThan(html.indexOf(`data-testid="${dock}"`));
    });
  }
});

describe("the mount, in each studio's source", () => {
  for (const { mode, file, dock } of STUDIOS) {
    it(`${mode}: one StudioEmptyDesk, after the dock, only while nothing real is on the desk`, () => {
      const text = source(file);
      const mounts = [...text.matchAll(/<StudioEmptyDesk\b[^>]*\/>/g)];
      expect(mounts, `${file} mounts the character once`).toHaveLength(1);
      expect(mounts[0]?.[0]).toContain(`mode="${mode}"`);
      // After the prompt dock: the dock and the template list never move for it.
      expect(text.indexOf("<StudioEmptyDesk"), `${file}: after the dock`).toBeGreaterThan(text.indexOf(dock));
    });
  }

  // What each studio calls "something real": the guard is the few lines around the mount.
  const GUARDS: Record<string, RegExp[]> = {
    documents: [/draft \|\| busy !== null/],
    research: [/shown \|\| job\.busy \|\| job\.progress\.phases\.length > 0/],
    data: [/dataset \|\| shown \|\| busy \|\| job\.progress\.phases\.length > 0/],
    images: [/items\.length === 0/, /generating \? null/, /loading \?/],
    videos: [/items\.length === 0/, /generating \? null/, /loading \?/],
    music: [/items\.length === 0/, /busy \? null/, /loading \?/],
    presentations: [/hasDeck \|\| busy !== null/],
  };

  for (const { mode, file } of STUDIOS) {
    it(`${mode}: not mounted next to a running job, a result or saved items`, () => {
      const text = source(file);
      const at = text.indexOf("<StudioEmptyDesk");
      const around = text.slice(Math.max(0, at - 700), at + 120);
      for (const guard of GUARDS[mode] ?? []) {
        expect(around, `${file}: ${guard}`).toMatch(guard);
      }
    });
  }
});

describe("emptyDeskTier", () => {
  const pad = EMPTY_DESK_PAD_PX;

  it("draws the whole scene when all of it fits", () => {
    expect(emptyDeskTier(pad + EMPTY_DESK_FULL_PX)).toBe("full");
    expect(emptyDeskTier(900)).toBe("full");
  });

  it("draws the character alone when only that fits", () => {
    expect(emptyDeskTier(pad + EMPTY_DESK_FULL_PX - 1)).toBe("mascot");
    expect(emptyDeskTier(pad + EMPTY_DESK_MASCOT_PX)).toBe("mascot");
  });

  it("draws nothing when not even the character fits, so a short window keeps its desk as it was", () => {
    expect(emptyDeskTier(pad + EMPTY_DESK_MASCOT_PX - 1)).toBe("none");
    expect(emptyDeskTier(0)).toBe("none");
  });

  it("draws the whole scene at the end of a page that already scrolls, where it adds a bar to nothing", () => {
    expect(emptyDeskTier(-1)).toBe("full");
    expect(emptyDeskTier(-2400)).toBe("full");
  });

  it("takes no gap of its own where the section it sits in already has one (flush)", () => {
    expect(emptyDeskTier(EMPTY_DESK_FULL_PX, 0)).toBe("full");
    expect(emptyDeskTier(EMPTY_DESK_MASCOT_PX, 0)).toBe("mascot");
    expect(emptyDeskTier(EMPTY_DESK_MASCOT_PX - 1, 0)).toBe("none");
  });
});
