import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext } from "../tenancy/types";
import { z } from "zod";

/**
 * Turns a stored media id into a data URL, for this caller's organization only, or null. The host
 * installs it for a chat run (`runWithMediaReferenceResolver`); core never reads the database.
 */
export type MediaReferenceResolver = (tenant: TenantContext, mediaId: string) => Promise<string | null>;

/** The most image bytes one tool call may carry. Mirrors `CHAT_IMAGE_REQUEST_BYTES` in the host. */
export const TOOL_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

const BARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATIVE_MEDIA_PATH = /^\/api\/v1\/media\/([0-9a-f-]{36})\/file\/?$/i;

const storage = new AsyncLocalStorage<MediaReferenceResolver>();

export function runWithMediaReferenceResolver<T>(resolver: MediaReferenceResolver, fn: () => T): T {
  return storage.run(resolver, fn);
}

/**
 * A media reference the model may pass: `/api/v1/media/<id>/file` or the bare id. Only the relative
 * path counts, so a remote URL that happens to end the same way is still a plain URL.
 */
export function mediaReferenceId(value: string): string | null {
  const trimmed = value.trim();
  if (BARE_ID.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const relative = trimmed.match(RELATIVE_MEDIA_PATH);
  return relative?.[1]?.toLowerCase() ?? null;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Schema for an image input: a URL (as before) or a media reference. Anything else is refused. */
export const imageInputSchema = z
  .string()
  .min(1)
  .refine((value) => isUrl(value) || mediaReferenceId(value) !== null, {
    message: "Pass an image URL, or the reference of an image in this chat (/api/v1/media/<id>/file or the id).",
  });

/** Bytes a data URL puts in the request: its decoded size when base64, else its text. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || !/;base64$/i.test(dataUrl.slice(0, comma))) {
    return dataUrl.length;
  }
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export type ResolvedImageInput = { ok: true; url: string | undefined } | { ok: false; error: string };

const NOT_READABLE = "Image references are not available in this run. Ask for the image to be attached again.";
const NOT_FOUND = "No image with that reference is available in this chat.";

function checkedImage(dataUrl: string): ResolvedImageInput {
  if (!dataUrl.startsWith("data:image/")) {
    return { ok: false, error: "That file is not an image." };
  }
  if (dataUrlBytes(dataUrl) > TOOL_IMAGE_MAX_BYTES) {
    return { ok: false, error: "The image is larger than 6 MB, the limit for an image in a tool call." };
  }
  return { ok: true, url: dataUrl };
}

/**
 * The image a tool sends: a URL as given, a media reference read through the run's resolver, or a
 * data URL checked against the cap. A failure is an error for the model and the person, never bytes.
 */
export async function resolveImageInput(value: string | undefined, tenant: TenantContext): Promise<ResolvedImageInput> {
  if (value === undefined) {
    return { ok: true, url: undefined };
  }
  const mediaId = mediaReferenceId(value);
  if (!mediaId) {
    return value.startsWith("data:") ? checkedImage(value) : { ok: true, url: value };
  }
  const resolver = storage.getStore();
  if (!resolver) {
    return { ok: false, error: NOT_READABLE };
  }
  let dataUrl: string | null;
  try {
    dataUrl = await resolver(tenant, mediaId);
  } catch {
    return { ok: false, error: NOT_READABLE };
  }
  return dataUrl ? checkedImage(dataUrl) : { ok: false, error: NOT_FOUND };
}
