/**
 * The answer Settings and the studios read about availability: the models a key cannot use, and how
 * many each kind still offers. Split from `model-availability.ts` because it reads the picker lists,
 * and `selectable-models.ts` (which builds them) imports that file.
 */

import { transcriptionCandidates } from "@agentforge/core/meeting";
import { cachedModelIds } from "./meeting/transcribe";
import { availabilityPayload, type ModelAvailabilityPayload } from "./model-availability";
import type { ModelCacheScope } from "./model-cache";
import {
  listImageModels,
  listMusicModels,
  listProbedVideoModels,
  listRoutedModels,
  listSpeechModels,
} from "./selectable-models";

export function modelAvailabilityBody(scope?: ModelCacheScope): ModelAvailabilityPayload {
  const base = availabilityPayload(scope);
  return {
    ...base,
    kinds: {
      chat: { offered: listRoutedModels(undefined, scope).chat.length },
      image: { offered: listImageModels(scope).length },
      video: { offered: listProbedVideoModels(undefined, scope).length },
      music: { offered: listMusicModels(scope).length },
      speech: { offered: listSpeechModels(scope).length },
      transcription: { offered: transcriptionCandidates(cachedModelIds(scope)).length },
    },
  };
}
