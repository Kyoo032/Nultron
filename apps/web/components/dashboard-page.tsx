"use client";

import { useState, type ComponentType } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import type { ProductMode } from "@agentforge/core/product-modes";
import { DataStudio } from "@/components/data-studio";
import { deskPaneClass, deskPaneInnerClass } from "@/components/desk-pane";
import { DocumentsStudio } from "@/components/documents-studio";
import { EditStudio } from "@/components/edit-studio";
import { EducationStudio } from "@/components/education-studio";
import { FinanceStudio } from "@/components/finance-studio";
import { ImagesStudio } from "@/components/images-studio";
import { LegalStudio } from "@/components/legal-studio";
import { MarketStudio } from "@/components/market-studio";
import { MeetingStudio } from "@/components/meeting-studio";
import { ModeHeader } from "@/components/mode-header";
import { ModeIcon } from "@/components/mode-icons";
import { MusicStudio } from "@/components/music-studio";
import { PresentationsStudio } from "@/components/presentations-studio";
import { ResearchStudio } from "@/components/research-studio";
import { VideosStudio } from "@/components/videos-studio";
import { BOOT_DESK_KEY, nextDeskKey, type DeskKey } from "@/lib/desk-pane-key";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import "./dashboard-page.css";

export type DashboardStudioId = Exclude<ProductMode, "chat">;
export type DashboardSectionId = "creative" | "analysis";

export type DashboardStudioEntry = {
  readonly id: DashboardStudioId;
  readonly section: DashboardSectionId;
};

export const DASHBOARD_SECTIONS: readonly DashboardSectionId[] = ["creative", "analysis"];

export const DASHBOARD_STUDIOS: readonly DashboardStudioEntry[] = [
  { id: "images", section: "creative" },
  { id: "videos", section: "creative" },
  { id: "edit", section: "creative" },
  { id: "music", section: "creative" },
  { id: "presentations", section: "creative" },
  { id: "documents", section: "creative" },
  { id: "market", section: "analysis" },
  { id: "finance", section: "analysis" },
  { id: "data", section: "analysis" },
  { id: "legal", section: "analysis" },
  { id: "research", section: "analysis" },
  { id: "meeting", section: "analysis" },
  { id: "education", section: "analysis" },
];

const STUDIO_COMPONENTS: Record<DashboardStudioId, ComponentType> = {
  images: ImagesStudio,
  videos: VideosStudio,
  edit: EditStudio,
  music: MusicStudio,
  presentations: PresentationsStudio,
  documents: DocumentsStudio,
  market: MarketStudio,
  finance: FinanceStudio,
  data: DataStudio,
  legal: LegalStudio,
  research: ResearchStudio,
  meeting: MeetingStudio,
  education: EducationStudio,
};

const STUDIO_ID_SET = new Set<string>(DASHBOARD_STUDIOS.map((entry) => entry.id));

export function isDashboardStudioId(value: string | undefined): value is DashboardStudioId {
  return typeof value === "string" && STUDIO_ID_SET.has(value);
}

export function dashboardStudioHref(id: DashboardStudioId): string {
  return `/dashboard/${id}`;
}

export function dashboardStudioFromPath(pathname: string): DashboardStudioId | null {
  if (!pathname.startsWith("/dashboard/")) {
    return null;
  }
  const rest = pathname.slice("/dashboard/".length).split("/")[0];
  return isDashboardStudioId(rest) ? rest : null;
}

function DashboardStudioBar({ activeStudio }: { activeStudio: DashboardStudioId }) {
  return (
    <header className="dash-studio-bar" data-testid="dashboard-studio-bar">
      <Link href="/dashboard" className="dash-back" data-testid="dashboard-back">
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        <span>{t("agents.dashboard.back")}</span>
      </Link>
      <span className="dash-bar-sep" aria-hidden="true" />
      <nav
        className="dash-switcher"
        aria-label={t("agents.dashboard.switcherAria")}
        data-testid="dashboard-switcher"
      >
        {DASHBOARD_STUDIOS.map((entry) => {
          const active = entry.id === activeStudio;
          return (
            <Link
              key={entry.id}
              href={dashboardStudioHref(entry.id)}
              aria-current={active ? "page" : undefined}
              data-mode={entry.id}
              data-testid={`dashboard-pill-${entry.id}`}
              className={active ? "dash-pill dash-pill-active" : "dash-pill"}
            >
              <ModeIcon name={entry.id} size={14} strokeWidth={1.85} />
              <span>{t(`rail.${entry.id}`)}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function DashboardStudioPanes() {
  const { pathname } = useLocation();
  const activeStudio = dashboardStudioFromPath(pathname);
  const [visited, setVisited] = useState<DashboardStudioId[]>(() => (activeStudio ? [activeStudio] : []));

  let shown = visited;
  if (activeStudio && !visited.includes(activeStudio)) {
    shown = [...visited, activeStudio];
    setVisited(shown);
  }

  if (shown.length === 0) {
    return null;
  }

  return (
    <div
      hidden={!activeStudio}
      className={activeStudio ? deskPaneClass(true) : "hidden"}
      aria-hidden={!activeStudio}
    >
      <div className={deskPaneInnerClass(true)}>
        <div
          className="dash-studio-shell"
          data-testid="dashboard-studio-shell"
          data-studio={activeStudio ?? undefined}
        >
          {activeStudio ? <DashboardStudioBar activeStudio={activeStudio} /> : null}
          {shown.map((id) => {
            const Studio = STUDIO_COMPONENTS[id];
            const active = id === activeStudio;
            const bodyClass =
              id === "edit" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto";
            return (
              <div
                key={id}
                hidden={!active}
                className={active ? bodyClass : "hidden"}
                aria-hidden={!active}
                data-testid={active ? "dashboard-studio-body" : `dashboard-studio-body-${id}`}
              >
                <Studio />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Keep visited `/dashboard/:studio` panes mounted (hidden when inactive) so typed briefs,
 * selections, and in-flight streams survive switching studios or returning to `/dashboard`.
 * Resets cleanly on a real workspace switch via `nextDeskKey`.
 */
export function DashboardStudioKeepAlive() {
  const { id } = useWorkspaceScope();
  const [desk, setDesk] = useState<DeskKey>(BOOT_DESK_KEY);
  const next = nextDeskKey(desk, id);
  if (next !== desk) {
    setDesk(next);
  }
  return <DashboardStudioPanes key={next.key} />;
}

export function DashboardPage({ studio: studioProp }: { studio?: string } = {}) {
  const params = useParams<{ studio?: string }>();
  const rawStudio = studioProp ?? params.studio;

  if (rawStudio !== undefined) {
    if (!isDashboardStudioId(rawStudio)) {
      return <Navigate to="/dashboard" replace />;
    }
    const Studio = STUDIO_COMPONENTS[rawStudio];
    return (
      <div className="dash-studio-shell" data-testid="dashboard-studio-shell" data-studio={rawStudio}>
        <DashboardStudioBar activeStudio={rawStudio} />
        <div
          className={rawStudio === "edit" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}
          data-testid="dashboard-studio-body"
        >
          <Studio />
        </div>
      </div>
    );
  }

  return (
    <main className="dash-page" data-mode="dashboard" data-testid="dashboard-page">
      <ModeHeader
        icon="dashboard"
        title={t("agents.dashboard.title")}
        shapes={false}
        outcome={t("agents.dashboard.lede")}
        outcomeTestId="dashboard-lede"
      />
      {DASHBOARD_SECTIONS.map((sectionId) => {
        const headingId = `dash-section-${sectionId}`;
        const items = DASHBOARD_STUDIOS.filter((entry) => entry.section === sectionId);
        return (
          <section
            key={sectionId}
            className="dash-section"
            aria-labelledby={headingId}
            data-testid={`dashboard-section-${sectionId}`}
          >
            <h2 className="dash-section-title" id={headingId}>
              {t(`agents.dashboard.sections.${sectionId}`)}
            </h2>
            <ul className="dash-grid">
              {items.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={dashboardStudioHref(entry.id)}
                    className="dash-card"
                    data-mode={entry.id}
                    data-testid={`dashboard-card-${entry.id}`}
                  >
                    <div className="dash-card-head">
                      <span className="dash-tile" aria-hidden="true">
                        <ModeIcon name={entry.id} size={20} strokeWidth={2} />
                      </span>
                      <span className="dash-card-title">{t(`agents.dashboard.studios.${entry.id}`)}</span>
                    </div>
                    <p className="dash-card-desc">{t(`agents.tagline.${entry.id}`)}</p>
                    <span className="dash-card-open">
                      <span>{t("agents.dashboard.openStudio")}</span>
                      <svg
                        width={14}
                        height={14}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M5 12h14" />
                        <path d="m12 5 7 7-7 7" />
                      </svg>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
