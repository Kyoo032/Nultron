"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ModeHeader } from "@/components/mode-header";
import { ProjectsDetail } from "@/components/projects-detail";
import { createProject, listProjects, ProjectsError, type ProjectRecord } from "@/lib/projects-client";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { splitProjects } from "@/lib/projects-view";
import "./projects.css";

/**
 * The Workspaces page (team-board-spec.md section 2b, K-D20). Server mode only: App.tsx routes
 * `/projects` on a hosted build alone. The list is what the host returns; the page splits it into the
 * Workspaces the person owns and the ones others shared with them (K-D22). Opening one shows its detail view.
 */
export function ProjectsPage() {
  const me = useSession().identity?.userId ?? null;
  const [items, setItems] = useState<ProjectRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await listProjects());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const text = name.trim();
    if (!text) {
      return;
    }
    setError(null);
    try {
      const project = await createProject(text);
      setName("");
      setItems((current) => [project, ...(current ?? [])]);
      setOpenId(project.id);
    } catch (caught) {
      setError(caught instanceof ProjectsError && caught.message ? caught.message : t("projects.saveFailed"));
    }
  }

  const open = items?.find((project) => project.id === openId) ?? null;

  return (
    <main className="projects-page" data-testid="projects-page" data-mode="projects">
      {open ? (
        <ProjectsDetail
          project={open}
          me={me}
          onChanged={(project) =>
            setItems((current) => (current ?? []).map((row) => (row.id === project.id ? project : row)))
          }
          onRefresh={() => void reload()}
          onGone={() => {
            setOpenId(null);
            void reload();
          }}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <>
          <ModeHeader
            icon="workspaces"
            title={t("projects.title")}
            outcomeTestId="projects-intro"
            outcome={t("projects.intro")}
          />

          {error ? (
            <p className="projects-error" role="alert" data-testid="projects-create-error">
              {error}
            </p>
          ) : null}

          <form className="projects-inline-form projects-create" onSubmit={create}>
            <input
              className="input"
              value={name}
              maxLength={120}
              placeholder={t("projects.create.namePlaceholder")}
              aria-label={t("projects.create.label")}
              onChange={(event) => setName(event.target.value)}
              data-testid="projects-create-input"
            />
            <button type="submit" className="btn btn-primary" disabled={!name.trim()} data-testid="projects-create">
              {t("projects.create.submit")}
            </button>
          </form>

          {items === null ? (
            <p className="projects-status" role="status">
              {loadFailed ? t("projects.loadFailed") : t("projects.loading")}
            </p>
          ) : null}
          {loadFailed && items === null ? (
            <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
              {t("projects.retry")}
            </button>
          ) : null}

          {items !== null ? <ProjectList items={items} onOpen={setOpenId} /> : null}
        </>
      )}
    </main>
  );
}

function ProjectList({ items, onOpen }: { items: ProjectRecord[]; onOpen: (id: string) => void }) {
  if (items.length === 0) {
    return <p className="projects-status">{t("projects.list.empty")}</p>;
  }
  const { own, shared } = splitProjects(items);
  return (
    <div className="projects-groups" data-testid="projects-list">
      {own.length > 0 ? <ProjectGroup heading={t("projects.list.own")} rows={own} onOpen={onOpen} /> : null}
      {shared.length > 0 ? <ProjectGroup heading={t("projects.list.shared")} rows={shared} onOpen={onOpen} /> : null}
    </div>
  );
}

/** "Only you" for a Workspace of one, else how many people are in it. */
export function memberLine(project: Pick<ProjectRecord, "memberCount">): string {
  return project.memberCount <= 1
    ? t("projects.list.onlyYou")
    : t("projects.list.memberCount", { count: project.memberCount });
}

function ProjectGroup({
  heading,
  rows,
  onOpen,
}: {
  heading: string;
  rows: ProjectRecord[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="projects-group">
      <h3 className="projects-group-title">{heading}</h3>
      <ul className="projects-rows">
        {rows.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className="projects-row"
              onClick={() => onOpen(project.id)}
              aria-label={t("projects.list.open", { name: project.name })}
              data-testid="projects-row"
              data-role={project.role}
            >
              <span className="projects-row-name">{project.name}</span>
              <span className="projects-row-meta">{memberLine(project)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
