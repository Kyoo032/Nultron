/**
 * Host media paths that the packaged renderer must load through the agentforge:// scheme
 * (its window is a file:// page; relative /api paths have nowhere to go). Each entry maps a
 * host route to the protocol hostname the desktop shell registers for it (apps/desktop/main.cjs).
 */
const DESKTOP_MEDIA_ROUTES: ReadonlyArray<{ pattern: RegExp; host: string }> = [
  { pattern: /\/api\/v1\/media\/([^/?#]+)\/file/, host: "media" },
  { pattern: /\/api\/v1\/videos\/examples\/([^/?#]+)\/file/, host: "video-example" },
];

/** The URL a `<video>` / `<img>` should use for a host media path, in the browser or in the desktop shell. */
export function desktopMediaSrc(url: string, electron: boolean): string {
  if (!electron) {
    return url;
  }
  for (const route of DESKTOP_MEDIA_ROUTES) {
    const match = url.match(route.pattern);
    if (match?.[1]) {
      return `agentforge://${route.host}/${match[1]}`;
    }
  }
  return url;
}

/**
 * The stored media id a chat picture or clip points at, from its `src` in either form: the host path
 * (`/api/v1/media/<id>/file`) or the desktop shell's `agentforge://media/<id>`. Null for anything else, such as
 * a remote link or a video example, which cannot be put into a Workspace.
 */
export function mediaIdFromSrc(src: string | undefined): string | null {
  if (!src) {
    return null;
  }
  const match = src.match(/(?:\/api\/v1\/media\/|agentforge:\/\/media\/)([0-9a-f-]{36})(?:\/file|\/)?(?:[?#]|$)/i);
  return match?.[1] ?? null;
}
