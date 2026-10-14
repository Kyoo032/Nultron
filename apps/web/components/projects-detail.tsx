"use client";

import { useState, type FormEvent } from "react";
import { ProjectFiles } from "@/components/projects-files";
import { ProjectMembersPanel } from "@/components/projects-members";
import { archiveProject, ProjectsError, renameProject, type ProjectRecord } from "@/lib/projects-client";
import { t } from "@/lib/i18n";
import { canManage, isOwner } from "@/lib/projects-view";

type Props = {
  project: ProjectRecord;
  me: string | null;
  /** Called with the Workspace as the host now has it, after a rename. */
  onChanged: (project: ProjectRecord) => void;
  /** The caller's role or the member count may have changed: read the list again. */
  onRefresh: () => void;
  /** Called after the Workspace is archived, or the caller left it, so the list drops it. */
  onGone: () => void;
  onBack: () => void;
};

type TabId = "files" | "members" | "knowledge" | "instructions" | "chats";
const TABS: readonly TabId[] = ["files", "members", "knowledge", "instructions", "chats"];
const LIVE_TABS: ReadonlySet<TabId> = new Set(["files", "members"]);

function messageOf(error: unknown): string {
  return error instanceof ProjectsError && error.message ? error.message : t("projects.saveFailed");
}

/**
 * One Workspace: its name, the caller's role in it (K-D23), and its sections. Who sees it is its members, managed on
 * the Members tab. Rename and Archive show for the roles the host allows them to; the host checks again.
 */
export function ProjectsDetail({ project, me, onChanged, onRefresh, onGone, onBack }: Props) {
  const [tab, setTab] = useState<TabId>("files");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rename(event: FormEvent) {
    event.preventDefault();
    const name = (renaming ?? "").trim();
    if (!name || name === project.name) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChanged(await renameProject(project.id, name));
      setRenaming(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await archiveProject(project.id);
      onGone();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="projects-detail" data-testid="projects-detail" data-role={project.role}>
      <button type="button" className="btn btn-ghost projects-back" onClick={onBack}>
        ← {t("projects.detail.back")}
      </button>

      <header className="projects-detail-head">
        {renaming !== null ? (
          <form className="projects-inline-form" onSubmit={rename}>
            <input
              className="input"
              value={renaming}
              maxLength={120}
              aria-label={t("projects.detail.rename")}
              onChange={(event) => setRenaming(event.target.value)}
              data-testid="projects-rename-input"
            />
            <button type="submit" className="btn btn-secondary" disabled={busy}>
              {t("projects.detail.save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setRenaming(null)}>
              {t("projects.detail.cancel")}
            </button>
          </form>
        ) : (
          <>
            <h2 className="projects-title" data-testid="projects-title">
              {project.name}
            </h2>
            <p className="projects-meta" data-testid="projects-your-role">
              {t("projects.detail.yourRole", { role: t(`projects.roles.${project.role}`) })}
            </p>
            <div className="projects-head-actions">
              {canManage(project.role) ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setRenaming(project.name)}
                  data-testid="projects-rename"
                >
                  {t("projects.detail.rename")}
                </button>
              ) : null}
              {isOwner(project.role) ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void archive()}
                  data-testid="projects-archive"
                >
                  {t("projects.detail.archive")}
                </button>
              ) : null}
            </div>
          </>
        )}
      </header>

      {error ? (
        <p className="projects-error" role="alert" data-testid="projects-error">
          {error}
        </p>
      ) : null}

      <div className="projects-tabs" role="tablist" aria-label={t("projects.tabs.aria")}>
        {TABS.map((id) => {
          const soon = !LIVE_TABS.has(id);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`projects-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="projects-panel"
              disabled={soon}
              title={soon ? t("projects.tabs.comingNext") : undefined}
              className="projects-tab"
              onClick={() => setTab(id)}
              data-testid={`projects-tab-${id}`}
            >
              {t(`projects.tabs.${id}`)}
              {soon ? <span className="projects-soon">{t("projects.tabs.comingNext")}</span> : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="projects-panel" aria-labelledby={`projects-tab-${tab}`} className="projects-panel">
        {tab === "files" ? <ProjectFiles project={project} me={me} /> : null}
        {tab === "members" ? (
          <ProjectMembersPanel project={project} me={me} onChanged={onRefresh} onLeft={onGone} />
        ) : null}
        {!LIVE_TABS.has(tab) ? <p className="projects-status">{t("projects.tabs.comingNext")}</p> : null}
      </div>
    </section>
  );
}
