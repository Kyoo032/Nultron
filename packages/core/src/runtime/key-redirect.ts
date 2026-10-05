import { isRedirectStatus, redirectRefusedFailure } from "../gateway-http-copy";
import type { AppLocale } from "../locale";
import { isServerMode } from "../server-mode";

/**
 * Enterprise BYOK, Phase A: a request that carries a tenant's provider key never follows a redirect.
 *
 * Node's `fetch` strips `Authorization` when a redirect crosses origins, but not `x-api-key` or
 * `x-goog-api-key`: the headers the Anthropic Messages and Google generateContent wires carry. So a
 * 3xx from a provider, or from whatever sits in front of one, would hand the key to the host its
 * `Location` names. On the hosted server every key-bearing request asks for `redirect: "manual"`
 * and a 3xx answer is an error the person can read.
 *
 * Off the hosted server nothing here changes: the request is built exactly as before and a redirect is
 * followed as before. (Personal sends the gateway key in those two headers too, to the pinned
 * gateway; that exposure is the owner's to decide, not part of this change.)
 */

/** `init` as the key-bearing request should be sent: manual redirects on the hosted server, untouched elsewhere. */
export function withKeyRedirectPolicy(init: RequestInit): RequestInit {
  return isServerMode() ? { ...init, redirect: "manual" } : init;
}

/** Throws the readable refusal when, on the hosted server, the answer was a redirect. A no-op elsewhere. */
export function refuseKeyRedirect(response: Response, locale: AppLocale): void {
  if (isServerMode() && isRedirectStatus(response.status)) {
    // Nothing reads the redirect's body, so let the connection go.
    void response.body?.cancel().catch(() => undefined);
    throw redirectRefusedFailure(response.status, locale);
  }
}

/**
 * A `fetch` for the SDK clients the runtime builds without one of its own (the direct Google,
 * Anthropic and Volcengine paths), or `undefined` off the hosted server so those clients keep the
 * default `fetch` they have always had.
 */
export function directProviderFetch(locale: AppLocale): typeof fetch | undefined {
  if (!isServerMode()) {
    return undefined;
  }
  return async (url, init) => {
    const response = await fetch(url, withKeyRedirectPolicy(init ?? {}));
    refuseKeyRedirect(response, locale);
    return response;
  };
}
