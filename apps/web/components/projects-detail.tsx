"use client";

import { useState, type FormEvent } from "react";
import { ProjectFiles } from "@/components/projects-files";
import {
  archiveProject,
  ProjectsError,
  updateProject,
  type ProjectRecord,
  type ProjectVisibility,
} from "@/lib/projects-client";
import { t } from "@/lib/i18n";
import { visibilityChange } from "@/lib/projects-view";

type Props = {
  project: ProjectRecord;
  me: string | null;
  /** Called with the Workspace as the host now has it, after a rename or a switch. */
  onChanged: (project: ProjectRecord) => void;
  /** Called after the Workspace is archived, so the list drops it. */
  onArchived: () => void;
  onBack: () => void;
};

type TabId = "files" | "knowledge" | "instructions" | "chats";
const TABS: readonly TabId[] = ["files", "knowledge", "instructions", "chats"];

function messageOf(error: unknown): string {
  return error instanceof ProjectsError && error.message ? error.message : t("projects.saveFailed");
}

/**
 * One Workspace: its name, the Private or Workspace switch (K-D19), and its sections. Knowledge,
 * Instructions and Chats are listed and disabled until W1 brings their routes. The switch sends one
 * PATCH with the new visibility only, and the host decides who may flip it.
 */
export function ProjectsDetail({ project, me, onChanged, onArchived, onBack }: Props) {
  const [tab, setTab] = useState<TabId>("files");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isWorkspace = project.visibility === "workspace";
  const madeByYou = project.createdBy === me;

  async function applyChange(change: { name?: string; visibility?: ProjectVisibility }) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await updateProject(project.id, change));
      setRenaming(null);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function flip() {
    const change = visibilityChange(project.visibility, isWorkspace ? "private" : "workspace");
    if (change) {
      void applyChange(change);
    }
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    const name = (renaming ?? "").trim();
    if (!name || name === project.name) {
      setRenaming(null);
      return;
    }
    void applyChange({ name });
  }

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      await archiveProject(project.id);
      onArchived();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="projects-detail" data-testid="projects-detail" data-visibility={project.visibility}>
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
            <p className="projects-meta">
              {madeByYou ? t("projects.detail.madeByYou") : t("projects.detail.madeByColleague")}
            </p>
            <div className="projects-head-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setRenaming(project.name)}
                data-testid="projects-rename"
              >
                {t("projects.detail.rename")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void archive()}
                data-testid="projects-archive"
              >
                {t("projects.detail.archive")}
              </button>
            </div>
          </>
        )}
      </header>

      <div className="projects-visibility">
        <div className="projects-visibility-row">
          <span className="projects-visibility-label" id="projects-visibility-label">
            {t("projects.visibility.label")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isWorkspace}
            aria-labelledby="projects-visibility-label"
            className="projects-switch"
            disabled={busy || !madeByYou}
            onClick={flip}
            data-testid="projects-visibility"
            data-state={isWorkspace ? "workspace" : "private"}
          >
            <span className="projects-switch-track" aria-hidden="true">
              <span className="projects-switch-thumb" />
            </span>
            <span>{t(isWorkspace ? "projects.visibility.workspace" : "projects.visibility.private")}</span>
          </button>
        </div>
        <p className="projects-note" data-testid="projects-visibility-note">
          {t(isWorkspace ? "projects.visibility.noteWorkspace" : "projects.visibility.notePrivate")}
        </p>
      </div>

      {error ? (
        <p className="projects-error" role="alert" data-testid="projects-error">
          {error}
        </p>
      ) : null}

      <div className="projects-tabs" role="tablist" aria-label={t("projects.tabs.aria")}>
        {TABS.map((id) => {
          const soon = id !== "files";
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
        {tab !== "files" ? <p className="projects-status">{t("projects.tabs.comingNext")}</p> : null}
      </div>
    </section>
  );
}
