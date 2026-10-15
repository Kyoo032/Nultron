import type { ReactNode } from "react";
import { Link } from "@/lib/nav";
import { t } from "@/lib/i18n";
import type { DocFormat, DocPage, DocsError, DocVersion } from "@/lib/docs-client";
import { DocBody, type SectionActions } from "./doc-body";
import { DownloadMenu } from "./doc-download-menu";
import { type DocPeople, failureKind, primaryFormat } from "./doc-format";
import { SidePanel, type PanelTab } from "./doc-side-panel";
import { VersionsList, type RestoreControls, type VersionsState } from "./doc-versions";

export type PageState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: DocsError | null }
  | { readonly status: "ready"; readonly doc: DocPage };

export type DownloadState = { readonly busy: boolean; readonly failed: boolean };

export type WorkspaceRef = { readonly id: string; readonly name: string };

type Props = {
  readonly page: PageState;
  readonly people: DocPeople;
  readonly workspace: WorkspaceRef | null;
  readonly tab: PanelTab;
  readonly onTab: (tab: PanelTab) => void;
  readonly versions: VersionsState;
  readonly download: DownloadState;
  readonly onDownload: (format: DocFormat) => void;
  readonly onDownloadVersion: (version: DocVersion) => void;
  readonly onRetry: () => void;
  readonly agentPanel?: ReactNode;
  readonly renderSectionActions?: SectionActions;
  readonly restore?: RestoreControls;
};

const FORMAT_LABEL_KEY: Readonly<Record<DocFormat, string>> = {
  docx: "docpage.format.docx",
  pdf: "docpage.format.pdf",
  xlsx: "docpage.format.xlsx",
};

const FAILURE_KEY = {
  not_found: "docpage.notFound",
  not_editable: "docpage.notEditable",
  failed: "docpage.loadFailed",
} as const;

function BackLink({ workspace }: { readonly workspace: WorkspaceRef | null }) {
  if (workspace) {
    return (
      <Link to="/projects" className="doc-back" data-testid="docpage-back">
        ← {t("docpage.back.workspace", { name: workspace.name })}
      </Link>
    );
  }
  return (
    <Link to="/chat" className="doc-back" data-testid="docpage-back">
      ← {t("docpage.back.chat")}
    </Link>
  );
}

function ReadyView({
  doc,
  people,
  workspace,
  tab,
  onTab,
  versions,
  download,
  onDownload,
  onDownloadVersion,
  agentPanel,
  renderSectionActions,
  restore,
}: Omit<Props, "page" | "onRetry"> & { readonly doc: DocPage }) {
  const formatKey = FORMAT_LABEL_KEY[primaryFormat(doc.kind)];
  return (
    <>
      <div className="doc-head-bar">
        <BackLink workspace={workspace} />
        <span className="doc-badge" data-testid="docpage-format">
          {t(formatKey)}
        </span>
        <div className="doc-head-text">
          <p className="doc-head-title" data-testid="docpage-title">
            {doc.title}
          </p>
          <p className="doc-head-meta">
            {workspace ? <span data-testid="docpage-workspace">{workspace.name}</span> : null}
            {workspace ? " · " : null}
            <span data-testid="docpage-version">{t("docpage.version", { n: doc.headVersion })}</span>
          </p>
        </div>
        <div className="doc-head-actions">
          <DownloadMenu kind={doc.kind} busy={download.busy} onPick={onDownload} />
        </div>
      </div>
      {download.failed ? (
        <p className="doc-error doc-error-bar" role="alert" data-testid="docpage-download-error">
          {t("docpage.downloadFailed")}
        </p>
      ) : null}
      <div className="doc-layout" data-testid="docpage-layout">
        <div className="doc-main">
          <DocBody doc={doc} people={people} renderSectionActions={renderSectionActions} />
        </div>
        <SidePanel
          tab={tab}
          onTab={onTab}
          askPanel={
            <div className="doc-agent-slot" data-slot="agent-panel">
              {agentPanel ?? <p className="doc-status">{t("docpage.ask.placeholder")}</p>}
            </div>
          }
          versionsPanel={
            <VersionsList
              state={versions}
              people={people}
              busy={download.busy}
              onDownload={onDownloadVersion}
              restore={restore}
            />
          }
        />
      </div>
    </>
  );
}

export function DocPageView(props: Props) {
  const { page } = props;
  return (
    <main className="doc-page" data-testid="docpage" data-state={page.status}>
      {page.status === "ready" ? (
        <ReadyView
          doc={page.doc}
          people={props.people}
          workspace={props.workspace}
          tab={props.tab}
          onTab={props.onTab}
          versions={props.versions}
          download={props.download}
          onDownload={props.onDownload}
          onDownloadVersion={props.onDownloadVersion}
          agentPanel={props.agentPanel}
          renderSectionActions={props.renderSectionActions}
          restore={props.restore}
        />
      ) : (
        <div className="doc-head-bar">
          <BackLink workspace={props.workspace} />
        </div>
      )}
      {page.status === "loading" ? (
        <p className="doc-status" role="status" data-testid="docpage-loading">
          {t("docpage.loading")}
        </p>
      ) : null}
      {page.status === "failed" ? <FailedView error={page.error} onRetry={props.onRetry} /> : null}
    </main>
  );
}

function FailedView({ error, onRetry }: { readonly error: DocsError | null; readonly onRetry: () => void }) {
  const kind = failureKind(error);
  return (
    <div className="doc-failed" data-testid="docpage-failed" data-reason={kind}>
      <p className="doc-error" role="alert">
        {t(FAILURE_KEY[kind])}
      </p>
      {kind === "failed" ? (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {t("docpage.retry")}
        </button>
      ) : null}
    </div>
  );
}
