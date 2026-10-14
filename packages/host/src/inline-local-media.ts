import { localMediaId, type ContentPart, type TenantContext } from "@agentforge/core";

/**
 * Job modes: swap each stored `/api/v1/media/<id>/file` image for its bytes, so the model receives the
 * picture. Chat does the same through `chat-image-history.ts`, which also bounds the request.
 *
 * No gateway can open this machine's media URL, and nothing here asks whether the provider is on
 * loopback: every provider gets bytes. (Until 2026-10-06 Chat only inlined for loopback, on the guess
 * that a remote gateway "may reject data URLs", and sent a sentence in place of the image otherwise.)
 *
 * SR-175: a picture is inlined only for the caller it was read for, through the same rule as the file route. A
 * colleague's private picture stays a reference the model cannot open, exactly as a missing one does.
 */
export async function inlineLocalMediaParts(tenant: TenantContext, parts: ContentPart[]): Promise<ContentPart[]> {
  const next: ContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "image_url") {
      next.push(part);
      continue;
    }
    const id = localMediaId(part.image_url.url);
    if (!id) {
      next.push(part);
      continue;
    }
    const { readVisibleMediaDataUrl } = await import("./media-visibility");
    const dataUrl = await readVisibleMediaDataUrl(tenant, id);
    next.push(dataUrl ? { type: "image_url", image_url: { ...part.image_url, url: dataUrl } } : part);
  }
  return next;
}
