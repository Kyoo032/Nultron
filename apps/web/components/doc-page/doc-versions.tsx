import { t } from "@/lib/i18n";
import type { DocVersion } from "@/lib/docs-client";
import { relativeTime, versionAuthorText, type DocPeople } from "./doc-format";

export type VersionsState = {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly items: readonly DocVersion[];
};

type Props = {
  readonly state: VersionsState;
  readonly people: DocPeople;
  readonly busy: boolean;
  readonly onDownload: (version: DocVersion) => void;
};

export function VersionsList({ state, people, busy, onDownload }: Props) {
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
        </li>
      ))}
    </ol>
  );
}
