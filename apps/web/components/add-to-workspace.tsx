"use client";

import { useState, type FormEvent } from "react";
import { t } from "@/lib/i18n";
import { isHostedBuild } from "@/lib/hosted-build";
import { addProjectFile, createProject, listProjects, ProjectsError, type ProjectRecord } from "@/lib/projects-client";

type Props = {
  /** The chat file's artifact id: the same id the Download button saves. */
  readonly artifactId: string;
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ProjectsError && error.message ? error.message : fallback;
}

/**
 * "Add to Workspace" on a file a chat answer made (team-board-spec.md section 2b, W2). A small menu of
 * the person's Workspaces, plus "New Workspace…". Hosted only: on Personal it draws nothing. The host
 * decides whether the file may be added; a refusal shows its own sentence.
 */
export function AddToWorkspace({ artifactId }: Props) {
  if (!isHostedBuild()) {
    return null;
  }
  return <AddToWorkspaceMenu artifactId={artifactId} />;
}

function AddToWorkspaceMenu({ artifactId }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    setNote(null);
    if (next && projects === null) {
      try {
        setProjects(await listProjects());
      } catch (caught) {
        setNote({ tone: "error", text: messageOf(caught, t("projects.addTo.failed")) });
      }
    }
  }

  async function addTo(project: ProjectRecord) {
    setBusy(true);
    setNote(null);
    try {
      await addProjectFile(project.id, artifactId);
      setNote({ tone: "ok", text: t("projects.addTo.added", { name: project.name }) });
      setOpen(false);
    } catch (caught) {
      setNote({ tone: "error", text: messageOf(caught, t("projects.addTo.failed")) });
    } finally {
      setBusy(false);
    }
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    const text = name.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const project = await createProject(text);
      setName("");
      setProjects((current) => [project, ...(current ?? [])]);
      await addProjectFile(project.id, artifactId);
      setNote({ tone: "ok", text: t("projects.addTo.added", { name: project.name }) });
      setOpen(false);
    } catch (caught) {
      setNote({ tone: "error", text: messageOf(caught, t("projects.addTo.failed")) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" data-testid="add-to-workspace">
      <button
        type="button"
        className="btn btn-secondary"
        aria-expanded={open}
        onClick={() => void toggle()}
        data-testid="add-to-workspace-open"
      >
        {t("projects.addTo.label")}
      </button>
      {open ? (
        <div
          className="mt-2 min-w-[220px] space-y-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-2 shadow-elev-1"
          role="menu"
          aria-label={t("projects.addTo.title")}
          data-testid="add-to-workspace-menu"
        >
          {projects === null ? <p className="px-2 text-xs text-[var(--text-2)]">{t("projects.loading")}</p> : null}
          {projects !== null && projects.length === 0 ? (
            <p className="px-2 text-xs text-[var(--text-2)]">{t("projects.addTo.none")}</p>
          ) : null}
          {(projects ?? []).map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitem"
              className="block w-full truncate rounded px-2 py-1 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-2)]"
              disabled={busy}
              onClick={() => void addTo(project)}
              data-testid="add-to-workspace-item"
            >
              {project.name}
            </button>
          ))}
          <form className="flex gap-2 px-1" onSubmit={createAndAdd}>
            <input
              className="input min-w-0 flex-1"
              value={name}
              maxLength={120}
              placeholder={t("projects.create.namePlaceholder")}
              aria-label={t("projects.addTo.newWorkspace")}
              onChange={(event) => setName(event.target.value)}
              data-testid="add-to-workspace-name"
            />
            <button type="submit" className="btn btn-ghost" disabled={busy || !name.trim()}>
              {t("projects.create.submit")}
            </button>
          </form>
        </div>
      ) : null}
      {note ? (
        <p
          className={`mt-2 text-xs ${note.tone === "error" ? "text-[var(--danger)]" : "text-[var(--text-2)]"}`}
          role={note.tone === "error" ? "alert" : "status"}
          data-testid={note.tone === "error" ? "add-to-workspace-error" : "add-to-workspace-status"}
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
