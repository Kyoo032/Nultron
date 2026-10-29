export type SavedPicture = {
  id: string;
  url: string;
  prompt?: string;
  fileMissing?: boolean;
};

export function savedPictureReference(id: string): string {
  return `/api/v1/media/${id}/file`;
}

export function pickableSavedPictures(items: readonly SavedPicture[]): SavedPicture[] {
  return items.filter((item) => item.fileMissing !== true);
}

export function stillSource(
  picked: Pick<SavedPicture, "id"> | null,
  typed: string,
  imageToVideo: boolean,
): string | undefined {
  if (!imageToVideo) {
    return undefined;
  }
  if (picked) {
    return savedPictureReference(picked.id);
  }
  return typed.trim() || undefined;
}
