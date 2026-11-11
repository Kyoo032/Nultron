import type { AppLocale } from "../../locale";
import { ApiError } from "../../errors";
import { GatewayRefusalError } from "../../models/availability";
import { ratioOf, type ImageChoice, type MediaAdjustment, type VideoSent, type ImageSent } from "../../models/media-params";
import type { PublishedMediaParams } from "../../models/media-params-published";
import { buildImageRequest, buildVideoRequest } from "../../models/media-request";

export {
  GATEWAY_VIDEO_DURATION_SECONDS,
  GATEWAY_VIDEO_RESOLUTION,
  usesSeedanceVideoWire,
  videoCapabilities,
} from "../../models/video-capabilities";
export type { VideoCapabilities } from "../../models/video-capabilities";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type GatewayMediaOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** Video: a ratio such as `16:9`. Image: the legacy shape (`square`, `landscape`, `portrait`) or a ratio. */
  aspectRatio?: string;
  imageUrl?: string;
  seconds?: number;
  /** Video resolution tier such as `720p`. */
  resolution?: string;
  /** Sound inside the clip. Left out means the app's default (off). */
  audio?: boolean;
  /** Image controls: exact size, quality, tier, count, output format. */
  imageChoice?: ImageChoice;
  /** What the gateway published for this model (`config.parameters`); laid over the built-in spec. */
  published?: PublishedMediaParams;
  locale?: AppLocale;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
};

/** What a media call returns beside the result: what was sent, and what had to be moved to get there. */
export type MediaReport<S> = { sent: S; adjusted: MediaAdjustment[] };

/** A route from the gateway origin. The base URL ends in `/v1`; Kling and the other mounts do not live under it. */
function routeUrl(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "")}${route}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function gatewayHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": BROWSER_UA,
  };
}

export function httpStatusForGatewayFailure(status: number): number {
  if (status === 401 || status === 403 || status === 404 || status === 429 || status === 503) {
    return status;
  }
  return 502;
}

export function formatVideoGatewayFailure(status: number, detail: string): string {
  if (status === 503) {
    return `${detail} This video model has no live gateway channel (HTTP 503) on this key right now. Pick another video model; seedance-2.0-fast is one that ran on a prepaid key.`;
  }
  if (isPrepaidAsyncPriceError(detail)) {
    return `${detail} This video model is billed by tokens after the job finishes, and a prepaid agent account cannot submit that kind of job (HTTP 403). Other video models with a fixed price per call do run on a prepaid key, seedance-2.0-fast among them. This is not an invalid API key.`;
  }
  if (status === 401 || status === 403) {
    return `${detail} Gateway rejected the API key (HTTP ${status}). Check Settings.`;
  }
  return detail;
}

const UPSTREAM_REJECTED = /service_unavailable|上游拒绝|upstream (?:rejected|refused|unavailable)/i;

/** A job that the gateway accepted but its upstream provider then refused. Not a key or knob problem. */
export function formatVideoJobFailure(detail: string): string {
  if (UPSTREAM_REJECTED.test(detail)) {
    return `${detail} The gateway's upstream for this video model rejected the job. Try again later or pick another video model.`;
  }
  return detail;
}

export function studioVideoFailureStatus(message: string): number {
  if (/HTTP 503/i.test(message) || /no live gateway channel/i.test(message) || UPSTREAM_REJECTED.test(message)) {
    return 503;
  }
  if (/rejected the API key/i.test(message)) {
    return 401;
  }
  return 400;
}

function isPrepaidAsyncPriceError(detail: string): boolean {
  return /按次价格|预付账户|prepaid_async_requires_fixed_price|prepaid/i.test(detail);
}

export function readGatewayError(body: Record<string, unknown>, fallback: string): string {
  const error = body.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  return gatewayErrorCode(body) ?? fallback;
}

/** NewAPI wraps every reply in `code: "success"`; that is an envelope, never the error. */
const SUCCESS_CODES = /^(success|ok|0|200)$/i;

/**
 * Why a polled video job failed. NewAPI reports it as `data.fail_reason` and mirrors the upstream
 * error under `data.data.error`; the envelope's `code` stays "success", so read the job first.
 */
export function readVideoJobFailure(body: Record<string, unknown>, fallback: string): string {
  const data = asRecord(body.data);
  const jobError = asRecord(data.error);
  const upstreamError = asRecord(asRecord(data.data).error);
  const reason =
    asString(data.fail_reason) ??
    asString(upstreamError.message) ??
    asString(jobError.message) ??
    asString(data.task_status_msg);
  const code = asString(upstreamError.code) ?? asString(jobError.code);
  if (reason) {
    return code && code !== reason ? `${reason} (${code})` : reason;
  }
  return readGatewayError(body, fallback);
}

export function gatewayErrorCode(body: Record<string, unknown>): string | undefined {
  const top = asString(body.code);
  if (top && !SUCCESS_CODES.test(top)) {
    return top;
  }
  const error = body.error;
  if (error && typeof error === "object") {
    return asString((error as { code?: unknown }).code);
  }
  return undefined;
}

/**
 * The image request the person's choices ask for. The legacy `aspectRatio` is a loose shape
 * (`landscape`) or a ratio (`3:2`); an exact size, quality, tier, count or format rides in `imageChoice`.
 */
function imageChoiceOf(options: GatewayMediaOptions): ImageChoice {
  const legacy = options.aspectRatio?.trim();
  const base: ImageChoice =
    legacy === "square" || legacy === "landscape" || legacy === "portrait"
      ? { shape: legacy }
      : legacy && ratioOf(legacy) !== undefined
        ? { aspectRatio: legacy }
        : {};
  return { ...base, ...options.imageChoice };
}

function imageMime(format: string | undefined): string {
  return format === "jpeg" || format === "jpg" ? "image/jpeg" : "image/png";
}

function pictureFrom(item: Record<string, unknown>, mime: string): string | undefined {
  const url = asString(item.url) ?? asString(asRecord(item.file_output).public_url);
  if (url) {
    return url;
  }
  const b64 = asString(item.b64_json);
  return b64 ? `data:${mime};base64,${b64}` : undefined;
}

/** Every picture a reply carries, in order. A model that was asked for one image returns one. */
export function parseGatewayImages(body: Record<string, unknown>, mime = "image/png"): string[] {
  const data = body.data;
  if (Array.isArray(data)) {
    const found = data
      .map((item) => pictureFrom(asRecord(item), mime))
      .filter((item): item is string => typeof item === "string");
    if (found.length > 0) {
      return found;
    }
  } else if (data && typeof data === "object") {
    const record = asRecord(data);
    const nestedData = record.data;
    const nestedFirst = Array.isArray(nestedData) ? asRecord(nestedData[0]) : {};
    const url =
      asString(record.result_url) ??
      asString(record.url) ??
      asString(asRecord(record.file_output).public_url) ??
      asString(nestedFirst.url) ??
      asString(asRecord(nestedFirst.file_output).public_url);
    if (url) {
      return [url];
    }
    const b64 = asString(record.b64_json) ?? asString(nestedFirst.b64_json);
    if (b64) {
      return [`data:${mime};base64,${b64}`];
    }
  }
  const top = asString(body.url) ?? asString(body.result_url);
  return top ? [top] : [];
}

export function parseGatewayImage(body: Record<string, unknown>, mime = "image/png"): string | undefined {
  return parseGatewayImages(body, mime)[0];
}

export function videoTaskId(body: Record<string, unknown>): string | undefined {
  const data = asRecord(body.data);
  return asString(body.task_id) ?? asString(body.id) ?? asString(data.task_id) ?? asString(data.id);
}

/** A failed NewAPI job copies its fail reason into `result_url`; only http(s) or data URLs are results. */
function looksLikeMediaUrl(value: string | undefined): string | undefined {
  return value && /^(https?:\/\/|data:)/i.test(value) ? value : undefined;
}

/** Kling's own result shape: `data.task_result.videos[0].url`. Read from Kling's public API; not driven live. */
function klingVideoUrl(body: Record<string, unknown>): string | undefined {
  const result = asRecord(asRecord(body.data).task_result);
  const videos = Array.isArray(result.videos) ? result.videos : [];
  return asString(asRecord(videos[0]).url);
}

export function extractGatewayVideoUrl(body: Record<string, unknown>): string | undefined {
  const data = asRecord(body.data);
  const nested = asRecord(data.data);
  const metadata = asRecord(body.metadata ?? data.metadata);
  const video = body.video;
  return looksLikeMediaUrl(
    klingVideoUrl(body) ??
      asString(data.result_url) ??
      asString(data.url) ??
      asString(body.url) ??
      asString(body.video_url) ??
      asString(body.content_url) ??
      asString(data.content_url) ??
      asString(nested.url) ??
      asString(metadata.url) ??
      asString(asRecord(video).url) ??
      asString(asRecord(video).public_url) ??
      asString(video),
  );
}

function mediaStatus(body: Record<string, unknown>): string {
  const data = asRecord(body.data);
  // `task_status` is Kling's word for it (`submitted`, `processing`, `succeed`, `failed`).
  return String(data.status ?? body.status ?? data.task_status ?? body.task_status ?? "").trim();
}

function isMediaSuccess(status: string): boolean {
  return /^(completed|succeeded|success|succeed)$/i.test(status);
}

function isMediaFailure(status: string): boolean {
  return /^(failed|failure|error|cancelled|canceled)$/i.test(status);
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

const IMAGE_TIMEOUT_MESSAGE =
  "Gateway image request timed out. The gateway may already have billed and generated the image — do not retry immediately.";

function isPollEndpointMissing(status: number, body: Record<string, unknown>): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  const message = readGatewayError(body, "").toLowerCase();
  return status === 404 || /invalid url|not found|no such|unknown task/i.test(message);
}

/** A local picture's data URL as a file for a multipart edit request. */
function dataUrlFile(dataUrl: string): Blob {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/is.exec(dataUrl);
  const mime = match?.[1] || "image/png";
  const binary = atob(match?.[2] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

export type GatewayImageResult = { url: string; urls: string[]; model: string } & MediaReport<ImageSent>;

export async function generateGatewayImage(options: GatewayMediaOptions): Promise<GatewayImageResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Every value is settled against the model's spec here: nothing the spec rejects is sent.
  const request = buildImageRequest({
    model: options.model,
    prompt: options.prompt,
    imageUrl: options.imageUrl,
    choice: imageChoiceOf(options),
    published: options.published,
    locale: options.locale,
  });
  const mime = imageMime(request.sent.outputFormat);
  const done = (urls: string[]): GatewayImageResult => ({
    url: urls[0],
    urls,
    model: options.model,
    sent: request.sent,
    adjusted: request.adjustments,
  });
  let init: RequestInit;
  if (request.file) {
    // A local picture is not a URL the gateway can fetch, so it goes up as a file (docs: multipart, field `image`).
    const form = new FormData();
    for (const [key, value] of Object.entries(request.body)) {
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    form.append(request.file.field, dataUrlFile(request.file.dataUrl), "reference.png");
    const { "Content-Type": _contentType, ...headers } = gatewayHeaders(options.apiKey);
    void _contentType;
    init = { method: "POST", headers, body: form, signal: AbortSignal.timeout(180_000) };
  } else {
    init = {
      method: "POST",
      headers: gatewayHeaders(options.apiKey),
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(180_000),
    };
  }
  let response: Response;
  try {
    response = await fetchImpl(routeUrl(options.baseUrl, request.route), init);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ApiError("tool_failed", IMAGE_TIMEOUT_MESSAGE, 504);
    }
    throw error;
  }
  const body = asRecord(await response.json().catch(() => ({})));
  const immediate = parseGatewayImages(body, mime);
  if (immediate.length > 0) {
    return done(immediate);
  }
  const createdStatus = mediaStatus(body);
  if (isMediaFailure(createdStatus)) {
    throw new ApiError(
      "tool_failed",
      readGatewayError(body, asString(asRecord(body.data).fail_reason) ?? "Gateway image job failed"),
      502,
    );
  }
  const taskId = videoTaskId(body);
  if (taskId) {
    const maxPolls = options.maxPolls ?? 90;
    const pollMs = options.pollMs ?? 2_000;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      let statusRes: Response;
      try {
        statusRes = await fetchImpl(routeUrl(options.baseUrl, `/v1/images/generations/${encodeURIComponent(taskId)}`), {
          headers: gatewayHeaders(options.apiKey),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new ApiError("tool_failed", IMAGE_TIMEOUT_MESSAGE, 504);
        }
        throw error;
      }
      const statusBody = asRecord(await statusRes.json().catch(() => ({})));
      const pictures = parseGatewayImages(statusBody, mime);
      const url = pictures[0];
      const status = mediaStatus(statusBody);
      if (url && (isMediaSuccess(status) || status.length === 0)) {
        return done(pictures);
      }
      if (isPollEndpointMissing(statusRes.status, statusBody)) {
        throw new GatewayRefusalError(
          "tool_failed",
          "Gateway image poll endpoint not found — async status lookup is unavailable for this task",
          502,
          {
            status: statusRes.status,
            code: gatewayErrorCode(statusBody),
            message: "image poll endpoint not found",
            phase: "poll",
          },
        );
      }
      if (isMediaFailure(status)) {
        const raw = readGatewayError(
          statusBody,
          asString(asRecord(statusBody.data).fail_reason) ?? "Gateway image job failed",
        );
        throw new GatewayRefusalError("tool_failed", raw, 502, {
          status: statusRes.status,
          code: gatewayErrorCode(statusBody),
          message: raw,
          // Accepted at submit; the job's own failure is not a fact about the model.
          phase: "poll",
        });
      }
      if (!statusRes.ok && !url) {
        const raw = readGatewayError(statusBody, `Gateway images poll returned HTTP ${statusRes.status}`);
        throw new GatewayRefusalError("tool_failed", raw, 502, {
          status: statusRes.status,
          code: gatewayErrorCode(statusBody),
          message: raw,
          phase: "poll",
        });
      }
      await wait(pollMs);
    }
    throw new ApiError("tool_failed", "Gateway image job timed out", 504);
  }
  if (!response.ok) {
    const detail = readGatewayError(body, `Gateway images returned HTTP ${response.status}`);
    throw new GatewayRefusalError("tool_failed", detail, 502, {
      status: response.status,
      code: gatewayErrorCode(body),
      message: detail,
    });
  }
  throw new ApiError("tool_failed", "Gateway returned no image data", 502);
}

export type GatewayVideoResult = { url: string; model: string } & MediaReport<VideoSent>;

export async function generateGatewayVideo(options: GatewayMediaOptions): Promise<GatewayVideoResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The route, the body and the status route all come from the model's media parameter spec, and every
  // value is settled against it first: nothing the spec rejects is sent.
  const request = buildVideoRequest({
    model: options.model,
    prompt: options.prompt,
    imageUrl: options.imageUrl,
    choice: {
      aspect: options.aspectRatio,
      seconds: options.seconds,
      resolution: options.resolution,
      audio: options.audio,
    },
    published: options.published,
    locale: options.locale,
  });
  const done = (url: string): GatewayVideoResult => ({
    url,
    model: options.model,
    sent: request.sent,
    adjusted: request.adjustments,
  });
  const created = await fetchImpl(routeUrl(options.baseUrl, request.route), {
    method: "POST",
    headers: gatewayHeaders(options.apiKey),
    body: JSON.stringify(request.body),
  });
  const createdBody = asRecord(await created.json().catch(() => ({})));
  if (!created.ok) {
    const detail = readGatewayError(createdBody, `Gateway video returned HTTP ${created.status}`);
    throw new GatewayRefusalError(
      "tool_failed",
      formatVideoGatewayFailure(created.status, detail),
      httpStatusForGatewayFailure(created.status),
      { status: created.status, code: gatewayErrorCode(createdBody), message: detail },
    );
  }
  const immediate = extractGatewayVideoUrl(createdBody);
  const createdStatus = mediaStatus(createdBody);
  if (immediate && (isMediaSuccess(createdStatus) || createdStatus.length === 0)) {
    return done(immediate);
  }
  const taskId = videoTaskId(createdBody);
  if (!taskId) {
    throw new ApiError("tool_failed", "Gateway video did not return a task id", 502);
  }
  const maxPolls = options.maxPolls ?? 90;
  const pollMs = options.pollMs ?? 2_000;
  const pollUrl = routeUrl(options.baseUrl, request.pollRoute.replace("{id}", encodeURIComponent(taskId)));
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const statusRes = await fetchImpl(pollUrl, {
      headers: gatewayHeaders(options.apiKey),
    });
    const statusBody = asRecord(await statusRes.json().catch(() => ({})));
    const status = mediaStatus(statusBody);
    const url = extractGatewayVideoUrl(statusBody);
    if (url && (isMediaSuccess(status) || status.length === 0)) {
      return done(url);
    }
    if (isMediaFailure(status) || !statusRes.ok) {
      const raw = readVideoJobFailure(statusBody, "Gateway video job failed");
      const detail = formatVideoJobFailure(raw);
      throw new GatewayRefusalError("tool_failed", detail, UPSTREAM_REJECTED.test(detail) ? 503 : 502, {
        status: statusRes.status,
        code: gatewayErrorCode(statusBody),
        message: raw,
        // The gateway accepted this job; its failure says nothing about the model (`availability.ts`).
        phase: "poll",
      });
    }
    await wait(pollMs);
  }
  throw new ApiError("tool_failed", "Gateway video job timed out", 504);
}
