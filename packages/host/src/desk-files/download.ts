/**
 * How a desk file leaves the host as a download.
 *
 * The body is text a person or a model wrote, and on the hosted app it is served from the app's own
 * origin. So it follows the artifact file route (`handlers/artifacts.ts`, the hosted XSS audit): always
 * an attachment, never sniffed, sandboxed in its own policy, and a type the browser would not render.
 * A file the person edits must also never come back from a cache, which the adapter's default for any
 * bytes result (an hour, private) would allow.
 *
 * `mimeForPath` is a label for the file list. Of its types only plain text kinds are named here; an
 * `.html` or `.xml` file is sent as `application/octet-stream`. The saved copy keeps its own name and
 * extension, so nothing is lost: the type on the wire only decides what a browser does with it first.
 */
import { contentDispositionAttachment } from "../content-disposition";
import { mimeForPath } from "./mime";

/** The text types a download may name. Anything else `mimeForPath` can return is sent inert. */
const NAMED_TEXT_TYPES: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/yaml",
]);

export const DESK_FILE_INERT_TYPE = "application/octet-stream";

export type DeskFileDelivery = {
  readonly contentType: string;
  readonly filename: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** The last part of a desk path: the name the saved file gets. A desk path has no empty parts. */
export function deskFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function deskFileDelivery(path: string): DeskFileDelivery {
  const label = mimeForPath(path);
  const filename = deskFileName(path);
  return {
    contentType: NAMED_TEXT_TYPES.has(label) ? `${label}; charset=utf-8` : DESK_FILE_INERT_TYPE,
    filename,
    headers: {
      "Content-Disposition": contentDispositionAttachment(filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "no-store",
    },
  };
}
