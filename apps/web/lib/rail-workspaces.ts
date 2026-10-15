import { useEffect, useState } from "react";
import { subscribeToWrites } from "@/lib/api-client";
import { listProjects } from "@/lib/projects-client";

export type RailWorkspace = { id: string; name: string; memberCount: number };

export type RailWorkspacesState = { items: readonly RailWorkspace[]; loaded: boolean };

export const WORKSPACE_TONES = 6;

export const WORKSPACES_PAGE_PATH = "/projects";

export function workspaceTone(id: string): number {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % WORKSPACE_TONES;
}

export function workspaceInitial(name: string): string {
  const first = name.trim().codePointAt(0);
  return first === undefined ? "?" : String.fromCodePoint(first).toUpperCase();
}

export function railWorkspaceHref(id: string): string {
  return `${WORKSPACES_PAGE_PATH}?open=${encodeURIComponent(id)}`;
}

export function onWorkspacesPage(pathname: string): boolean {
  return pathname === WORKSPACES_PAGE_PATH || pathname.startsWith(`${WORKSPACES_PAGE_PATH}/`);
}

export function activeWorkspaceIdOf(pathname: string, searchParams: URLSearchParams): string | null {
  return onWorkspacesPage(pathname) ? searchParams.get("open") : null;
}

const EMPTY: RailWorkspacesState = { items: [], loaded: false };

export function useRailWorkspaces(enabled: boolean, pathname: string): RailWorkspacesState | null {
  const [state, setState] = useState<RailWorkspacesState>(EMPTY);
  const onPage = onWorkspacesPage(pathname);
  const scope = onPage ? pathname : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` reloads the list when the person enters, moves within or leaves the Workspaces page
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let alive = true;
    let latest = 0;
    const load = () => {
      latest += 1;
      const mine = latest;
      listProjects().then(
        (rows) => {
          if (alive && mine === latest) {
            setState({ items: rows.map(({ id, name, memberCount }) => ({ id, name, memberCount })), loaded: true });
          }
        },
        () => {
          if (alive && mine === latest) {
            setState((current) => ({ items: current.items, loaded: true }));
          }
        },
      );
    };
    load();
    if (!onPage) {
      return () => {
        alive = false;
      };
    }
    const stop = subscribeToWrites(load);
    return () => {
      alive = false;
      stop();
    };
  }, [enabled, onPage, scope]);

  return enabled ? state : null;
}
