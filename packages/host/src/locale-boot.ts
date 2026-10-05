import { isServerMode, localeFromAcceptLanguage, type AppLocale } from "@agentforge/core";
import {
  FALLBACK_SETTINGS_WORKSPACE,
  loadOwnerLocale,
  loadUserLocale,
  loadUserLocaleChoice,
  type UserScope,
} from "./settings-store";

let frozen: AppLocale | null = null;

/**
 * Locale locked when this process first read owner settings.
 * Saving a new language does not change it. There is no product env override
 * (`AGENTFORGE_LOCALE` is not read here — turbo/`pnpm dev` does not pass it through).
 *
 * Desktop only, in the sense that matters: on a hosted server this is the install's locale, which
 * belongs to nobody in particular. `localeForRun` and `localePayload` take the caller's own locale
 * there and never reach this. See `docs/internal/web-phase4-tenant-secrets.md` §4.
 */
export function getBootLocale(): AppLocale {
  if (frozen === null) {
    frozen = loadOwnerLocale();
  }
  return frozen;
}

export function getSavedLocale(): AppLocale {
  return loadOwnerLocale();
}

/**
 * The Restart control in Settings. Reloading the renderer does not restart this
 * process (webdev or packaged IPC), so boot locale must be re-read from disk here.
 *
 * A no-op in server mode: the frozen locale is the whole process's, so one signed-in user must not
 * be able to re-point it, and they have no need to — a hosted user's language is applied on the
 * next request without a restart, because nothing freezes it.
 */
export function applySavedLocaleAsBoot(): AppLocale {
  if (isServerMode()) {
    return getBootLocale();
  }
  frozen = loadOwnerLocale();
  return frozen;
}

export function resetBootLocaleForTests(): void {
  frozen = null;
}

/**
 * The language a signed-in person is served in, on the hosted server.
 *
 * Their own stored choice wins, always. A person who has never chosen gets the language their browser
 * asks for (`Accept-Language`, parsed by `localeFromAcceptLanguage`), so the app greets a first-time
 * Indonesian user in Indonesian the way the portal's sign-in already did. A header that names nothing
 * the app serves — or no header — changes nothing: the answer is `loadUserLocale`'s, which is the
 * tenant's own stored locale and then English, exactly as before the header was read.
 *
 * Nothing is written. The browser's language is a default recomputed on every request, never a
 * choice on the person's behalf: a later request from another browser is judged on its own header.
 * One read of the sealed settings either way.
 */
function hostedLocale(scope: UserScope, acceptLanguage: string | undefined): AppLocale {
  const asked = localeFromAcceptLanguage(acceptLanguage);
  if (asked === null) {
    return loadUserLocale(scope);
  }
  return loadUserLocaleChoice(scope) ?? asked;
}

/**
 * The locale a hosted request runs in: the signed-in person's own (Phase 4). `dispatch` hands this
 * to `withRequestLocale` (`./run-context.ts`) for every request that passed the session gate, so
 * `localeForRun()` answers in that person's language in every mode, not only Chat.
 *
 * Only the verified session's tenant and user go in. A person's language is per tenant and per
 * user, never per desk (`loadUserLocale` reads no desk slice), so the settings fallback desk is
 * named rather than the client's workspace cookie, which nothing has verified at this point.
 *
 * `acceptLanguage` is the request's own header, for a person who never chose (see `hostedLocale`). A
 * session exists only in server mode, so this never runs on a desk; the desk's locale is the one
 * frozen at boot (`getBootLocale`) and no header is read there.
 */
export function sessionLocale(
  session: { readonly tenantId: string; readonly userId: string },
  acceptLanguage?: string,
): AppLocale {
  return hostedLocale(
    {
      tenantId: session.tenantId,
      userId: session.userId,
      workspaceId: FALLBACK_SETTINGS_WORKSPACE,
    },
    acceptLanguage,
  );
}

/** What `localePayload` needs beyond who is asking. Both default to "as before": no header, this process's mode. */
export type LocalePayloadOptions = {
  /** The request's `Accept-Language`, read only in server mode and only for a person who never chose. */
  readonly acceptLanguage?: string;
  /** Overrides `isServerMode()`; the settings handler passes the mode it was handed so the two agree. */
  readonly serverMode?: boolean;
};

/**
 * What the Settings screen shows: `locale` is the language the app is rendering in now, and
 * `savedLocale` the one that has been chosen. When they differ the renderer offers Restart.
 *
 * With a `user`, both come from that person (Phase 4). On a desk `locale` stays the frozen boot
 * value, so a language change still asks for a restart exactly as before; in server mode nothing is
 * frozen per user, so the two agree and the Restart prompt never appears. Without a `user` — the
 * pre-auth ping — it is the install's pair, which is what it always was.
 *
 * In server mode a person with no stored choice is shown their browser's language (`hostedLocale`),
 * for both fields: `savedLocale` is what the language select displays, and showing English there
 * while the app reads Indonesian would be a lie. On a desk the header is not read at all.
 */
export function localePayload(
  user?: UserScope,
  options: LocalePayloadOptions = {},
): { locale: AppLocale; savedLocale: AppLocale } {
  if (!user) {
    return { locale: getBootLocale(), savedLocale: getSavedLocale() };
  }
  if (options.serverMode ?? isServerMode()) {
    const locale = hostedLocale(user, options.acceptLanguage);
    return { locale, savedLocale: locale };
  }
  const saved = loadUserLocale(user);
  return { locale: getBootLocale(), savedLocale: saved };
}
