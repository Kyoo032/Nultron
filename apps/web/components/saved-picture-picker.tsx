"use client";

import { useState } from "react";
import { GalleryImage } from "@/components/gallery-media";
import { apiFetch, mediaSrc } from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { pickableSavedPictures, type SavedPicture } from "@/lib/saved-picture";

type SavedPictureListResponse = {
  items?: SavedPicture[];
  error?: { message?: string };
};

export function SavedPicturePicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (picture: SavedPicture) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pictures, setPictures] = useState<SavedPicture[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/images");
      const data = (await response.json().catch(() => ({}))) as SavedPictureListResponse;
      if (!response.ok) {
        setError(data.error?.message ?? t("videos.savedPicture.loadError"));
        return;
      }
      setPictures(pickableSavedPictures(data.items ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("videos.savedPicture.loadError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="videos-studio-saved">
      <button
        type="button"
        className="text-xs underline text-[var(--text-2)] disabled:opacity-50"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => void toggle()}
        data-testid="videos-studio-saved-open"
      >
        {open ? t("videos.savedPicture.close") : t("videos.savedPicture.open")}
      </button>
      {open ? (
        loading ? (
          <p className="text-xs text-[var(--text-3)]">{t("videos.savedPicture.loading")}</p>
        ) : error ? (
          <p className="text-xs text-[var(--danger)]" role="alert" data-testid="videos-studio-saved-error">
            {error}
          </p>
        ) : pictures.length === 0 ? (
          <p className="text-xs text-[var(--text-3)]" data-testid="videos-studio-saved-empty">
            {t("videos.savedPicture.empty")}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="videos-studio-saved-list">
            {pictures.map((picture) => (
              <li key={picture.id}>
                <button
                  type="button"
                  className="block w-full overflow-hidden rounded-lg border border-[var(--line)] disabled:opacity-50"
                  disabled={disabled}
                  onClick={() => {
                    onPick(picture);
                    setOpen(false);
                  }}
                  data-testid="videos-studio-saved-option"
                >
                  <GalleryImage
                    src={mediaSrc(picture.url)}
                    alt={picture.prompt || t("videos.savedPicture.optionAlt")}
                    missing={false}
                  />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
