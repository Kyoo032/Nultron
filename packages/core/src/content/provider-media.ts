import type { AppLocale } from "../locale";
import { isLoopbackHost } from "../security/tls";
import { imageUnreadableMessage } from "./image-copy";

const LOCAL_MEDIA_PATH = /\/api\/v1\/media\/([0-9a-f-]{36})\/file\/?$/i;
const RELATIVE_MEDIA_PREFIX = /^\/api\/v1\/media\//i;
/**
 * What a tool's own image output becomes on a later model step: the picture was generated here and is
 * already on the person's screen, and the line says only that. It is not used for an image the person
 * attached; that one is sent as pixels or refused (`imagePartForProvider`).
 */
const LOCAL_IMAGE_PLACEHOLDER = "[Image attached in the local app. It is already shown to the user.]";
const URL_KEYS = new Set(["image_url", "imageUrl", "image", "url"]);

export function localMediaId(url: string): string | null {
  const trimmed = url.trim();
  const relative = trimmed.match(/^\/api\/v1\/media\/([0-9a-f-]{36})\/file\/?$/i);
  if (relative?.[1]) {
    return relative[1].toLowerCase();
  }
  try {
    const parsed = new URL(trimmed);
    const match = parsed.pathname.match(LOCAL_MEDIA_PATH);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** True when a remote inference host cannot fetch this URL (loopback or app-relative media). */
export function isUnreachableProviderMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) {
    return false;
  }
  // An address has a scheme ("http:") or is this app's own relative media path. A picture's raw base64 (the
  // Anthropic and Gemini wires carry it with no `data:` prefix) has neither, and `new URL` would still read
  // all of its megabytes, twice, to say so. Without a colon `new URL` can only throw, so the answer is no.
  if (!trimmed.includes(":") && !RELATIVE_MEDIA_PREFIX.test(trimmed)) {
    return false;
  }
  if (localMediaId(trimmed)) {
    return true;
  }
  try {
    return isLoopbackHost(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

/**
 * An image in the person's own turn, as the provider part the AI SDK sends.
 *
 * A data URL or an https URL the gateway can fetch goes through. Anything else is a reference only this
 * machine can open (`/api/v1/media/<id>/file`, a loopback address), and **it throws**. It used to become
 * a sentence saying an image was attached, so the model was told a picture existed and was never given
 * it. The host turns a stored media id into a data URL before the run (`chat-image-history.ts`); a
 * reference that is still here means that did not happen, and the person must hear it, not the model.
 */
export function imagePartForProvider(url: string, locale: AppLocale = "en"): { type: "image"; image: string } {
  if (url.startsWith("data:") || (url.startsWith("https://") && !isUnreachableProviderMediaUrl(url))) {
    return { type: "image", image: url };
  }
  throw new Error(imageUnreadableMessage(locale));
}

/**
 * True when a message the person wrote carries an image part. An assistant's image (a generated picture
 * kept in the thread) is never sent to a model, so it must not make a later, unrelated gateway refusal
 * read as "could not accept the image you attached".
 */
export function historyHasImage(
  history: ReadonlyArray<{ role: string; parts: ReadonlyArray<{ type: string }> }>,
): boolean {
  return history.some((item) => item.role === "user" && item.parts.some((part) => part.type === "image_url"));
}

export function scrubUnreachableMediaArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of ["image_url", "imageUrl", "image"]) {
    const value = next[key];
    if (typeof value === "string" && isUnreachableProviderMediaUrl(value)) {
      delete next[key];
    }
  }
  return next;
}

/**
 * Strip loopback / relative media URLs from an OpenAI-compatible request body.
 * The gateway SSRF-blocks port 3000; tool-call args in a later step still carry the original URL.
 */
export function rewriteUnreachableMediaInJson(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      /127\.0\.0\.1|localhost|\/api\/v1\/media\//i.test(trimmed)
    ) {
      try {
        return JSON.stringify(rewriteUnreachableMediaInJson(JSON.parse(trimmed)));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(rewriteUnreachableMediaInJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  const imageUrl = record.image_url;
  if (type === "image_url" && imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as { url?: unknown }).url;
    if (typeof url === "string" && isUnreachableProviderMediaUrl(url)) {
      return { type: "text", text: LOCAL_IMAGE_PLACEHOLDER };
    }
  }
  if (
    (type === "image" || type === "input_image") &&
    typeof record.image === "string" &&
    isUnreachableProviderMediaUrl(record.image)
  ) {
    return { type: "text", text: LOCAL_IMAGE_PLACEHOLDER };
  }
  if (
    (type === "image" || type === "input_image") &&
    typeof record.image_url === "string" &&
    isUnreachableProviderMediaUrl(record.image_url)
  ) {
    return { type: "text", text: LOCAL_IMAGE_PLACEHOLDER };
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // The key first: it is a lookup, and the matcher reads the whole string. A picture's bytes sit under
    // `data` on the Anthropic and Gemini wires, and are never asked about.
    if (typeof child === "string" && URL_KEYS.has(key) && isUnreachableProviderMediaUrl(child)) {
      continue;
    }
    next[key] = rewriteUnreachableMediaInJson(child);
  }
  return next;
}
