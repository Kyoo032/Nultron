/**
 * How the portal signs people in, as the portal says it: `GET {AGENTFORGE_PORTAL_URL}/auth/signin-mode`.
 *
 * The portal can run two ways (`apps/portal/src/config.ts`, `PORTAL_SIGNIN_MODE`): an e-mailed one-time
 * code, which is the default and the only way before 2026-10-07, or a username and a password. The
 * sign-in screen of this app has to tell the person which one they are about to meet, and it must not
 * guess: a guess in the renderer is a screen that says "we email you a code" in front of a portal that
 * sends none. So the host asks the portal, and the renderer is told (`GET /api/v1/auth/session`).
 *
 * **The default is `code`, and only the portal's own word changes it.** The portal registers the route
 * only in password mode, so a portal in the default mode, and a portal older than the route, answer
 * 404, and that is read as `code`. Anything else that is not an affirmative `{"mode":"password"}` is
 * not a reason to say "password" either: a 5xx, a timeout, a redirect, an HTML page from a proxy. An
 * answer the host cannot read is "I do not know", which is shown as `code` (what the screen has always
 * said) and asked again later, never cached as if it were a fact.
 *
 * It never blocks a page for long. The first read waits at most `timeoutMs` for the portal; after
 * that, a known answer is returned at once and refreshed behind it when it has gone stale, so a slow
 * or unreachable portal costs the sign-in screen nothing once it has been heard from once. Only the
 * portal's origin is used, and only the one path: nothing in this request comes from a person.
 *
 * Hosted only. A desk (Personal, webdev) has no portal and never constructs this (`./index.ts` passes
 * a reader only when `isServerMode()`), so the desktop makes no request and its screens are untouched.
 */
import type { EnvLike } from "@agentforge/core";
import { portalBaseUrl } from "./portal-client";

export type SignInMode = "code" | "password";

/** The portal's discovery path. Registered by the portal only in password mode. */
export const PORTAL_SIGNIN_MODE_PATH = "/auth/signin-mode";

/** Longest the first, uncached read waits for the portal. A sign-in screen is waiting on it. */
export const PORTAL_MODE_TIMEOUT_MS = 1500;
/** How long an answer is believed before it is asked for again (behind the answer, never in front of it). */
export const PORTAL_MODE_FRESH_MS = 5 * 60 * 1000;
/** After a failure, how long before the portal is asked again. */
export const PORTAL_MODE_RETRY_MS = 15 * 1000;

export interface PortalModeReader {
  /** The mode, or `code` when the portal has not said otherwise. Never throws. */
  read(): Promise<SignInMode>;
}

export interface PortalModeOptions {
  readonly env?: EnvLike;
  /** Tests only: the portal's origin without the environment. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly freshMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
}

type Answer = { readonly kind: "known"; readonly mode: SignInMode } | { readonly kind: "unknown" };

const UNKNOWN: Answer = Object.freeze({ kind: "unknown" });

/** One answer from the portal, read exactly: only a clean 200 with a `mode` string, or a 404, is known. */
async function ask(base: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Answer> {
  let response: Response;
  try {
    response = await fetchImpl(`${base}${PORTAL_SIGNIN_MODE_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // A redirect is somebody else's page. It is not the portal answering.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return UNKNOWN;
  }
  if (response.status === 404) {
    return { kind: "known", mode: "code" };
  }
  if (response.status !== 200) {
    return UNKNOWN;
  }
  try {
    const body = (await response.json()) as { mode?: unknown } | null;
    if (body?.mode === "password") {
      return { kind: "known", mode: "password" };
    }
    return body?.mode === "code" ? { kind: "known", mode: "code" } : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export function createPortalModeReader(options: PortalModeOptions = {}): PortalModeReader {
  const clock = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PORTAL_MODE_TIMEOUT_MS;
  const freshMs = options.freshMs ?? PORTAL_MODE_FRESH_MS;
  const retryMs = options.retryMs ?? PORTAL_MODE_RETRY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let known: { readonly mode: SignInMode; readonly at: number } | null = null;
  /** Not before this instant: set by a failure, so a portal that is down is not asked on every page. */
  let notBefore = 0;
  let inflight: Promise<void> | null = null;

  const heard = (): { readonly mode: SignInMode; readonly at: number } | null => known;

  function base(): string | null {
    try {
      return options.baseUrl ?? portalBaseUrl(options.env);
    } catch {
      // No usable portal URL: the deployment is misconfigured, and the sign-in screen already says so
      // through `login_not_configured`. Nothing to ask.
      return null;
    }
  }

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        const url = base();
        const answer = url === null ? UNKNOWN : await ask(url, fetchImpl, timeoutMs);
        if (answer.kind === "known") {
          known = { mode: answer.mode, at: clock() };
          notBefore = 0;
        } else {
          notBefore = clock() + retryMs;
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async read(): Promise<SignInMode> {
      const now = clock();
      if (known && now - known.at < freshMs) {
        return known.mode;
      }
      if (known) {
        // Stale: answer with what was heard, and ask again behind it (not while a failure is backing off).
        if (now >= notBefore) {
          void refresh();
        }
        return known.mode;
      }
      if (now < notBefore) {
        return "code";
      }
      await refresh();
      // Read through a function: `refresh` set `known` from inside, which narrowing above cannot see.
      return heard()?.mode ?? "code";
    },
  };
}
