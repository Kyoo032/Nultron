import { homedir, tmpdir } from "node:os";
import { scanInjection } from "../security/injection-guard";
import { maskPii } from "../security/pii";
import { redactSecrets } from "../security/redact";

/** What the model reads when a tool it called threw. Same shape as the budget and egress refusals. */
export type ToolErrorResult = { ok: false; reason: "tool_error"; message: string };

/** The whole message stays under this; the detail is cut first, so the advice at the end is never lost. */
export const TOOL_ERROR_MESSAGE_MAX_CHARS = 400;
const DETAIL_MAX_CHARS = 220;
const ADVICE =
  "Fix the arguments or try another way; if it still fails, tell the person plainly what could not be done.";

const HOST_PATH = "[host path]";
const FILE_URL = /file:\/\/\S*/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'`)\]]*/g;
/**
 * An absolute path under a root that only a host has (`/home/app/x`, `/etc/passwd`). Not every absolute
 * path: `/workspace/out/x.csv` is the sandbox's and `/notes/plan.md` is a desk path the model typed, and
 * the model needs both to fix its call. The process's own home, temp and working directories are removed
 * by value as well, whatever they are called.
 */
const POSIX_PATH = /(^|[\s"'`(=])\/(?:home|Users|tmp|app|srv|var|etc|opt|usr|root|mnt|private)(?:\/[\w.@~+-]+)+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where this process lives, so the places it names are removed by value as well as by shape. */
function knownHostPlaces(): string[] {
  const unique = new Set<string>();
  for (const place of [homedir(), tmpdir(), process.cwd()]) {
    if (place && place.length >= 4) {
      unique.add(place);
      unique.add(place.replaceAll("\\", "/"));
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

function scrubHost(text: string): string {
  let scrubbed = text;
  for (const place of knownHostPlaces()) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(place), "gi"), HOST_PATH);
  }
  return scrubbed
    .replace(FILE_URL, HOST_PATH)
    .replace(WINDOWS_PATH, HOST_PATH)
    .replace(POSIX_PATH, (_match, lead: string) => `${lead}${HOST_PATH}`);
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

/**
 * The failure of one tool call, as words the model can act on. It carries what went wrong (a host-written
 * message such as a bad argument, or the tool's own error) with keys and bearer tokens masked, host
 * paths removed and the length capped, because an OS or network error can quote a path, a header or a
 * URL the model has no business reading. It never carries a stack.
 *
 * The detail is quoted, so words a provider, a page or a file chose read as a quotation and never as the
 * host's own advice. An error text that matches an injection rule is left out whatever the tool's trust:
 * a tool marked `internal` can still throw a third party's words (a gateway's error body on a
 * bring-your-own-key desk), and the model must not take them for a command. Pass
 * `scanForInstructions: false` only when the owner turned the injection guard off.
 */
export function toolErrorResult(
  error: unknown,
  toolKey: string,
  options: { scanForInstructions?: boolean } = {},
): ToolErrorResult {
  const cleaned = maskPii(scrubHost(redactSecrets(detailOf(error))))
    .replace(/\s+/g, " ")
    .trim();
  const withheld = options.scanForInstructions !== false && scanInjection(cleaned) !== null;
  const shown = cleaned.length > DETAIL_MAX_CHARS ? `${cleaned.slice(0, DETAIL_MAX_CHARS - 1)}…` : cleaned;
  // A double quote inside the detail would close the quotation early, so it becomes a single quote.
  const quoted = shown.replaceAll('"', "'");
  const what = withheld
    ? `failed, and its error text was withheld because it read like instructions.`
    : quoted
      ? `failed with: "${quoted}".`
      : "failed without saying why.";
  const message = `The ${toolKey} tool ${what} ${ADVICE}`;
  return {
    ok: false,
    reason: "tool_error",
    message:
      message.length > TOOL_ERROR_MESSAGE_MAX_CHARS
        ? `${message.slice(0, TOOL_ERROR_MESSAGE_MAX_CHARS - 1)}…`
        : message,
  };
}

/**
 * True while a signal the run owns has fired. A tool that threw during a cancel (the person left, the
 * stall guard fired) must keep throwing, so the run stops as a cancelled run; only an error on a live
 * run is a tool's own failure the model can recover from.
 */
export function isRunAbort(...signals: ReadonlyArray<AbortSignal | undefined>): boolean {
  return signals.some((signal) => signal?.aborted === true);
}
