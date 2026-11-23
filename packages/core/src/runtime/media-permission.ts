/**
 * Paid media permission (SR-167). A model that starts a picture or a clip spends the person's money, so
 * in a run that carries this gate it may not do it on its own word: `image_generate` and
 * `video_generate` return a `permission` refusal instead of running, and the screen shows the request
 * on a card with a Run control. Pressing Run sends the next turn with a grant for exactly that request;
 * the gate lets one call with the same arguments through, once per grant.
 *
 * Only the person's client sends a grant (the turn's body), and a grant is matched on the call's own
 * arguments, so a model cannot spend more than the card showed, and text in a page or a file cannot press
 * Run. There is no ceiling on how many requests a person may Run: it is their key and their choice.
 *
 * The gate sits in `invokeToolGuarded`, so the live and stub runtimes share it. A run without a gate (the
 * Images and Videos studios, whose Generate is the person's own click) is unchanged. Reverse it by passing
 * no policy: `createMediaPermission` returns nothing and every call runs as before.
 *
 * A model fills fields it was never asked to: a live chat model sends `model: "default"` and an
 * `image_url` of `https://example.com` for a plain text-to-picture ask. Those are placeholders, not choices, so
 * `mediaRequestArgs` leaves them out, and a call that matches a grant runs with the request's own arguments (the
 * ones the card showed), never the model's extras. What runs is what the person saw.
 *
 * What this does not cover: the Edit agent's `generate_image` and `generate_video` (they do not go through
 * these tools), and a request the person Runs on a card whose price estimate was wrong: the estimate is a
 * list price, not a quote (`docs/internal/maps/media-cost-estimate.md`).
 */

import { DEFAULT_GATEWAY_IMAGE_MODEL, DEFAULT_GATEWAY_VIDEO_MODEL } from "../models/media-kind";
import { imageModelForReference } from "../models/media-params";

export const PAID_MEDIA_TOOLS = ["image_generate", "video_generate"] as const;

export type PaidMediaTool = (typeof PAID_MEDIA_TOOLS)[number];

export function isPaidMediaTool(key: string): key is PaidMediaTool {
  return (PAID_MEDIA_TOOLS as readonly string[]).includes(key);
}

/** The arguments that decide what a request makes and costs, per tool. Anything else is not part of it. */
const REQUEST_FIELDS: Readonly<Record<PaidMediaTool, readonly string[]>> = {
  image_generate: ["prompt", "aspect_ratio", "size", "style", "image_url", "model"],
  video_generate: ["prompt", "aspect_ratio", "image_url", "model", "seconds", "resolution"],
};

export type MediaRequestArgs = Readonly<Record<string, string | number>>;

/** One request, as the card shows it and as a grant names it. */
export type MediaRequest = {
  readonly tool: PaidMediaTool;
  readonly args: MediaRequestArgs;
};

export type MediaPermissionPolicy = {
  /** False turns the gate off: every call runs. The host sets it true for a model-driven run. */
  readonly ask: boolean;
  /** One entry per call the person pressed Run on; each lets one call with the same arguments through. */
  readonly grants: readonly MediaRequest[];
};

/** What the tool returns, instead of running, when the person has not pressed Run on the request. */
export type MediaPermissionRefusal = {
  readonly ok: false;
  readonly reason: "permission";
  readonly message: string;
  readonly request: MediaRequest;
  /** The model the tool will use when the request names none, so the card can price it. Not part of the request's identity. */
  readonly defaultModel?: string;
};

/** The model this host runs a picture or a clip on when a request names none, or nothing when the host sets none. */
export type HostMediaModel = (tool: PaidMediaTool) => string | undefined;

export type MediaPermission = {
  /** Null when the call may run; the refusal to hand the model, and run nothing, when it may not. */
  beforeCall(toolKey: string, args: unknown): MediaPermissionRefusal | null;
  /** The arguments a call that `beforeCall` let through runs with: the request's own fields, none of the model's extras. */
  argsToRun(toolKey: string, args: unknown): unknown;
};

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Words a model writes for "nothing chosen". `style: "none"` is one: it adds nothing, same as leaving it out. */
const NO_CHOICE = new Set(["", "null", "none", "undefined", "n/a", "na", "default", "auto", "unspecified", "unknown", "string", "-"]);

/** Hosts and top-level names RFC 2606 reserves for examples: a picture URL there is a placeholder, not a source. */
const EXAMPLE_HOST = /(^|\.)example\.(com|org|net|edu)$|\.(test|example|invalid)$/i;

function isPlaceholderUrl(text: string): boolean {
  try {
    return EXAMPLE_HOST.test(new URL(text).hostname);
  } catch {
    return false;
  }
}

function isPlaceholder(field: string, text: string): boolean {
  return NO_CHOICE.has(text.toLowerCase()) || (field === "image_url" && isPlaceholderUrl(text));
}

/**
 * The fields of a call that name the request: strings collapsed to single spaces, empty and placeholder ones
 * dropped (never the prompt), finite numbers kept. A model that repeats a request with a stray newline in the prompt is still repeating it.
 */
export function mediaRequestArgs(tool: PaidMediaTool, args: unknown): MediaRequestArgs {
  const source = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const picked: Record<string, string | number> = {};
  for (const field of REQUEST_FIELDS[tool]) {
    const value = source[field];
    if (typeof value === "string") {
      const text = collapse(value);
      if (text && !(field !== "prompt" && isPlaceholder(field, text))) {
        picked[field] = text;
      }
    } else if (typeof value === "number" && Number.isFinite(value)) {
      picked[field] = value;
    }
  }
  return picked;
}

/** The identity of a request: the tool and its request fields, whatever order the model wrote them in. */
export function mediaRequestKey(tool: PaidMediaTool, args: unknown): string {
  const picked = mediaRequestArgs(tool, args);
  const pairs = Object.keys(picked)
    .sort()
    .map((field) => [field, picked[field]]);
  return JSON.stringify([tool, pairs]);
}

const REFUSAL_COPY: Readonly<Record<PaidMediaTool, string>> = {
  image_generate:
    "Not started: making a picture costs money, and the person has not pressed Run on this one. A card with the details is on their screen. Say in one line what you would make, then stop and wait. Do not call this tool again in this turn.",
  video_generate:
    "Not started: making a clip costs money, and the person has not pressed Run on this one. A card with the details is on their screen. Say in one line what you would make, then stop and wait. Do not call this tool again in this turn.",
};

/**
 * What the tool itself falls back to when the request names no model: the host's setting if it has one, then the
 * built-in default. The host's setting is read by the caller (`hostModel`), because the web screen imports this
 * module for the card and a secret store is server-only.
 */
function defaultModelFor(tool: PaidMediaTool, hostModel: HostMediaModel | undefined, withPicture: boolean): string {
  const chosen = hostModel?.(tool) || (tool === "image_generate" ? DEFAULT_GATEWAY_IMAGE_MODEL : DEFAULT_GATEWAY_VIDEO_MODEL);
  // The tool runs a picture to edit on the id that has an edit route (`gatewayGenerateModel`), so the card names that one.
  return tool === "image_generate" && withPicture ? imageModelForReference(chosen) : chosen;
}

function refusalFor(tool: PaidMediaTool, args: unknown, hostModel: HostMediaModel | undefined): MediaPermissionRefusal {
  const request = { tool, args: mediaRequestArgs(tool, args) };
  const base = { ok: false, reason: "permission", message: REFUSAL_COPY[tool], request } as const;
  const withPicture = typeof request.args.image_url === "string" && request.args.image_url.length > 0;
  return typeof request.args.model === "string"
    ? base
    : { ...base, defaultModel: defaultModelFor(tool, hostModel, withPicture) };
}

export function isMediaPermissionRefusal(value: unknown): value is MediaPermissionRefusal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const request = record.request as Record<string, unknown> | undefined;
  return (
    record.ok === false &&
    record.reason === "permission" &&
    typeof record.message === "string" &&
    request != null &&
    typeof request.tool === "string" &&
    isPaidMediaTool(request.tool)
  );
}

/**
 * One gate for one `execute`. The runtime makes it once, ahead of every attempt, so a retry cannot hand the
 * model a grant a second time. Returns nothing for a policy that asks nothing.
 */
export function createMediaPermission(
  policy: MediaPermissionPolicy | undefined,
  hostModel?: HostMediaModel,
): MediaPermission | undefined {
  if (!policy || !policy.ask) {
    return undefined;
  }
  const open = new Map<string, number>();
  for (const grant of policy.grants) {
    const key = mediaRequestKey(grant.tool, grant.args);
    open.set(key, (open.get(key) ?? 0) + 1);
  }
  return {
    beforeCall(toolKey, args) {
      if (!isPaidMediaTool(toolKey)) {
        return null;
      }
      const key = mediaRequestKey(toolKey, args);
      const left = open.get(key) ?? 0;
      if (left > 0) {
        open.set(key, left - 1);
        return null;
      }
      return refusalFor(toolKey, args, hostModel);
    },
    argsToRun(toolKey, args) {
      return isPaidMediaTool(toolKey) ? mediaRequestArgs(toolKey, args) : args;
    },
  };
}

/**
 * What the model is told on a turn that carries grants: the person pressed Run, here are the exact calls.
 * Empty when there is none. Added to the system prompt for that turn only; it is never stored in the thread.
 */
export function mediaGrantNote(grants: readonly MediaRequest[]): string {
  if (grants.length === 0) {
    return "";
  }
  const lines = grants.map((grant) => `- ${grant.tool} with ${JSON.stringify(grant.args)}`);
  return [
    "",
    "",
    "The person pressed Run on these paid requests. Make each one now by calling its tool with exactly these arguments and no others (leave every other field out, including image_url and model), then tell them what you made:",
    ...lines,
  ].join("\n");
}
