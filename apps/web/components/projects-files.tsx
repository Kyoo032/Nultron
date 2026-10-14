"use client";

import { useCallback, useEffect, useState } from "react";
import { ModeIcon } from "@/components/mode-icons";
import { mediaSrc } from "@/lib/api-client";
import {
  downloadFile,
  listProjectFiles,
  ProjectsError,
  removeProjectFile,
  removeProjectMedia,
  type ProjectFile,
  type ProjectRecord,
} from "@/lib/projects-client";
import { canRemoveFile, fileIconName, fileKind, formatBytes } from "@/lib/projects-view";
import { t } from "@/lib/i18n";

type Props = {
  project: ProjectRecord;
  me: string | null;
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ProjectsError && error.message ? error.message : fallback;
}

/** A generated picture or clip shows inline; a chat file shows as its icon and meta only (SR-175). */
function FilePreview({ file }: { file: ProjectFile }) {
  if (!file.previewUrl) {
    return null;
  }
  const src = mediaSrc(file.previewUrl);
  if (file.kind === "video") {
    return (
      <video
        src={src}
        controls
        preload="metadata"
        className="projects-file-preview"
        aria-label={t("projects.files.previewAlt", { name: file.title })}
        data-testid="projects-file-video"
      />
    );
  }
  return (
    <img
      src={src}
      alt={t("projects.files.previewAlt", { name: file.title })}
      loading="lazy"
      className="projects-file-preview"
      data-testid="projects-file-image"
    />
  );
}

/**
 * The Files tab of one Workspace. The list comes from the host, which already filters it to what this
 * person may see. Remove is offered only to the file's maker or the Workspace's maker; the host still
 * decides, and its sentence is shown when it refuses. Every row, a picture or a video included, downloads
 * through its own `downloadUrl`, which the host names as an attachment.
 */
export function ProjectFiles({ project, me }: Props) {
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setFiles(await listProjectFiles(project.id));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught, t("projects.files.loadFailed")));
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function download(file: ProjectFile) {
    setBusyId(file.id);
    setError(null);
    try {
      await downloadFile(file.downloadUrl, file.title);
    } catch (caught) {
      setError(messageOf(caught, t("projects.files.downloadFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(file: ProjectFile) {
    setBusyId(file.id);
    setError(null);
    try {
      if (file.kind === "artifact") {
        await removeProjectFile(project.id, file.id);
      } else {
        await removeProjectMedia(project.id, file.id);
      }
      await reload();
    } catch (caught) {
      setError(messageOf(caught, t("projects.files.removeFailed")));
    } finally {
      setBusyId(null);
    }
  }

  if (files === null) {
    return (
      <p className="projects-status" role="status">
        {error ?? t("projects.loading")}
      </p>
    );
  }

  return (
    <div className="projects-files" data-testid="projects-files">
      {error ? (
        <p className="projects-error" role="alert" data-testid="projects-files-error">
          {error}
        </p>
      ) : null}
      {files.length === 0 ? <p className="projects-status">{t("projects.files.empty")}</p> : null}
      {files.length > 0 ? (
        <ul className="projects-file-list" data-testid="projects-file-list">
          {files.map((file) => (
            <li
              key={file.id}
              className="projects-file"
              data-testid="projects-file"
              data-artifact-id={file.id}
              data-kind={file.kind}
            >
              <span className="projects-file-icon" aria-hidden="true">
                <ModeIcon name={fileIconName(file.mime)} size={18} />
              </span>
              <span className="projects-file-main">
                <span className="projects-file-title">{file.title}</span>
                <span className="projects-file-meta">
                  <span>{t(`projects.kinds.${fileKind(file.mime)}`)}</span>
                  <span>{file.ownerUserId === me ? t("projects.files.you") : t("projects.files.colleague")}</span>
                  <span>{new Date(file.updatedAt).toLocaleDateString()}</span>
                  <span>{formatBytes(file.sizeBytes)}</span>
                </span>
                <FilePreview file={file} />
              </span>
              <span className="projects-file-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busyId === file.id}
                  aria-label={t("projects.files.download", { name: file.title })}
                  onClick={() => void download(file)}
                >
                  {t("projects.files.downloadLabel")}
                </button>
                {canRemoveFile(file, project, me) ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busyId === file.id}
                    onClick={() => void remove(file)}
                  >
                    {t("projects.files.remove")}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
