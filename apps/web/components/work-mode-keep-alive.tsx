import { useState, type ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { ChatPage } from "@/src/pages/chat-page";
import { DocumentsStudio } from "@/components/documents-studio";
import { ResearchStudio } from "@/components/research-studio";
import { FinanceStudio } from "@/components/finance-studio";
import { DataStudio } from "@/components/data-studio";
import { MarketStudio } from "@/components/market-studio";
import { ImagesStudio } from "@/components/images-studio";
import { VideosStudio } from "@/components/videos-studio";
import { MusicStudio } from "@/components/music-studio";
import { EditStudio } from "@/components/edit-studio";
import { PresentationsStudio } from "@/components/presentations-studio";
import { EducationStudio } from "@/components/education-studio";
import { LegalStudio } from "@/components/legal-studio";
import { MeetingStudio } from "@/components/meeting-studio";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import { deskPaneClass, deskPaneInnerClass, FILL_DESK_PATHS } from "@/components/desk-pane";
import { BOOT_DESK_KEY, nextDeskKey, type DeskKey } from "@/lib/desk-pane-key";

const WORK_MODE_COMPONENTS: Record<string, ComponentType> = {
  "/chat": ChatPage,
  "/documents": DocumentsStudio,
  "/research": ResearchStudio,
  "/finance": FinanceStudio,
  "/data": DataStudio,
  "/market": MarketStudio,
  "/images": ImagesStudio,
  "/videos": VideosStudio,
  "/music": MusicStudio,
  "/edit": EditStudio,
  "/presentations": PresentationsStudio,
  "/education": EducationStudio,
  "/legal": LegalStudio,
  "/meeting": MeetingStudio,
};

const WORK_MODE_PATHS = Object.keys(WORK_MODE_COMPONENTS);

/**
 * Keep visited work-mode pages mounted (hidden when inactive) so in-flight
 * UI/SSE state survives rail switches. No product session cap.
 *
 * The active pane is one scrollport (`DeskPane`). Chat and Edit fill it and
 * scroll inside themselves, so the composer and the timeline stay put.
 * Every other mode scrolls the pane: those pages grow, they do not add a
 * second bar. The pane is not remounted on a rail switch, so its scroll
 * position survives.
 */
export function WorkModeKeepAlive() {
  const { id } = useWorkspaceScope();
  const [desk, setDesk] = useState<DeskKey>(BOOT_DESK_KEY);
  // A desk switch remounts every pane on purpose: what each one lists belongs to the desk. The
  // first id of a cold load is not a switch, so it is adopted without a remount (`nextDeskKey`):
  // keyed on the raw id, every pane mounted and was thrown away within a round trip. Two things
  // keep a real switch from costing work that cannot be redone. The shell changes this id only when
  // the host names a desk, never on a failed read (`shellWorkspaceFrom`, `src/App.tsx`). And
  // Meeting hands a recording it still holds to its next mount (`stashRescuedClip`,
  // `meeting-studio.tsx`) instead of losing it with the pane.
  const next = nextDeskKey(desk, id);
  if (next !== desk) {
    setDesk(next);
  }
  return <WorkModePanes key={next.key} />;
}

function WorkModePanes() {
  const { pathname } = useLocation();
  const [visited, setVisited] = useState<string[]>(() => (WORK_MODE_PATHS.includes(pathname) ? [pathname] : []));

  let shown = visited;
  if (WORK_MODE_PATHS.includes(pathname) && !visited.includes(pathname)) {
    shown = [...visited, pathname];
    setVisited(shown);
  }

  return (
    <>
      {shown.map((path) => {
        const Page = WORK_MODE_COMPONENTS[path];
        if (!Page) {
          return null;
        }
        const active = pathname === path;
        const fill = FILL_DESK_PATHS.has(path);
        return (
          <div key={path} hidden={!active} className={active ? deskPaneClass(fill) : "hidden"} aria-hidden={!active}>
            <div className={deskPaneInnerClass(fill)}>
              <Page />
            </div>
          </div>
        );
      })}
    </>
  );
}
