"use client";

import { attachmentNotes, type PickerModelLike } from "@/lib/composer-image-support";
import type { AttachmentKind } from "@/lib/composer-attach";
import { t } from "@/lib/i18n";

type Props = {
  kinds: readonly AttachmentKind[];
  model: string | undefined;
  models: readonly PickerModelLike[];
  /** Picks the model the note offers. Absent on a composer with no model picker: the note then offers none. */
  onSwitch?: (id: string) => void;
};

/**
 * Said under the attachment chips, before Send, so the person never learns from a confused answer that
 * the picture did not reach the model.
 *
 * - `composer-image-note`, `data-state="no"`: the model is known to be text-only. Send is refused; the
 *   button (`composer-image-switch`) moves the picker to the best model that reads images.
 * - `data-state="unknown"`: nobody has confirmed the model reads images. The image is sent anyway and a
 *   refusal from the gateway is shown as one.
 * - `composer-video-note`: no model in Chat receives video yet, whichever one is picked.
 */
export function ComposerAttachmentNotes({ kinds, model, models, onSwitch }: Props) {
  const notes = attachmentNotes({ kinds, model, models });
  if (notes.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="composer-attachment-notes">
      {notes.map((note) =>
        note.kind === "video" ? (
          <p key="video" className="text-sm text-[var(--text-2)]" data-testid="composer-video-note" role="status">
            {t("chat.composer.videoNote")}
          </p>
        ) : (
          <p
            key="image"
            className={`text-sm ${note.support === "no" ? "text-[var(--danger)]" : "text-[var(--text-2)]"}`}
            data-testid="composer-image-note"
            data-state={note.support}
            role="status"
          >
            {t(note.support === "no" ? "chat.composer.imageNote.no" : "chat.composer.imageNote.unknown", {
              model: note.modelName,
            })}{" "}
            {note.alternative && onSwitch ? (
              <button
                type="button"
                className="underline underline-offset-2 hover:text-[var(--text)]"
                data-testid="composer-image-switch"
                data-model={note.alternative.id}
                onClick={() => onSwitch(note.alternative?.id ?? "")}
              >
                {t("chat.composer.imageNote.switch", { model: note.alternative.name })}
              </button>
            ) : null}
          </p>
        ),
      )}
    </div>
  );
}
