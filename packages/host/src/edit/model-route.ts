import {
  availableVideoDefault,
  DEFAULT_GATEWAY_IMAGE_MODEL,
  DEFAULT_GATEWAY_VIDEO_MODEL,
  pickPreferredImageModel,
} from "@agentforge/core";
import type { ModelCacheScope } from "../model-cache";
import { listImageModels, listProbedVideoModels } from "../selectable-models";

/**
 * The model an Edit generate call runs when nothing named one.
 *
 * Rizky, 2026-11-11: a key that cannot run `grok-imagine-video` must not be defaulted onto it. The
 * first id the key's own catalogue lists wins — image by `IMAGE_PREF` (`pickPreferredImageModel`),
 * video by `VIDEO_PREF` (`availableVideoDefault`, the rule `defaultStudioVideoModel` reads) — and only
 * a key that lists none falls back to `DEFAULT_GATEWAY_*_MODEL`. The video fallback is
 * `seedance-2.0-fast`, the one video id driven end to end on a prepaid agent key
 * (`packages/core/src/models/media-kind.ts:8-13`); the per-token ids such as `grok-imagine-video` were
 * refused 403 / 503 there.
 *
 * The video list is the probed one (`listProbedVideoModels`, with what a real call refused dropped),
 * the same list the `video_generate` tool resolves its own default from (`toolMediaModels`), so an
 * Edit agent's price estimate and the call it then makes name one model.
 */
export function defaultEditGenerateModel(scope: ModelCacheScope, kind: "image" | "video"): string {
  if (kind === "image") {
    return pickPreferredImageModel(listImageModels(scope).map((model) => model.id)) || DEFAULT_GATEWAY_IMAGE_MODEL;
  }
  const videoIds = listProbedVideoModels(undefined, scope).map((model) => model.id);
  return availableVideoDefault(videoIds) || DEFAULT_GATEWAY_VIDEO_MODEL;
}
