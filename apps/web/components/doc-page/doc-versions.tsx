import { useState } from "react";
import { t } from "@/lib/i18n";
import type { DocVersion } from "@/lib/docs-client";
import { relativeTime, versionAuthorText, type DocPeople } from "./doc-format";

export type VersionsState = {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly items: readonly DocVersion[];
};

export type RestoreControls = {
  readonly headVersion: number;
  readonly busy: boolean;
  readonly failure: "conflict" | "failed" | null;
  readonly onRestore: (version: number) => void;
};

type Props = {
  readonly state: VersionsState;
  readonly people: DocPeople;
  readonly busy: boolean;
  readonly onDownload: (version: DocVersion) => void;
  readonly restore?: RestoreControls;
};

function RestoreAction({ version, controls }: { readonly version: number; readonly controls: RestoreControls }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-ghost doc-version-restore"
        disabled={controls.busy}
        aria-label={t("docpage.versions.restoreAria", { n: version })}
        onClick={() => setConfirming(true)}
      >
        {t("docpage.versions.restore")}
      </button>
    );
  }
  return (
    <span className="doc-version-confirm" data-testid="docpage-restore-confirm">
      <span>{t("docpage.versions.restoreConfirm", { n: version })}</span>
      <button
        type="button"
        className="btn btn-primary"
        disabled={controls.busy}
        onClick={() => {
          setConfirming(false);
          controls.onRestore(version);
        }}
      >
        {controls.busy ? t("docpage.versions.restoring") : t("docpage.versions.restoreYes")}
      </button>
      <button type="button" className="btn btn-ghost" disabled={controls.busy} onClick={() => setConfirming(false)}>
        {t("docpage.versions.cancel")}
      </button>
    </span>
  );
}

function restoreFailureText(failure: "conflict" | "failed"): string {
  return failure === "conflict" ? t("docpage.versions.restoreConflict") : t("docpage.versions.restoreFailed");
}

export function VersionsList({ state, people, busy, onDownload, restore }: Props) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <p className="doc-status" role="status">
        {t("docpage.versions.loading")}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <p className="doc-error" role="alert">
        {t("docpage.versions.failed")}
      </p>
    );
  }
  if (state.items.length === 0) {
    return <p className="doc-status">{t("docpage.versions.empty")}</p>;
  }
  const newestFirst = [...state.items].sort((left, right) => right.version - left.version);
  return (
    <>
      {restore?.failure ? (
        <p className="doc-error" role="alert" data-testid="docpage-restore-error">
          {restoreFailureText(restore.failure)}
        </p>
      ) : null}
      <ol className="doc-versions" data-testid="docpage-versions">
        {newestFirst.map((version) => (
          <li key={version.version} className="doc-version" data-testid="docpage-version">
            <span className="doc-version-number">{t("docpage.versions.number", { n: version.version })}</span>
            <span className="doc-version-what">{version.note ?? versionAuthorText(people, version.author)}</span>
            <time className="doc-version-when" dateTime={new Date(version.createdAt).toISOString()}>
              {relativeTime(version.createdAt)}
            </time>
            <button
              type="button"
              className="btn btn-ghost doc-version-download"
              disabled={busy}
              aria-label={t("docpage.versions.downloadAria", { n: version.version })}
              onClick={() => onDownload(version)}
            >
              {t("docpage.versions.download")}
            </button>
            {restore && version.version !== restore.headVersion ? (
              <RestoreAction version={version.version} controls={restore} />
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}
