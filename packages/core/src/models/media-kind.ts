export type MediaKind = "chat" | "image" | "video" | "audio" | "other";

export const MEDIA_KINDS: MediaKind[] = ["chat", "image", "video", "audio", "other"];

export type RoutedModels<T extends { id: string }> = Record<MediaKind, T[]>;

/**
 * The image id the app starts on. `gpt-image-2.5-flare` (2026-11-12): driven on the prepaid agent key at
 * quality medium, 1024x1024 in 15 s (the 2.0 id took about 100 s on the same key), and the same id drew
 * 1536x1024 and 1024x1536 too. It answers text-to-image only: a request with a picture to edit goes to
 * `IMAGE_REFERENCE_MODEL` (`gatewayGenerateModel`). A key that does not list it falls to the next id in
 * `IMAGE_PREF`.
 */
export const DEFAULT_GATEWAY_IMAGE_MODEL = "gpt-image-2.5-flare";
/**
 * The image id that edits a picture (`POST /v1/images/edits`). The 2.5 ids publish no edit route, so the
 * default stays on this one when a reference image comes with the request.
 */
export const IMAGE_REFERENCE_MODEL = "gpt-image-2";
/**
 * The last resort when nothing lists a video id at all. `seedance-2.0-fast` is the one video id
 * driven end to end on a prepaid agent key (2026-11-11: HTTP 200, 135 s, 2.75 MB), where the
 * per-token ids (`grok-imagine-video`, `kling-v3`) were refused 403 / 503 on that key.
 */
export const DEFAULT_GATEWAY_VIDEO_MODEL = "seedance-2.0-fast";
export const DEFAULT_GATEWAY_MUSIC_MODEL = "suno_music";
export const DEFAULT_GATEWAY_LYRICS_MODEL = "suno_lyrics";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

const EMBEDDING = /embedding/i;
const EMBEDDING_PREF = ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-004"];

/**
 * Flare first, Sunburst next: both drew a 1024x1024 medium image on the prepaid key on 2026-11-12 (15 s and 18 s).
 * Flare followed the prompt's colour more closely in the same-prompt pair, and the gateway describes it as the
 * everyday id; Sunburst is the one it describes for detailed compositions. `gpt-image-2` stays behind them for a
 * key that lists neither, and it is also the id that edits a picture.
 */
const IMAGE_PREF = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "seedream-5.0-pro",
  "doubao-seedream-5-0-pro-260628",
];

/** The only music generator on this gateway (2026-09; docs/internal/gateway-model-selection.md 5.3). */
const MUSIC_PREF = ["suno_music"];

/**
 * Music models the gateway serves but never lists in `GET /v1/models`.
 *
 * new-api / one-api style gateways list the OpenAI-shaped models there and nothing else. A *relay*
 * model is driven through its own mount on the gateway origin — for Suno, `POST /suno/submit/music`
 * and `GET /suno/fetch/{id}` — and is billed as a task, so it never appears in the chat catalog even
 * on a key that can use it. Building the Music picker by filtering the live catalog therefore
 * produced an empty, disabled dropdown on a desk where music works (owner report, 2026-09-21).
 *
 * This is a fixed list in the repo, like `MUSIC_PREF` above: it is never read from a request, a
 * response, or settings, so nothing a gateway says can add an id here. Every entry must satisfy
 * `isMusicModelId`, or the Music filter would drop it again straight after the merge.
 */
export const RELAY_ONLY_MUSIC_MODEL_IDS: readonly string[] = Object.freeze([DEFAULT_GATEWAY_MUSIC_MODEL]);
const LYRICS_PREF = ["suno_lyrics"];
/** Non-realtime text-to-speech. Empty on this gateway today — see `speechModelRole` below. */
const SPEECH_PREF = ["qwen-audio-3.0-tts", "tts-1-hd", "tts-1", "qwen3.5-omni-flash", "qwen3.5-omni-plus"];

/**
 * Seedance leads (2026-09-30): the live catalogue lists `seedance-2.0` and `seedance-2.5` and none of
 * the ids below it, and the app made its demo videos on `seedance-2.0` (its dated Doubao spelling
 * follows for a catalogue that lists only that). Veo fast, which completed reliably earlier in
 * 2026-09, and the cheap t2v ids stay after it as fallbacks for a gateway that lists them again.
 * `seedance-2.5` is listed but was not driven, so it sits behind the proven 2.0.
 */
const VIDEO_PREF = [
  // 2026-11-11: the one video id driven end to end on a prepaid agent key (HTTP 200, 135 s, 2.75 MB). The
  // per-token ids (`grok-imagine-video`, `kling-v3`) were refused 403 / 503 on that key, and `seedance-2.0`
  // itself was not tried, so the proven fast id leads; it is also the cheaper one. `seedance-2.0` follows.
  "seedance-2.0-fast",
  "seedance-2.0",
  "doubao-seedance-2-0-260128",
  "seedance-2.5",
  "veo_3_1-fast",
  "grok-imagine-video",
  "omni-fast-v2v",
  "grok-imagine-video-1.5-preview",
];

/**
 * The ranked hints each media picker uses, in one read-only object, so a tool that reports on the
 * catalogue (`packages/host/eval/models`) reads the same lists the pickers rank by and cannot drift.
 */
export const MEDIA_MODEL_PREFERENCES = Object.freeze({
  image: Object.freeze([...IMAGE_PREF]),
  video: Object.freeze([...VIDEO_PREF]),
  music: Object.freeze([...MUSIC_PREF]),
  lyrics: Object.freeze([...LYRICS_PREF]),
  speech: Object.freeze([...SPEECH_PREF]),
  embedding: Object.freeze([...EMBEDDING_PREF]),
});

const OTHER = /(^|\/)(text-)?embedding|babbage|davinci|computer-use|omni-moderation|text-moderation|moderation/i;
const AUDIO = /suno_|whisper|\btts\b|tts-1|lyria|transcribe|audio-|(?:^|[-_.])asr(?:[-_.]|$)/i;
const VIDEO =
  /seedance|veo[_-]|kling|\bsora\b|happyhorse|mj_video|grok-imagine-video|-t2v|-i2v|-r2v|-v2v|video-edit|omni-fast-v2v/i;
const IMAGE =
  /gpt-image|dall-e|chatgpt-image|seedream|flux-|imagen-|mj_|grok-imagine-image|nano-banana|qwen-image|wan2\.7-image|z-image|image-edit|gemini-[\w.-]*image/i;
/**
 * Kling's picture models (`kling_image`, `kling_omni_image`) share the word `kling` with its video
 * models, and the video pattern is tested first. Tested before it, so they land in the Images picker.
 */
const KLING_IMAGE = /^kling[_-](?:omni[_-])?image\b/i;

export function mediaKind(id: string): MediaKind {
  const value = id.trim();
  if (!value) {
    return "other";
  }
  if (OTHER.test(value)) {
    return "other";
  }
  if (AUDIO.test(value)) {
    return "audio";
  }
  if (KLING_IMAGE.test(value)) {
    return "image";
  }
  if (VIDEO.test(value)) {
    return "video";
  }
  if (IMAGE.test(value)) {
    return "image";
  }
  const lower = value.toLowerCase();
  if (lower.includes("video")) {
    return "video";
  }
  if (lower.includes("image") && !lower.includes("imagine")) {
    return "image";
  }
  return "chat";
}

/**
 * What an `audio`-classified id actually does. `mediaKind` lumps every audio id together, but the
 * Music studio has to tell a song generator from a lyric writer, a reader from a transcriber:
 * sending a prompt to the wrong one bills the desk for nothing.
 *
 * `realtime` is its own answer on purpose. Section 2.1 of `docs/internal/gateway-model-selection.md`
 * says the `*-realtime` ids speak WebSocket behind an `openai` endpoint label, so they cannot be
 * driven from a plain HTTP job route — treating one as TTS would produce a request nothing answers.
 */
export type AudioRole = "music" | "lyrics" | "speech" | "realtime" | "transcribe" | "other";

const LYRICS_ID = /suno_lyrics|lyric/i;
const MUSIC_ID = /suno_music|\bmusic\b|lyria/i;
const TRANSCRIBE_ID = /whisper|transcribe|\basr\b|-asr/i;
const SPEECH_ID = /\btts\b|tts-|-tts|text-to-speech|speech/i;
const REALTIME_ID = /realtime/i;

export function audioRole(id: string): AudioRole {
  const value = id.trim();
  if (!value || mediaKind(value) !== "audio") {
    return "other";
  }
  if (LYRICS_ID.test(value)) {
    return "lyrics";
  }
  if (MUSIC_ID.test(value)) {
    return "music";
  }
  if (TRANSCRIBE_ID.test(value)) {
    return "transcribe";
  }
  // Realtime is checked before TTS so `qwen3-tts-instruct-flash-realtime` never looks reachable.
  if (REALTIME_ID.test(value)) {
    return "realtime";
  }
  if (SPEECH_ID.test(value)) {
    return "speech";
  }
  return "other";
}

export function isMusicModelId(id: string): boolean {
  return audioRole(id) === "music";
}

export function isLyricsModelId(id: string): boolean {
  return audioRole(id) === "lyrics";
}

/**
 * A chat id that answers with spoken audio over the streaming chat call (driven 2026-11-11 with
 * `qwen3.5-omni-flash`, voice Tina). The `-realtime` spellings are WebSocket-only and never match.
 */
const OMNI_SPEECH_ID = /^qwen3(?:\.\d+)?-omni-(?:flash|plus)(?:-\d{4}-\d{2}-\d{2})?$/i;

export function isOmniSpeechModelId(id: string): boolean {
  return OMNI_SPEECH_ID.test(id.trim());
}

/** Text-to-speech we can actually POST to. A WebSocket-only realtime id is deliberately excluded. */
export function isSpeechModelId(id: string): boolean {
  return audioRole(id) === "speech";
}

export function routeModelsByKind<T extends { id: string }>(models: T[]): RoutedModels<T> {
  const routed: RoutedModels<T> = {
    chat: [],
    image: [],
    video: [],
    audio: [],
    other: [],
  };
  for (const model of models) {
    routed[mediaKind(model.id)].push(model);
  }
  return routed;
}

/** Return the live catalog spelling of the first preferred id (case-insensitive). */
export function firstLiveId(preferred: string[], ids: string[]): string | undefined {
  const byLower = new Map(ids.map((id) => [id.toLowerCase(), id]));
  for (const want of preferred) {
    const hit = byLower.get(want.toLowerCase());
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

export function pickPreferredImageModel(ids: string[]): string {
  const usable = ids.filter((id) => mediaKind(id) === "image" && !id.toLowerCase().startsWith("mj_"));
  return firstLiveId(IMAGE_PREF, usable) ?? usable[0] ?? DEFAULT_GATEWAY_IMAGE_MODEL;
}

export function pickPreferredVideoModel(ids: string[]): string {
  const usable = ids.filter((id) => mediaKind(id) === "video" && !id.toLowerCase().startsWith("mj_"));
  return firstLiveId(VIDEO_PREF, usable) ?? usable[0] ?? DEFAULT_GATEWAY_VIDEO_MODEL;
}

export function pickPreferredMusicModel(ids: string[]): string {
  const usable = ids.filter((id) => isMusicModelId(id));
  return firstLiveId(MUSIC_PREF, usable) ?? usable[0] ?? DEFAULT_GATEWAY_MUSIC_MODEL;
}

export function pickPreferredLyricsModel(ids: string[]): string {
  const usable = ids.filter((id) => isLyricsModelId(id));
  return firstLiveId(LYRICS_PREF, usable) ?? usable[0] ?? DEFAULT_GATEWAY_LYRICS_MODEL;
}

/**
 * Empty string when the live catalog has no non-realtime TTS id, which is the case on this gateway
 * today. There is no default to fall back on: inventing one would send the desk at a model the
 * gateway does not serve, and the studio would rather say so than fail at submit time.
 */
export function pickPreferredSpeechModel(ids: string[]): string {
  const usable = ids.filter((id) => isSpeechModelId(id) || isOmniSpeechModelId(id));
  return firstLiveId(SPEECH_PREF, usable) ?? usable[0] ?? "";
}

export function isEmbeddingModelId(id: string): boolean {
  return EMBEDDING.test(id.trim());
}

export function pickPreferredEmbeddingModel(ids: string[]): string {
  const usable = ids.filter((id) => isEmbeddingModelId(id));
  return firstLiveId(EMBEDDING_PREF, usable) ?? usable[0] ?? DEFAULT_EMBEDDING_MODEL;
}
