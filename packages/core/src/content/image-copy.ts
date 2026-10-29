import { parseAppLocale, type AppLocale } from "../locale";

/**
 * Words about an image that did not, or could not, reach a model.
 *
 * Two kinds, kept apart on purpose. A **sentence for the person** is app-locale copy (`en`, `id`) and
 * shows in the transcript. A **note to the model** is plain English whatever the desk's language: it is
 * an instruction to the model, not something the person reads, and the model is told in the system
 * prompt which language to answer in.
 *
 * Neither may say an image is attached when it is not. Before 2026-10-06 Chat sent the model a line that
 * read "[Image attached in the local app. It is already shown to the user.]" in place of the picture,
 * and the model said so back: it was told an image existed and could not open it.
 */

/** In place of a video: the app has no way to hand a video to a model in Chat. */
export const VIDEO_NOT_VISIBLE_NOTE =
  "[The person attached a video. This app cannot pass video to you, so you cannot see it. Tell them you cannot watch it. Do not describe it or guess what it shows.]";

/** In place of an earlier image that is not part of this request. */
export const EARLIER_IMAGE_NOT_VISIBLE_NOTE =
  "[The person shared an image earlier in this conversation. It is not part of this request, so you cannot see it. Do not describe it or guess what it shows.]";

const MEDIA_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The note for an earlier image the model cannot see, with its stored reference when the host knows one.
 * The reference is what `image_generate` takes to edit that picture, so the model can name it. A value that
 * is not a media id gets the plain note: only a value of the id's exact shape is ever written into the note.
 */
export function earlierImageNote(mediaId?: string | null): string {
  if (!mediaId || !MEDIA_ID_SHAPE.test(mediaId)) {
    return EARLIER_IMAGE_NOT_VISIBLE_NOTE;
  }
  return `[The person shared an image earlier in this conversation (reference: /api/v1/media/${mediaId}/file). It is not part of this request, so you cannot see it. Do not describe it or guess what it shows. Pass that reference to image_generate to edit it.]`;
}

const UNREADABLE_COPY: Record<AppLocale, string> = {
  en: "An image you attached could not be read from this app, so nothing was sent. Attach it again.",
  id: "Gambar yang Anda lampirkan tidak dapat dibaca dari aplikasi ini, jadi tidak ada yang dikirim. Lampirkan lagi.",
};

export function imageUnreadableMessage(locale: AppLocale = "en"): string {
  return UNREADABLE_COPY[parseAppLocale(locale)];
}

const REMOTE_LINK_COPY: Record<AppLocale, string> = {
  en: "A web link to an image can't be sent to the model. Attach the image itself.",
  id: "Tautan web ke gambar tidak dapat dikirim ke model. Lampirkan gambar itu sendiri.",
};

/**
 * An `https://` image in the person's own Chat turn. The composer never sends one: it uploads the file and
 * sends the stored copy. A request that does is not from the composer, and a link is not sent on, because the
 * AI SDK would fetch it from this machine with no size limit on some wires (`chat-image-history.ts`).
 */
export function imageRemoteLinkMessage(locale: AppLocale = "en"): string {
  return REMOTE_LINK_COPY[parseAppLocale(locale)];
}

const TOO_LARGE_COPY: Record<AppLocale, (megabytes: number) => string> = {
  en: (megabytes) =>
    `These images are too large to send together (over ${megabytes} MB). Send fewer or smaller images.`,
  id: (megabytes) =>
    `Gambar-gambar ini terlalu besar untuk dikirim bersamaan (lebih dari ${megabytes} MB). Kirim lebih sedikit atau gambar yang lebih kecil.`,
};

export function imagesTooLargeMessage(megabytes: number, locale: AppLocale = "en"): string {
  return TOO_LARGE_COPY[parseAppLocale(locale)](megabytes);
}

const REJECTED_COPY: Record<AppLocale, (status: number) => string> = {
  en: (status) =>
    `The model could not accept the image you attached (status_code=${status}). It may not read images, or the file is too large. Choose a model that reads images, or attach a smaller image.`,
  id: (status) =>
    `Model tidak dapat menerima gambar yang Anda lampirkan (status_code=${status}). Model ini mungkin tidak membaca gambar, atau berkasnya terlalu besar. Pilih model yang membaca gambar, atau lampirkan gambar yang lebih kecil.`,
};

/**
 * What a gateway answer meant when the request carried an image. The generic 400 sentence ends "send
 * again with a shorter prompt", which is the wrong advice for a picture. Only a status the gateway uses
 * for a refused input (400, 413, 415, 422) can be this, and a 400 or 422 only when its own words are about
 * the image: a 400 about anything else keeps its usual sentence.
 */
const IMAGE_REFUSAL_WORDS =
  /image|vision|multimodal|multi-modal|modalit|base64|content[ _-]?type|media type|too large|payload/i;

export function imageRejectedMessage(status: number, bodyText: string, locale: AppLocale = "en"): string | null {
  const refusedInput = status === 413 || status === 415;
  const maybeAboutImage = status === 400 || status === 422;
  if (!refusedInput && !(maybeAboutImage && IMAGE_REFUSAL_WORDS.test(bodyText))) {
    return null;
  }
  return REJECTED_COPY[parseAppLocale(locale)](status);
}
