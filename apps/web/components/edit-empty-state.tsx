"use client";

import { STARTER_PROJECTS } from "@agentforge/core/edit";
import type { CSSProperties } from "react";
import { ModeIllustration } from "@/components/mode-illustration";
import type { EditProjectRow } from "@/lib/edit-client";
import { t } from "@/lib/i18n";

type Props = {
  items: EditProjectRow[];
  starterId: string;
  projectName: string;
  onStarter: (id: string) => void;
  onProjectName: (name: string) => void;
  onNewProject: () => void;
  onOpen: (id: string) => void;
};

/**
 * What Edit shows before a project is open: the project list, and the editor's three parts as quiet
 * placeholders (preview, timeline, agent).
 *
 * The layout answers to the pane's width, not the window's: the pane is the window minus the rail, and
 * a phone, a narrow desktop window and an open rail are all the same problem. The pane is a size
 * container with three layouts:
 *   - under 40rem: one column, list first, then the placeholders, and the pane scrolls;
 *   - 40rem to 64rem: the list beside one 16rem column that stacks preview, timeline and agent;
 *   - 64rem and up: the list, a 20rem preview column and the 17.5rem agent column.
 * The list is the only part with a job, so it takes whatever the placeholders leave. The testids are
 * the same in all three: the verify recipe and the e2e spec look for each of them once.
 */
export function EditEmptyState({
  items,
  starterId,
  projectName,
  onStarter,
  onProjectName,
  onNewProject,
  onOpen,
}: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [container-type:inline-size]">
      <div className="flex flex-col [@container(min-width:40rem)]:min-h-0 [@container(min-width:40rem)]:flex-1 [@container(min-width:40rem)]:flex-row">
        <div
          className="flex flex-col overflow-y-auto p-4 [@container(min-width:40rem)]:min-w-0 [@container(min-width:40rem)]:flex-1 [@container(min-width:40rem)]:p-6"
          data-testid="edit-project-list"
        >
          <h2 className="font-heading text-xl">{t("edit.projects")}</h2>
          <div className="mt-4 flex flex-col gap-2">
            <select
              className="w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"
              value={starterId}
              onChange={(event) => onStarter(event.target.value)}
              data-testid="edit-starter"
            >
              {STARTER_PROJECTS.map((starter) => (
                <option key={starter.id} value={starter.id}>
                  {starter.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--text-2)]" data-testid="edit-starter-description">
              {STARTER_PROJECTS.find((starter) => starter.id === starterId)?.description ?? ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                className="min-w-[9rem] flex-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"
                value={projectName}
                onChange={(event) => onProjectName(event.target.value)}
                aria-label={t("edit.projectNameLabel")}
                data-testid="edit-project-name"
              />
              <button
                type="button"
                className="btn btn-primary shrink-0 px-3 py-2 text-sm"
                data-testid="edit-new-project"
                onClick={onNewProject}
              >
                {t("edit.newProject")}
              </button>
            </div>
          </div>
          <ul className="mt-4 space-y-2">
            {items.map((item, index) => (
              <li key={item.id} className="enter-rise" style={{ "--i": index } as CSSProperties}>
                <button
                  type="button"
                  className="card-live w-full px-3 py-2 text-left text-sm"
                  onClick={() => onOpen(item.id)}
                >
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 flex-col border-t border-[var(--line)] [@container(min-width:40rem)]:w-64 [@container(min-width:40rem)]:overflow-y-auto [@container(min-width:40rem)]:border-l [@container(min-width:40rem)]:border-t-0 [@container(min-width:64rem)]:w-auto [@container(min-width:64rem)]:flex-row [@container(min-width:64rem)]:overflow-visible">
          <div className="flex flex-col gap-3 p-4 [@container(min-width:64rem)]:w-80 [@container(min-width:64rem)]:shrink-0 [@container(min-width:64rem)]:border-r [@container(min-width:64rem)]:border-[var(--line)]">
            <div
              className="aspect-video w-full max-w-sm rounded-md border border-dashed border-[var(--line)] bg-[var(--surface)] [@container(min-width:64rem)]:aspect-auto [@container(min-width:64rem)]:min-h-0 [@container(min-width:64rem)]:max-w-none [@container(min-width:64rem)]:flex-1"
              data-testid="edit-preview"
              aria-hidden="true"
            />
            <div
              className="h-16 w-full max-w-sm rounded-md border border-dashed border-[var(--line)] bg-[var(--surface)] [@container(min-width:64rem)]:h-24 [@container(min-width:64rem)]:max-w-none"
              data-testid="edit-timeline"
              aria-hidden="true"
            />
          </div>
          <aside
            className="[@container(min-width:64rem)]:w-[280px] [@container(min-width:64rem)]:shrink-0"
            data-testid="edit-agent-panel"
          >
            <div className="flex flex-col items-center px-4 py-8 text-center">
              <ModeIllustration mode="edit" />
              <p className="mt-4 text-xs text-[var(--text-3)]">{t("edit.openProjectHint")}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
