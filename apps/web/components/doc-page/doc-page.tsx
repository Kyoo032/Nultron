"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "@/lib/nav";
import { useSession } from "@/lib/session";
import {
  docVersionFilePath,
  fetchDocPage,
  fetchDocVersions,
  DocsError,
  type DocFormat,
  type DocVersion,
} from "@/lib/docs-client";
import { downloadFile, listProjectPeople, listProjects, type ProjectMember } from "@/lib/projects-client";
import { DocPageView, type DownloadState, type PageState, type WorkspaceRef } from "./doc-view";
import type { PanelTab } from "./doc-side-panel";
import type { VersionsState } from "./doc-versions";
import { fileNameFor, primaryFormat, type DocPeople } from "./doc-format";
import "./doc-page.css";

const IDLE_VERSIONS: VersionsState = { status: "idle", items: [] };

export function DocPage() {
  const { artifactId = "" } = useParams();
  const workspaceId = useSearchParams().get("workspace");
  const me = useSession().identity?.userId ?? null;

  const [page, setPage] = useState<PageState>({ status: "loading" });
  const [workspace, setWorkspace] = useState<WorkspaceRef | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [tab, setTab] = useState<PanelTab>("ask");
  const [versions, setVersions] = useState<VersionsState>(IDLE_VERSIONS);
  const [download, setDownload] = useState<DownloadState>({ busy: false, failed: false });
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const request = ++requestRef.current;
    setPage({ status: "loading" });
    fetchDocPage(artifactId).then(
      (doc) => {
        if (request === requestRef.current) {
          setPage({ status: "ready", doc });
        }
      },
      (error: unknown) => {
        if (request === requestRef.current) {
          setPage({ status: "failed", error: error instanceof DocsError ? error : null });
        }
      },
    );
  }, [artifactId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspace(null);
      setMembers([]);
      return;
    }
    let cancelled = false;
    Promise.all([listProjects(), listProjectPeople(workspaceId)]).then(
      ([projects, people]) => {
        if (!cancelled) {
          const found = projects.find((project) => project.id === workspaceId);
          setWorkspace(found ? { id: found.id, name: found.name } : null);
          setMembers(people.members);
        }
      },
      () => {
        if (!cancelled) {
          setWorkspace(null);
          setMembers([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const headVersion = page.status === "ready" ? page.doc.headVersion : null;

  useEffect(() => {
    if (tab !== "versions" || headVersion === null) {
      return;
    }
    let cancelled = false;
    setVersions({ status: "loading", items: [] });
    fetchDocVersions(artifactId).then(
      (items) => {
        if (!cancelled) {
          setVersions({ status: "ready", items });
        }
      },
      () => {
        if (!cancelled) {
          setVersions({ status: "failed", items: [] });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab, artifactId, headVersion]);

  const people: DocPeople = {
    me,
    nameOf: (userId) => members.find((member) => member.userId === userId)?.name ?? null,
  };

  async function save(version: number, format: DocFormat, title: string) {
    setDownload({ busy: true, failed: false });
    try {
      await downloadFile(docVersionFilePath(artifactId, version, format), fileNameFor(title, version, format));
      setDownload({ busy: false, failed: false });
    } catch {
      setDownload({ busy: false, failed: true });
    }
  }

  return (
    <DocPageView
      page={page}
      people={people}
      workspace={workspace}
      tab={tab}
      onTab={setTab}
      versions={versions}
      download={download}
      onDownload={(format) => {
        if (page.status === "ready") {
          void save(page.doc.headVersion, format, page.doc.title);
        }
      }}
      onDownloadVersion={(version: DocVersion) => {
        if (page.status === "ready") {
          void save(version.version, primaryFormat(version.kind), page.doc.title);
        }
      }}
      onRetry={load}
    />
  );
}
