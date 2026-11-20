/**
 * Music and speech over the Toko Token gateway.
 *
 * **Why this is not `/v1/audio/generations`.** There is no such route. The gateway's music models are
 * `suno_music` / `suno_lyrics`, and `docs/internal/gateway-model-selection.md` (5.1, 5.3 and the
 * sources list) records what they are: an unofficial Suno proxy relayed by a NewAPI-style gateway,
 * async, billed a flat price per call. NewAPI mounts that relay beside `/v1`, not inside it —
 * `POST /suno/submit/{music,lyrics}` returns a task id and `GET /suno/fetch/{id}` reports it — which
 * is why every function here resolves the gateway *origin* and not the `/v1` base URL.
 *
 * **Unproven against the live gateway.** Cloud agents have no egress to `api.tokotokenai.com`, so
 * this wire was written from the catalog docs and has never been driven. The first live run belongs
 * on the owner's desk (`scripts/probe-gateway-music.ts`), and `RELAY_MISSING` below is written to
 * say exactly that if the relay turns out to live somewhere else — a wrong path should cost one
 * line, not a debugging session.
 *
 * Speech is separate and deliberately thin: `POST /v1/audio/speech` is the OpenAI-compatible route,
 * and it answers with bytes rather than a job. No live id reaches it on this gateway today; see
 * `speechReachable` in `models/audio-capabilities.ts`.
 */

import { ApiError } from "../../errors";
import { GatewayRefusalError } from "../../models/availability";
import { gatewayOriginFromBaseUrl } from "../../gateway";
import { MUSIC_LYRICS_MAX, MUSIC_PROMPT_MAX, MUSIC_STYLE_MAX, MUSIC_TITLE_MAX } from "../../models/audio-capabilities";
import { gatewayErrorCode, httpStatusForGatewayFailure, readGatewayError } from "./gateway-media";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** A Suno job renders in minutes, not seconds, so the poll budget is much longer than video's. */
export const MUSIC_POLL_MS = 3_000;
export const MUSIC_MAX_POLLS = 100;

export type GatewayTrack = {
  url: string;
  title?: string;
  /** Rendered length in seconds, when the relay reports one. Never guessed. */
  durationSeconds?: number;
  /** Cover art the relay generated alongside the track. */
  imageUrl?: string;
  lyrics?: string;
};

export type GatewayMusicOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** `describe`: the model writes the lyrics. `custom`: `lyrics` / `style` / `title` are the brief. */
  mode: "describe" | "custom";
  /** The description, in `describe` mode. */
  prompt?: string;
  lyrics?: string;
  style?: string;
  title?: string;
  instrumental?: boolean;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
};

export type GatewayLyricsOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
};

export type GatewaySpeechOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  voice?: string;
  format?: string;
  fetchImpl?: typeof fetch;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const parsed = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": BROWSER_UA,
  };
}

function clamp(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Only an http(s) or data URL is a track; a failed relay copies its reason into the url field. */
function looksLikeMediaUrl(value: string | undefined): string | undefined {
  return value && /^(https?:\/\/|data:)/i.test(value) ? value : undefined;
}

const RELAY_MISSING =
  "The gateway did not serve the Suno relay at /suno/submit (HTTP 404). Music on this gateway is an async Suno proxy, not a /v1 route — confirm the relay path with the gateway operator and update gateway-audio.ts.";

export function isRelayMissing(status: number, body: Record<string, unknown>): boolean {
  if (status !== 404) {
    return false;
  }
  const message = readGatewayError(body, "").toLowerCase();
  return message.length === 0 || /not found|invalid url|no such|404/i.test(message);
}

/**
 * The request body for one Suno submit. Kept to fields the Suno proxy is documented to read:
 * anything else risks a strict JSON decoder rejecting the whole job, which is exactly how the
 * video wire lost a day (`buildVideoRequest`, same file family).
 */
export function buildSunoMusicPayload(options: {
  mode: "describe" | "custom";
  prompt?: string;
  lyrics?: string;
  style?: string;
  title?: string;
  instrumental?: boolean;
}): Record<string, unknown> {
  const instrumental = options.instrumental === true;
  if (options.mode === "custom") {
    return {
      prompt: clamp(options.lyrics, MUSIC_LYRICS_MAX) ?? "",
      tags: clamp(options.style, MUSIC_STYLE_MAX) ?? "",
      title: clamp(options.title, MUSIC_TITLE_MAX) ?? "",
      make_instrumental: instrumental,
    };
  }
  return {
    gpt_description_prompt: clamp(options.prompt, MUSIC_PROMPT_MAX) ?? "",
    make_instrumental: instrumental,
  };
}

/** NewAPI answers a submit with the task id under `data`, sometimes as an object. */
export function sunoTaskId(body: Record<string, unknown>): string | undefined {
  const data = body.data;
  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }
  const record = asRecord(data);
  return asString(record.task_id) ?? asString(record.id) ?? asString(body.task_id) ?? asString(body.id);
}

function sunoStatus(body: Record<string, unknown>): string {
  const data = asRecord(body.data);
  return String(data.status ?? body.status ?? "").trim();
}

export function isSunoSuccess(status: string): boolean {
  return /^(success|succeeded|completed|complete)$/i.test(status);
}

export function isSunoFailure(status: string): boolean {
  return /^(failure|failed|error|cancelled|canceled)$/i.test(status);
}

/** Why a polled Suno job failed. NewAPI reports it as `data.fail_reason`; `code` stays "success". */
export function readSunoFailure(body: Record<string, unknown>, fallback: string): string {
  const data = asRecord(body.data);
  return asString(data.fail_reason) ?? readGatewayError(body, fallback);
}

/**
 * Every finished clip in a fetch response. Suno returns two takes per job, so the studio saves both
 * rather than silently dropping one the desk has already been billed for.
 */
export function extractSunoTracks(body: Record<string, unknown>): GatewayTrack[] {
  const data = asRecord(body.data);
  const clips = Array.isArray(data.data) ? data.data : Array.isArray(body.data) ? body.data : [];
  const tracks: GatewayTrack[] = [];
  for (const raw of clips) {
    const clip = asRecord(raw);
    const metadata = asRecord(clip.metadata);
    const url = looksLikeMediaUrl(asString(clip.audio_url) ?? asString(clip.url) ?? asString(clip.source_audio_url));
    if (!url) {
      continue;
    }
    tracks.push({
      url,
      title: asString(clip.title),
      durationSeconds: asNumber(metadata.duration ?? clip.duration),
      imageUrl: looksLikeMediaUrl(asString(clip.image_url)),
      lyrics: asString(metadata.prompt),
    });
  }
  return tracks;
}

/** The written lyrics in a `suno_lyrics` fetch response. */
export function extractSunoLyrics(body: Record<string, unknown>): { text: string; title?: string } | null {
  const data = asRecord(body.data);
  const inner = asRecord(data.data);
  const text = asString(inner.text) ?? asString(data.text) ?? asString(inner.lyrics) ?? asString(data.lyrics);
  if (!text) {
    return null;
  }
  return { text, title: asString(inner.title) ?? asString(data.title) };
}

async function submitSuno(
  action: "music" | "lyrics",
  options: { baseUrl: string; apiKey: string; fetchImpl: typeof fetch; payload: Record<string, unknown> },
): Promise<{ origin: string; taskId: string }> {
  const origin = gatewayOriginFromBaseUrl(options.baseUrl);
  const created = await options.fetchImpl(`${origin}/suno/submit/${action}`, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify(options.payload),
  });
  const body = asRecord(await created.json().catch(() => ({})));
  if (!created.ok) {
    if (isRelayMissing(created.status, body)) {
      throw new ApiError("tool_failed", RELAY_MISSING, 502);
    }
    const detail = readGatewayError(body, `Gateway Suno relay returned HTTP ${created.status}`);
    throw new GatewayRefusalError("tool_failed", detail, httpStatusForGatewayFailure(created.status), {
      status: created.status,
      code: gatewayErrorCode(body),
      message: detail,
    });
  }
  const taskId = sunoTaskId(body);
  if (!taskId) {
    throw new ApiError("tool_failed", readGatewayError(body, "Gateway Suno relay returned no task id"), 502);
  }
  return { origin, taskId };
}

async function pollSuno<T>(options: {
  origin: string;
  taskId: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  wait: (ms: number) => Promise<void>;
  pollMs: number;
  maxPolls: number;
  label: string;
  read: (body: Record<string, unknown>) => T | null;
}): Promise<T> {
  for (let attempt = 0; attempt < options.maxPolls; attempt += 1) {
    const response = await options.fetchImpl(`${options.origin}/suno/fetch/${options.taskId}`, {
      headers: headers(options.apiKey),
    });
    const body = asRecord(await response.json().catch(() => ({})));
    const status = sunoStatus(body);
    if (isSunoFailure(status)) {
      const raw = readSunoFailure(body, `Gateway ${options.label} job failed`);
      // The relay accepted the job; a failed render (a refused lyric, an upstream error) is not a
      // fact about the model, so it files no lesson (`availability.ts`, `phase: "poll"`).
      throw new GatewayRefusalError("tool_failed", raw, 502, {
        status: response.status,
        code: gatewayErrorCode(body),
        message: raw,
        phase: "poll",
      });
    }
    if (!response.ok) {
      const raw = readGatewayError(body, `Gateway Suno fetch returned HTTP ${response.status}`);
      throw new GatewayRefusalError("tool_failed", raw, httpStatusForGatewayFailure(response.status), {
        status: response.status,
        code: gatewayErrorCode(body),
        message: raw,
        phase: "poll",
      });
    }
    const done = options.read(body);
    // A clip url can appear while the job still says IN_PROGRESS; that url is the streaming take and
    // is only trusted once the relay calls the job finished.
    if (done && isSunoSuccess(status)) {
      return done;
    }
    await options.wait(options.pollMs);
  }
  throw new ApiError("tool_failed", `Gateway ${options.label} job timed out`, 504);
}

export async function generateGatewayMusic(
  options: GatewayMusicOptions,
): Promise<{ tracks: GatewayTrack[]; model: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { origin, taskId } = await submitSuno("music", {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl,
    payload: buildSunoMusicPayload(options),
  });
  const tracks = await pollSuno({
    origin,
    taskId,
    apiKey: options.apiKey,
    fetchImpl,
    wait,
    pollMs: options.pollMs ?? MUSIC_POLL_MS,
    maxPolls: options.maxPolls ?? MUSIC_MAX_POLLS,
    label: "music",
    read: (body) => {
      const found = extractSunoTracks(body);
      return found.length > 0 ? found : null;
    },
  });
  return { tracks, model: options.model };
}

export async function generateGatewayLyrics(
  options: GatewayLyricsOptions,
): Promise<{ text: string; title?: string; model: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { origin, taskId } = await submitSuno("lyrics", {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetchImpl,
    payload: { prompt: clamp(options.prompt, MUSIC_PROMPT_MAX) ?? "" },
  });
  const written = await pollSuno({
    origin,
    taskId,
    apiKey: options.apiKey,
    fetchImpl,
    wait,
    pollMs: options.pollMs ?? MUSIC_POLL_MS,
    maxPolls: options.maxPolls ?? MUSIC_MAX_POLLS,
    label: "lyrics",
    read: (body) => extractSunoLyrics(body),
  });
  return { ...written, model: options.model };
}

/**
 * OpenAI-compatible text-to-speech. Answers with audio bytes, which become a data URL so the caller
 * mirrors it into the media store exactly like a generated clip.
 */
export async function generateGatewaySpeech(options: GatewaySpeechOptions): Promise<{ url: string; model: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const origin = options.baseUrl.replace(/\/+$/, "");
  const format = options.format ?? "mp3";
  const response = await fetchImpl(`${origin}/audio/speech`, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify({
      model: options.model,
      input: options.text,
      ...(options.voice ? { voice: options.voice } : {}),
      response_format: format,
    }),
  });
  if (!response.ok) {
    const body = asRecord(await response.json().catch(() => ({})));
    const detail = readGatewayError(body, `Gateway speech returned HTTP ${response.status}`);
    throw new GatewayRefusalError("tool_failed", detail, httpStatusForGatewayFailure(response.status), {
      status: response.status,
      code: gatewayErrorCode(body),
      message: detail,
    });
  }
  const served = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const mime = served.startsWith("audio/") ? served : `audio/${format === "mp3" ? "mpeg" : format}`;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ApiError("tool_failed", "Gateway speech returned no audio", 502);
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return { url: `data:${mime};base64,${btoa(binary)}`, model: options.model };
}

// --------------------------------------------------------------------------------- Omni speech

/** Raw PCM from the Omni stream: signed 16-bit little-endian, mono, 24 kHz (driven 2026-11-11). */
const OMNI_SAMPLE_RATE = 24_000;
export const OMNI_DEFAULT_VOICE = "Tina";

export type GatewayOmniSpeechOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  voice?: string;
  fetchImpl?: typeof fetch;
};

/** A 44-byte RIFF header in front of raw PCM16 mono, so a browser can play what the stream sent. */
export function wavFromPcm16(pcm: Uint8Array, sampleRate = OMNI_SAMPLE_RATE): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      header.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  write(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header.buffer), 0);
  wav.set(pcm, 44);
  return wav;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The audio chunks (base64 PCM16) in an SSE body of chat-completion deltas, in order. */
export function omniAudioChunks(sse: string): string[] {
  const chunks: string[] = [];
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const choices = asRecord(event).choices;
    const delta = Array.isArray(choices) ? asRecord(asRecord(choices[0]).delta) : {};
    const data = asString(asRecord(delta.audio).data);
    if (data) {
      chunks.push(data);
    }
  }
  return chunks;
}

/**
 * Text to speech through a chat model that speaks (an Omni id), for a gateway whose `/v1/audio/speech`
 * serves no model. Driven on 2026-11-11 with `qwen3.5-omni-flash` and voice Tina: the streaming chat
 * call with `modalities: ["audio", "text"]` answers PCM deltas, 4.5 s of audio in 1.3 s. The result is
 * a WAV data URL, the same shape `generateGatewaySpeech` answers, so the caller does not care which wire ran.
 */
export async function generateGatewayOmniSpeech(
  options: GatewayOmniSpeechOptions,
): Promise<{ url: string; model: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify({
      model: options.model,
      stream: true,
      modalities: ["audio", "text"],
      audio: { voice: options.voice?.trim() || OMNI_DEFAULT_VOICE, format: "wav" },
      messages: [
        {
          role: "user",
          content: `Read the following text aloud exactly as written, and say nothing else:\n\n${options.text}`,
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = asRecord(await response.json().catch(() => ({})));
    const detail = readGatewayError(body, `Gateway speech returned HTTP ${response.status}`);
    throw new GatewayRefusalError("tool_failed", detail, httpStatusForGatewayFailure(response.status), {
      status: response.status,
      code: gatewayErrorCode(body),
      message: detail,
    });
  }
  const chunks = omniAudioChunks(await response.text());
  if (chunks.length === 0) {
    throw new ApiError("tool_failed", "Gateway speech returned no audio", 502);
  }
  const parts = chunks.map(base64ToBytes);
  const pcm = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.byteLength;
  }
  const wav = wavFromPcm16(pcm);
  let binary = "";
  for (const byte of wav) {
    binary += String.fromCharCode(byte);
  }
  return { url: `data:audio/wav;base64,${btoa(binary)}`, model: options.model };
}
