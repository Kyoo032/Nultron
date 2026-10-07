import {
  EARLIER_IMAGE_NOT_VISIBLE_NOTE,
  imageRemoteLinkMessage,
  imageUnreadableMessage,
  imagesTooLargeMessage,
  localMediaId,
  modelImageInput,
  type AppLocale,
  type ContentPart,
  type TenantContext,
} from "@agentforge/core";
import { readMediaDataUrl, statMedia } from "./media";

/**
 * The images in a Chat request, as the model can receive them.
 *
 * A picture the person attaches is stored on this machine and shown in the transcript from there, so
 * the thread holds `/api/v1/media/<id>/file`. A model on the gateway cannot open that, so every image
 * has to leave as bytes (a data URL) or not at all. Until 2026-10-06 only a loopback provider (Ollama)
 * got bytes; for the gateway the runtime swapped the picture for a sentence saying one was attached.
 *
 * Each turn re-reads the whole thread, so every earlier image would be sent again on every later turn.
 * The request is bounded instead: the images in the person's latest message always go (or the turn is
 * refused, never trimmed), and earlier ones follow newest first while they fit. The first earlier image
 * that does not fit, and every one older than it, becomes a note that says the model cannot see it.
 *
 * What may be named is narrow on purpose. The composer sends only the file it uploaded, as
 * `/api/v1/media/<id>/file`, so that is the one reference read from the store, and only when the row is an
 * image; its size is compared to what is left of the budget before any of its bytes are read. A data URL
 * passes. An `https://` link does not: on some wires the AI SDK would fetch it from this machine, with no
 * size limit, so the person is told to attach the image itself.
 */

/**
 * Raw bytes of image in one request. As base64 that is 8 MiB of body, and the AI SDK sends the whole prompt
 * again on every tool step (Chat allows 12), so the budget is paid for 12 times: the body is parsed,
 * checked and written out again each step.
 */
export const CHAT_IMAGE_REQUEST_BYTES = 6 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;

export type ChatTurn = { role: "user" | "assistant"; parts: ContentPart[] };

/** The media store, as this file needs it: a row without its bytes, and then the bytes. */
export type ChatMediaReader = {
  /** The row's kind and stored size. Null when this organization has no such row. */
  stat(tenant: TenantContext, mediaId: string): Promise<{ kind: string; sizeBytes: number } | null>;
  /** The stored bytes as a data URL. Null when they cannot be read. */
  read(tenant: TenantContext, mediaId: string): Promise<string | null>;
};

const STORE: ChatMediaReader = { stat: statMedia, read: readMediaDataUrl };

type Options = {
  model: string;
  locale: AppLocale;
  /** Override `CHAT_IMAGE_REQUEST_BYTES`. Tests only. */
  budgetBytes?: number;
  /** Override the media store. Tests only. */
  media?: ChatMediaReader;
};

const NOTE: ContentPart = { type: "text", text: EARLIER_IMAGE_NOT_VISIBLE_NOTE };

type ImagePart = Extract<ContentPart, { type: "image_url" }>;

function isImagePart(part: ContentPart): part is ImagePart {
  return part.type === "image_url";
}

function hasImage(turn: ChatTurn): boolean {
  return turn.role === "user" && turn.parts.some(isImagePart);
}

/** Bytes a data URL puts in the request: its decoded size when base64, else its text. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || !/;base64$/i.test(dataUrl.slice(0, comma))) {
    return dataUrl.length;
  }
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

type Refusal = "unreadable" | "remote" | "too_large";
type Inspected = { status: "ok"; bytes: number; mediaId: string | null } | { status: Refusal };

/**
 * Whether an image part can go, judged without reading any of a stored file's bytes: a stored image is
 * known by its row (it must exist in this organization and be an image) and its stored size.
 */
async function inspect(
  tenant: TenantContext,
  part: ImagePart,
  media: ChatMediaReader,
  remaining: number,
): Promise<Inspected> {
  const url = part.image_url.url.trim();
  // A data URL first: `localMediaId` would read its megabytes as a URL, and `new URL` gives a data URL a
  // "pathname" that is its whole payload, so one that merely ends like a media path would pass for a reference.
  if (url.startsWith("data:")) {
    const bytes = dataUrlBytes(url);
    return bytes > remaining ? { status: "too_large" } : { status: "ok", bytes, mediaId: null };
  }
  const mediaId = localMediaId(url);
  if (mediaId) {
    const row = await media.stat(tenant, mediaId);
    if (row?.kind !== "image") {
      return { status: "unreadable" };
    }
    return row.sizeBytes > remaining ? { status: "too_large" } : { status: "ok", bytes: row.sizeBytes, mediaId };
  }
  if (url.startsWith("https://")) {
    return { status: "remote" };
  }
  return { status: "unreadable" };
}

type Prepared = { status: "ok"; part: ContentPart; bytes: number } | { status: Refusal };

/** `inspect`, then the bytes of a stored image, checked again: a row's size is written once, at upload. */
async function prepare(
  tenant: TenantContext,
  part: ImagePart,
  media: ChatMediaReader,
  remaining: number,
): Promise<Prepared> {
  const inspected = await inspect(tenant, part, media, remaining);
  if (inspected.status !== "ok") {
    return inspected;
  }
  if (!inspected.mediaId) {
    return { status: "ok", part, bytes: inspected.bytes };
  }
  const dataUrl = await media.read(tenant, inspected.mediaId);
  if (!dataUrl) {
    return { status: "unreadable" };
  }
  const bytes = dataUrlBytes(dataUrl);
  if (bytes > remaining) {
    return { status: "too_large" };
  }
  return { status: "ok", part: { type: "image_url", image_url: { ...part.image_url, url: dataUrl } }, bytes };
}

/** The sentence for the person when the latest message's own image is refused. */
function refusalError(status: Refusal, options: { locale: AppLocale; budgetBytes?: number }): Error {
  if (status === "remote") {
    return new Error(imageRemoteLinkMessage(options.locale));
  }
  if (status === "too_large") {
    const budget = options.budgetBytes ?? CHAT_IMAGE_REQUEST_BYTES;
    return new Error(imagesTooLargeMessage(Math.round(budget / MEGABYTE), options.locale));
  }
  return new Error(imageUnreadableMessage(options.locale));
}

/**
 * Throws, with a sentence for the person, when the images in the person's new message could not be sent:
 * the run says so itself a moment later, but only after the message is stored, which leaves a bubble with
 * no answer. This runs first. It judges each image by its row alone, reads no bytes, and adds the
 * sizes of one message's images against the same budget the run uses.
 */
export async function assertChatImagesSendable(
  tenant: TenantContext,
  parts: ContentPart[],
  options: Pick<Options, "locale" | "budgetBytes" | "media">,
): Promise<void> {
  const images = parts.filter(isImagePart);
  if (images.length === 0) {
    return;
  }
  const budget = options.budgetBytes ?? CHAT_IMAGE_REQUEST_BYTES;
  const media = options.media ?? STORE;
  let used = 0;
  for (const part of images) {
    const inspected = await inspect(tenant, part, media, budget - used);
    if (inspected.status !== "ok") {
      throw refusalError(inspected.status, options);
    }
    used += inspected.bytes;
  }
}

/**
 * Returns the history with each image in its sendable form. Throws an `Error` whose message is already a
 * sentence for the person when the latest message's own images cannot be sent (unreadable, not an image,
 * a link, or together over the limit): the run fails and says so, rather than going out without them.
 */
export async function prepareChatImageHistory(
  tenant: TenantContext,
  history: ChatTurn[],
  options: Options,
): Promise<ChatTurn[]> {
  if (!history.some(hasImage)) {
    return history;
  }
  const budget = options.budgetBytes ?? CHAT_IMAGE_REQUEST_BYTES;
  const media = options.media ?? STORE;
  const modelReads = modelImageInput(options.model) !== "no";
  const latest = history.map((turn) => turn.role).lastIndexOf("user");

  const prepared = new Array<ChatTurn>(history.length);
  let used = 0;
  let closed = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index] as ChatTurn;
    if (!hasImage(turn)) {
      prepared[index] = turn;
      continue;
    }
    const mine = index === latest;
    const parts: ContentPart[] = [];
    let noted = false;
    const note = () => {
      if (!noted) {
        parts.push(NOTE);
        noted = true;
      }
    };
    for (const part of turn.parts) {
      if (!isImagePart(part)) {
        parts.push(part);
        continue;
      }
      if (!modelReads || (!mine && closed)) {
        note();
        continue;
      }
      const ready = await prepare(tenant, part, media, budget - used);
      if (ready.status !== "ok") {
        if (mine) {
          throw refusalError(ready.status, { locale: options.locale, budgetBytes: budget });
        }
        if (ready.status === "too_large") {
          closed = true;
        }
        note();
        continue;
      }
      used += ready.bytes;
      parts.push(ready.part);
    }
    prepared[index] = { ...turn, parts };
  }
  return prepared;
}
