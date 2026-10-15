"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { assistantNameOf, useProductBrand } from "@/lib/product-brand";
import {
  docVersionFilePath,
  fetchDocPage,
  fetchDocVersions,
  DocsError,
  type DocChange,
  type DocFormat,
  type DocPage as DocPageData,
  type DocProposal,
  type DocVersion,
} from "@/lib/docs-client";
import {
  downloadFile,
  listProjectPeople,
  listProjects,
  type ProjectAgent,
  type ProjectMember,
} from "@/lib/projects-client";
import { DocPageView, type DownloadState, type PageState, type WorkspaceRef } from "./doc-view";
import type { PanelTab } from "./doc-side-panel";
import type { RestoreControls, VersionsState } from "./doc-versions";
import { fileNameFor, primaryFormat, type DocPeople } from "./doc-format";
import { DocAskPanel, type AskDraft } from "./doc-ask-panel";
import { ProposalBlock, type ProposalAction } from "./doc-proposal-block";
import {
  GENERALIST_AGENT_ID,
  agentNameOf,
  askAgentOptions,
  askSection,
  chosenSectionId,
  discardProposal,
  keepProposal,
  pendingProposalFor,
  restoreVersion,
  withPendingProposal,
  withoutProposal,
  type ProposalFailure,
} from "./doc-proposal-flow";
import { useSectionEditing } from "@/lib/doc-section-editing";
import "./doc-page.css";

const IDLE_VERSIONS: VersionsState = { status: "idle", items: [] };
const EMPTY_DRAFT: AskDraft = { agentId: GENERALIST_AGENT_ID, sectionId: "", instruction: "" };

type Acting = { readonly proposalId: string; readonly kind: ProposalAction };

export function DocPage() {
  const { artifactId = "" } = useParams();
  const workspaceId = useSearchParams().get("workspace");
  const me = useSession().identity?.userId ?? null;
  const assistantName = assistantNameOf(useProductBrand());

  const [page, setPage] = useState<PageState>({ status: "loading" });
  const [workspace, setWorkspace] = useState<WorkspaceRef | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [agents, setAgents] = useState<ProjectAgent[]>([]);
  const [tab, setTab] = useState<PanelTab>("ask");
  const [versions, setVersions] = useState<VersionsState>(IDLE_VERSIONS);
  const [download, setDownload] = useState<DownloadState>({ busy: false, failed: false });
  const [draft, setDraft] = useState<AskDraft>(EMPTY_DRAFT);
  const [asking, setAsking] = useState(false);
  const [askFailure, setAskFailure] = useState<ProposalFailure | null>(null);
  const [instructions, setInstructions] = useState<Readonly<Record<string, string>>>({});
  const [acting, setActing] = useState<Acting | null>(null);
  const [failures, setFailures] = useState<Readonly<Record<string, ProposalFailure | null>>>({});
  const [restoring, setRestoring] = useState(false);
  const [restoreFailure, setRestoreFailure] = useState<RestoreControls["failure"]>(null);
  const requestRef = useRef(0);

  const applyDoc = useCallback(
    (next: DocPageData) => {
      if (next.artifactId === artifactId) {
        setPage({ status: "ready", doc: next });
      }
    },
    [artifactId],
  );

  const applyWrite = useCallback(
    (write: DocChange) => {
      setPage((current) =>
        current.status === "ready" && current.doc.artifactId === artifactId
          ? {
              status: "ready",
              doc: { ...current.doc, headVersion: write.headVersion, sectionAuthors: write.sectionAuthors },
            }
          : current,
      );
    },
    [artifactId],
  );

  const editing = useSectionEditing(artifactId, applyDoc, applyWrite);

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
      setAgents([]);
      return;
    }
    let cancelled = false;
    Promise.all([listProjects(), listProjectPeople(workspaceId)]).then(
      ([projects, people]) => {
        if (!cancelled) {
          const found = projects.find((project) => project.id === workspaceId);
          setWorkspace(found ? { id: found.id, name: found.name } : null);
          setMembers(people.members);
          setAgents(people.agents);
        }
      },
      () => {
        if (!cancelled) {
          setWorkspace(null);
          setMembers([]);
          setAgents([]);
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

  const readyDoc = page.status === "ready" ? page.doc : null;
  const sections = readyDoc && readyDoc.spec.kind === "document" ? readyDoc.spec.sections : [];
  const agentOptions = askAgentOptions(
    assistantName,
    agents.map((agent) => agent.agentId),
  );

  function updateDoc(update: (doc: DocPageData) => DocPageData) {
    setPage((current) => (current.status === "ready" ? { status: "ready", doc: update(current.doc) } : current));
  }

  function refreshQuietly(): Promise<void> {
    const request = ++requestRef.current;
    return fetchDocPage(artifactId).then(
      (doc) => {
        if (request === requestRef.current) {
          setPage({ status: "ready", doc });
        }
      },
      () => undefined,
    );
  }

  async function save(version: number, format: DocFormat, title: string) {
    setDownload({ busy: true, failed: false });
    try {
      await downloadFile(docVersionFilePath(artifactId, version, format), fileNameFor(title, version, format));
      setDownload({ busy: false, failed: false });
    } catch {
      setDownload({ busy: false, failed: true });
    }
  }

  function setDraftPatch(patch: Partial<AskDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function ask() {
    if (!readyDoc) {
      return;
    }
    const sectionId = chosenSectionId(
      sections.map((section) => section.id),
      draft.sectionId,
    );
    const agentId = agentOptions.some((agent) => agent.id === draft.agentId) ? draft.agentId : GENERALIST_AGENT_ID;
    const instruction = draft.instruction.trim();
    setAsking(true);
    setAskFailure(null);
    const outcome = await askSection(artifactId, sectionId, {
      agentId,
      instruction,
      baseVersion: readyDoc.headVersion,
    });
    setAsking(false);
    if (outcome.ok) {
      const proposal = outcome.value;
      updateDoc((doc) => ({ ...doc, proposals: withPendingProposal(doc.proposals, proposal) }));
      setInstructions((current) => ({ ...current, [sectionId]: instruction }));
      setFailures((current) => ({ ...current, [sectionId]: null }));
      setDraftPatch({ instruction: "" });
      return;
    }
    setAskFailure(outcome.failure);
    if (outcome.failure === "section_changed") {
      await refreshQuietly();
    }
  }

  async function keep(proposal: DocProposal) {
    setActing({ proposalId: proposal.id, kind: "keep" });
    const outcome = await keepProposal(proposal);
    setActing(null);
    if (outcome.ok) {
      updateDoc((doc) => ({ ...doc, proposals: withoutProposal(doc.proposals, proposal.id) }));
      setFailures((current) => ({ ...current, [proposal.sectionId]: null }));
      await refreshQuietly();
      return;
    }
    setFailures((current) => ({ ...current, [proposal.sectionId]: outcome.failure }));
    if (outcome.failure === "section_changed" || outcome.failure === "gone") {
      await refreshQuietly();
    }
  }

  async function undo(proposal: DocProposal) {
    setActing({ proposalId: proposal.id, kind: "undo" });
    const outcome = await discardProposal(proposal);
    setActing(null);
    if (outcome.ok) {
      updateDoc((doc) => ({ ...doc, proposals: withoutProposal(doc.proposals, proposal.id) }));
      setFailures((current) => ({ ...current, [proposal.sectionId]: null }));
      return;
    }
    setFailures((current) => ({ ...current, [proposal.sectionId]: outcome.failure }));
    if (outcome.failure === "gone") {
      await refreshQuietly();
    }
  }

  async function retry(proposal: DocProposal) {
    const instruction = instructions[proposal.sectionId];
    if (instruction === undefined || !readyDoc) {
      setDraft({ agentId: proposal.agentId, sectionId: proposal.sectionId, instruction: "" });
      setTab("ask");
      return;
    }
    setActing({ proposalId: proposal.id, kind: "retry" });
    const outcome = await askSection(artifactId, proposal.sectionId, {
      agentId: proposal.agentId,
      instruction,
      baseVersion: readyDoc.headVersion,
    });
    setActing(null);
    if (outcome.ok) {
      const next = outcome.value;
      updateDoc((doc) => ({ ...doc, proposals: withPendingProposal(doc.proposals, next) }));
      setFailures((current) => ({ ...current, [proposal.sectionId]: null }));
      return;
    }
    setFailures((current) => ({ ...current, [proposal.sectionId]: outcome.failure }));
    if (outcome.failure === "section_changed") {
      await refreshQuietly();
    }
  }

  async function restoreTo(version: number) {
    if (!readyDoc) {
      return;
    }
    setRestoring(true);
    setRestoreFailure(null);
    const outcome = await restoreVersion(artifactId, version, readyDoc.headVersion);
    setRestoring(false);
    if (outcome.ok) {
      await refreshQuietly();
      return;
    }
    setRestoreFailure(outcome.failure === "conflict" ? "conflict" : "failed");
    if (outcome.failure === "conflict") {
      await refreshQuietly();
    }
  }

  const askPanel = readyDoc ? (
    <DocAskPanel
      kind={readyDoc.kind}
      sections={sections}
      agents={agentOptions}
      draft={draft}
      working={asking}
      failure={askFailure}
      onDraft={setDraftPatch}
      onSubmit={() => void ask()}
    />
  ) : undefined;

  const renderSectionActions =
    readyDoc && readyDoc.spec.kind === "document"
      ? (sectionId: string) => {
          const proposal = pendingProposalFor(readyDoc.proposals, sectionId);
          const section = sections.find((candidate) => candidate.id === sectionId);
          if (!proposal || !section) {
            return null;
          }
          return (
            <ProposalBlock
              proposal={proposal}
              current={section}
              agentName={agentNameOf(proposal.agentId, assistantName)}
              people={people}
              busy={acting && acting.proposalId === proposal.id ? acting.kind : null}
              failure={failures[sectionId] ?? null}
              onKeep={() => void keep(proposal)}
              onUndo={() => void undo(proposal)}
              onRetry={() => void retry(proposal)}
            />
          );
        }
      : undefined;

  const restore: RestoreControls | undefined = readyDoc
    ? {
        headVersion: readyDoc.headVersion,
        busy: restoring,
        failure: restoreFailure,
        onRestore: (version) => void restoreTo(version),
      }
    : undefined;

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
      agentPanel={askPanel}
      renderSectionActions={renderSectionActions}
      restore={restore}
      editing={readyDoc && readyDoc.spec.kind === "document" ? editing : undefined}
    />
  );
}
