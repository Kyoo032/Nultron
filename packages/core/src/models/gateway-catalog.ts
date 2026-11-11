/**
 * Every model the gateway offers, with its kind and the wire that drives it.
 *
 * Kept as data and kept for models this key cannot use, so the system can see a wider key's models
 * the moment the key lists them, with no code change. The catalog is filled from three places:
 *
 * 1. the key's own `GET /v1/models` (what this key may name),
 * 2. the gateway's public `GET /api/pricing` (`supported_endpoint_types` says what a model *is*, for
 *    an id no regex in this repo has heard of),
 * 3. a short built-in seed for models the gateway serves but never lists (the Suno relay).
 *
 * What is NOT here: whether a call will work. That is `availability.ts`, per key.
 *
 * No Node imports: the Settings card in the renderer reads these types.
 */

import {
  effectiveRecordStatus,
  isOfferedStatus,
  modelKey,
  type AvailabilityRecord,
  type ModelStatus,
} from "./availability";
import { audioRole, isOmniSpeechModelId, mediaKind } from "./media-kind";
import { videoSpecFor } from "./media-params";

export const MODEL_KINDS = ["chat", "image", "video", "speech", "transcription", "music", "realtime", "other"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/**
 * The ways this repo knows to call a non-chat model. One id per request shape, because two shapes can
 * share a route (`/v1/video/generations` takes the OpenAI-like body for some ids and the Seedance
 * `content` body for others). The body itself is built by the caller that owns the wire.
 */
export const WIRE_IDS = [
  "images_generations",
  "video_generations",
  "video_seedance",
  "videos_json",
  "video_kling",
  "audio_speech",
  "chat_audio_stream",
  "audio_transcriptions",
  "chat_audio_input",
  "suno_relay",
  "realtime_ws",
] as const;
export type WireId = (typeof WIRE_IDS)[number];

export type GatewayWire = { id: WireId; method: "GET" | "POST"; route: string };

export const GATEWAY_WIRES: Readonly<Record<WireId, GatewayWire>> = Object.freeze({
  images_generations: { id: "images_generations", method: "POST", route: "/v1/images/generations" },
  video_generations: { id: "video_generations", method: "POST", route: "/v1/video/generations" },
  video_seedance: { id: "video_seedance", method: "POST", route: "/v1/video/generations" },
  // The documented Grok route (docs: "Grok Video Generation"). `/v1/video/generations` is the generic one.
  videos_json: { id: "videos_json", method: "POST", route: "/v1/videos" },
  // Kling is served from its own mount beside `/v1` (docs: /kling/v1/videos/*, /kling/text-to-video/*); the
  // exact route per model, and per input, is the media parameter spec's.
  video_kling: { id: "video_kling", method: "POST", route: "/kling/v1/videos/text2video" },
  audio_speech: { id: "audio_speech", method: "POST", route: "/v1/audio/speech" },
  chat_audio_stream: { id: "chat_audio_stream", method: "POST", route: "/v1/chat/completions" },
  audio_transcriptions: { id: "audio_transcriptions", method: "POST", route: "/v1/audio/transcriptions" },
  chat_audio_input: { id: "chat_audio_input", method: "POST", route: "/v1/chat/completions" },
  suno_relay: { id: "suno_relay", method: "POST", route: "/suno/submit/music" },
  realtime_ws: { id: "realtime_ws", method: "GET", route: "/v1/realtime" },
});

export type CatalogSource = "key" | "pricing" | "seed";

export type CatalogEntry = {
  id: string;
  /** What the model mainly is. */
  kind: ModelKind;
  /**
   * Every non-chat way this model can be driven, by what it would be driven as. A chat model that
   * speaks (an Omni id) is `kind: "chat"` with a `speech` wire here; a video model has its own kind
   * and one `video` wire. Empty for an ordinary chat model, whose wire is `modelPolicy`'s business.
   */
  wires: Partial<Record<ModelKind, GatewayWire>>;
  /** The key's model list carries it. */
  listedOnKey: boolean;
  /** Served through a relay the gateway never lists (Suno): not being listed says nothing. */
  relayOnly: boolean;
  sources: CatalogSource[];
};

// ---------------------------------------------------------------------------------- kind and wire

const REALTIME_ID = /realtime/i;
const OMNI_ID = /omni|livetranslate|gemini-3[\w.]*-flash/i;

/** The endpoint types the gateway's price list uses, by the kind they say a model is. */
export function kindFromEndpointTypes(types: readonly string[] | undefined): ModelKind | undefined {
  if (!types || types.length === 0) {
    return undefined;
  }
  if (types.includes("openai-video") || types.includes("seedance2-native-video")) {
    return "video";
  }
  if (types.includes("image-generation") || types.includes("openai-image-edit")) {
    return "image";
  }
  return undefined;
}

/** The kind the price list gives one model id, if it lists it and says. */
export function kindFromEndpointTypesOf(id: string, hints: PricingHints | undefined): ModelKind | undefined {
  return kindFromEndpointTypes(hints?.[modelKey(id)]);
}

/** `model id (lower case) -> endpoint types`, read from the gateway's public price list. */
export type PricingHints = Readonly<Record<string, readonly string[]>>;

export function parsePricingHints(body: unknown): PricingHints {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  const hints: Record<string, readonly string[]> = {};
  if (!Array.isArray(data)) {
    return hints;
  }
  for (const item of data) {
    const row = item as { model_name?: unknown; supported_endpoint_types?: unknown } | null;
    if (!row || typeof row.model_name !== "string" || !Array.isArray(row.supported_endpoint_types)) {
      continue;
    }
    const types = row.supported_endpoint_types.filter((type): type is string => typeof type === "string");
    hints[modelKey(row.model_name)] = types;
  }
  return hints;
}

/** What a model is: the price list's word first (it is the gateway's own), then the id. */
export function catalogKindOf(id: string, hints?: PricingHints): ModelKind {
  const value = id.trim();
  if (REALTIME_ID.test(value)) {
    return "realtime";
  }
  const hinted = kindFromEndpointTypes(hints?.[modelKey(value)]);
  if (hinted) {
    return hinted;
  }
  const kind = mediaKind(value);
  if (kind === "audio") {
    const role = audioRole(value);
    if (role === "music" || role === "lyrics") {
      return "music";
    }
    if (role === "speech") {
      return "speech";
    }
    if (role === "transcribe") {
      return "transcription";
    }
    return "other";
  }
  return kind;
}

/**
 * The wire a video id is driven through, read from its media parameter spec (`media-params.ts`): the
 * body style says which route and which body, so no id regex lives here.
 */
export function videoWireFor(id: string): GatewayWire {
  switch (videoSpecFor(id.trim()).bodyStyle) {
    case "grok-videos":
    case "omni-fast":
      return GATEWAY_WIRES.videos_json;
    case "seedance-content":
      return GATEWAY_WIRES.video_seedance;
    case "kling-native":
    case "kling-omni":
    case "kling-turbo":
      return GATEWAY_WIRES.video_kling;
    default:
      return GATEWAY_WIRES.video_generations;
  }
}

function wiresFor(id: string, kind: ModelKind): Partial<Record<ModelKind, GatewayWire>> {
  switch (kind) {
    case "image":
      return { image: GATEWAY_WIRES.images_generations };
    case "video":
      return { video: videoWireFor(id) };
    case "music":
      return { music: GATEWAY_WIRES.suno_relay };
    case "speech":
      return { speech: GATEWAY_WIRES.audio_speech };
    case "transcription":
      return { transcription: GATEWAY_WIRES.audio_transcriptions };
    case "realtime":
      return { realtime: GATEWAY_WIRES.realtime_ws };
    case "chat": {
      const wires: Partial<Record<ModelKind, GatewayWire>> = {};
      if (isOmniSpeechModelId(id)) {
        wires.speech = GATEWAY_WIRES.chat_audio_stream;
      }
      if (OMNI_ID.test(id)) {
        wires.transcription = GATEWAY_WIRES.chat_audio_input;
      }
      return wires;
    }
    default:
      return {};
  }
}

/**
 * The kind a speech request is driven as for this model: `/v1/audio/speech` for a TTS id, the chat
 * stream for an Omni id. A model that does neither has no speech wire.
 */
export function speechWireFor(id: string): GatewayWire | undefined {
  return wiresFor(id, catalogKindOf(id)).speech;
}

// ------------------------------------------------------------------------------------------ seed

/**
 * Models the gateway serves but never lists in `GET /v1/models`. A new-api style gateway lists the
 * OpenAI-shaped models only; the Suno relay is mounted beside `/v1` (`gateway-audio.ts`). Not being
 * listed says nothing about these, so they are `unknown` until a call teaches otherwise.
 */
export const CATALOG_SEED: readonly { id: string; kind: ModelKind }[] = Object.freeze([
  { id: "suno_music", kind: "music" },
  { id: "suno_lyrics", kind: "music" },
]);

// ---------------------------------------------------------------------------------------- build

export function buildCatalog(input: {
  /** Ids the key's `GET /v1/models` returned. */
  listedIds: readonly string[];
  hints?: PricingHints;
  seed?: readonly { id: string; kind: ModelKind }[];
}): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  const add = (id: string, source: CatalogSource, kindOverride?: ModelKind) => {
    const trimmed = id.trim();
    const key = modelKey(trimmed);
    if (!trimmed) {
      return;
    }
    const held = entries.get(key);
    if (held) {
      if (!held.sources.includes(source)) {
        held.sources.push(source);
      }
      if (source === "key") {
        held.listedOnKey = true;
      }
      return;
    }
    const kind = kindOverride ?? catalogKindOf(trimmed, input.hints);
    entries.set(key, {
      id: trimmed,
      kind,
      wires: wiresFor(trimmed, kind),
      listedOnKey: source === "key",
      relayOnly: source === "seed",
      sources: [source],
    });
  };
  for (const id of input.listedIds) {
    add(id, "key");
  }
  for (const id of Object.keys(input.hints ?? {})) {
    add(id, "pricing");
  }
  for (const item of input.seed ?? CATALOG_SEED) {
    const held = entries.get(modelKey(item.id));
    if (held) {
      // The gateway lists it after all: it is an ordinary listed model, not a relay-only one.
      continue;
    }
    add(item.id, "seed", item.kind);
  }
  return [...entries.values()];
}

// ----------------------------------------------------------------------------------- availability

export type ModelAvailability = {
  id: string;
  kind: ModelKind;
  status: ModelStatus;
  /** The gateway's own code or a short sentence of its words; empty when nothing was learned. */
  reason: string;
  /** When the lesson was learned, or null for a status that was derived. */
  checkedAt: string | null;
  listedOnKey: boolean;
};

/**
 * One model's standing on one key.
 *
 * 1. A live lesson from a real call wins (a success is `available`; a refusal says why not).
 * 2. With no lesson, a model the key's list does not carry is `not_on_key`, unless it is a relay
 *    model, which the list never carries.
 * 3. Otherwise `unknown`: the key lists it and nothing has said it will not work.
 *
 * `keyListKnown` is false when no list was ever read (a stub desk, an unreachable gateway): then
 * absence from it proves nothing and nothing is derived as `not_on_key`.
 */
export function availabilityOf(
  entry: CatalogEntry,
  record: AvailabilityRecord | undefined,
  context: { keyListKnown: boolean; nowMs: number },
): ModelAvailability {
  const learned = effectiveRecordStatus(record, context.nowMs);
  if (record && learned !== "unknown") {
    return {
      id: entry.id,
      kind: entry.kind,
      status: learned,
      reason: record.reason,
      checkedAt: record.checkedAt,
      listedOnKey: entry.listedOnKey,
    };
  }
  const missing = context.keyListKnown && !entry.listedOnKey && !entry.relayOnly;
  return {
    id: entry.id,
    kind: entry.kind,
    status: missing ? "not_on_key" : "unknown",
    reason: missing ? "not_listed" : "",
    checkedAt: null,
    listedOnKey: entry.listedOnKey,
  };
}

/** Every entry's standing, newest list first. Pure: the caller supplies the records and the clock. */
export function computeAvailability(input: {
  catalog: readonly CatalogEntry[];
  records: Readonly<Record<string, AvailabilityRecord>>;
  nowMs: number;
}): ModelAvailability[] {
  const keyListKnown = input.catalog.some((entry) => entry.listedOnKey);
  return input.catalog.map((entry) =>
    availabilityOf(entry, input.records[modelKey(entry.id)], { keyListKnown, nowMs: input.nowMs }),
  );
}

/** The ids a picker of one kind may show: offered, and driven as that kind. */
export function offeredIdsFor(
  catalog: readonly CatalogEntry[],
  standings: readonly ModelAvailability[],
  kind: ModelKind,
): string[] {
  const byId = new Map(standings.map((standing) => [modelKey(standing.id), standing]));
  return catalog
    .filter((entry) => entry.kind === kind || kind in entry.wires)
    .filter((entry) => {
      const standing = byId.get(modelKey(entry.id));
      return standing ? isOfferedStatus(standing.status) : true;
    })
    .map((entry) => entry.id);
}

/** What Settings lists as "this key cannot use these", with the reason. Chat only once a call said so. */
export function unavailableModels(standings: readonly ModelAvailability[]): ModelAvailability[] {
  return standings
    .filter((standing) => !isOfferedStatus(standing.status))
    .filter((standing) => (standing.kind !== "other" && standing.kind !== "realtime") || standing.checkedAt !== null)
    .filter((standing) => standing.kind !== "chat" || standing.checkedAt !== null);
}
