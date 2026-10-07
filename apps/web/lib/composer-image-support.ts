import { modelImageInput } from "@agentforge/core/image-input";
import { chooseDefaultModel } from "@agentforge/core/preferred";
import type { AttachmentKind } from "./composer-attach";
import { t } from "./i18n";

/**
 * What the composer says about an attachment before the person presses Send.
 *
 * The rule for which model reads images is `modelImageInput`, the same one the host uses to refuse
 * and to build the request, so the chip and the host cannot disagree. Not the cached list's
 * `inputModalities`: that was written by the old prefix table, and a desk keeps it until its next
 * model refresh.
 *
 * `no` is a model the app knows is text-only. `unknown` is a model it has no line for: the image is
 * sent, and the person is told nobody confirmed it reads one.
 */

export type PickerModelLike = { id: string; label: string; friendlyLabel?: string; inputModalities?: string[] };

export type SwitchTarget = { id: string; name: string };

export type AttachmentNote =
  | { kind: "image"; support: "no" | "unknown"; modelName: string; alternative: SwitchTarget | null }
  | { kind: "video" };

function nameOf(model: PickerModelLike): string {
  return model.friendlyLabel ?? model.label;
}

/** A model's name as the picker shows it, or its id when the list has not loaded it. */
export function modelNameFor(id: string, models: readonly PickerModelLike[]): string {
  const found = models.find((model) => model.id === id);
  return found ? nameOf(found) : id;
}

/**
 * The model to offer in place of one that cannot read images: the best that is known to, by the same
 * order the Chat default uses (`chooseDefaultModel`), from the models this desk lists.
 */
export function bestImageModel(models: readonly PickerModelLike[], excludeId?: string): SwitchTarget | null {
  const readers = models.filter((model) => model.id !== excludeId && modelImageInput(model.id) === "yes");
  if (readers.length === 0) {
    return null;
  }
  const id = chooseDefaultModel(readers, undefined, "");
  const picked = readers.find((model) => model.id === id);
  return picked ? { id: picked.id, name: nameOf(picked) } : null;
}

export function attachmentNotes(input: {
  kinds: readonly AttachmentKind[];
  model: string | undefined;
  models: readonly PickerModelLike[];
}): AttachmentNote[] {
  const notes: AttachmentNote[] = [];
  const model = input.model?.trim();
  if (model && input.kinds.includes("image")) {
    const support = modelImageInput(model);
    if (support !== "yes") {
      notes.push({
        kind: "image",
        support,
        modelName: modelNameFor(model, input.models),
        alternative: bestImageModel(input.models, model),
      });
    }
  }
  if (input.kinds.includes("video")) {
    notes.push({ kind: "video" });
  }
  return notes;
}

/**
 * The input tags the picker prints beside a model. "image" follows `modelImageInput` whenever it has an
 * answer: the list the host cached was written by an older prefix table, which tagged GLM 5.3 "image"
 * and GPT 6 not at all. A model it has no line for keeps what the host's list says.
 */
export function inputTags(model: { id: string; inputModalities: string[] }): string[] {
  const support = modelImageInput(model.id);
  const image = support === "yes" || (support === "unknown" && model.inputModalities.includes("image"));
  const others = model.inputModalities.filter((modality) => modality !== "text" && modality !== "image");
  return image ? ["image", ...others] : others;
}

/**
 * The modalities Chat offers for the model on screen. Text and video follow the host's list for the
 * model; image follows `modelImageInput`, which never refuses a model it has no line for.
 */
export function chatModalities(
  agentModalities: readonly string[],
  selected: { id: string; inputModalities: string[] } | undefined,
): string[] {
  const listed = selected?.inputModalities ?? ["text"];
  return ["text", "image", "video"].filter((modality) => {
    if (!agentModalities.includes(modality)) {
      return false;
    }
    if (modality === "image") {
      return selected !== undefined && modelImageInput(selected.id) !== "no";
    }
    return listed.includes(modality);
  });
}

/** The sentence for a send refused because the model cannot read images. */
export function imageRefusalMessage(model: string | undefined, models: readonly PickerModelLike[]): string {
  if (model && modelImageInput(model) === "no") {
    return t("chat.composer.imageNote.no", { model: modelNameFor(model, models) });
  }
  return t("chat.error.noImageInput");
}
