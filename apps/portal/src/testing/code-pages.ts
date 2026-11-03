/**
 * Every screen of the e-mailed-code sign-in, rendered from fixed inputs in both languages, so a test
 * can pin their exact bytes.
 *
 * It takes the view functions as an argument on purpose. The suite passes the current ones; the golden
 * hashes in `code-mode-unchanged.test.ts` were produced by passing the ones from `main` (the commit
 * this branch was cut from, `9aba37e`; the two `userCode` screens since 2026-11-03), through the same function. A change to any of those screens in
 * the default mode, by one byte, is a different hash.
 */
import type { PortalLocale, Translate } from "../views/i18n";

interface Views {
  readonly translator: (locale: PortalLocale) => Translate;
  readonly signInPage: (screen: never) => string;
  readonly enterCodePage: (screen: never) => string;
  readonly inviteCodePage: (screen: never) => string;
  readonly statePage: (screen: never) => string;
  readonly userCodePage: (screen: never) => string;
  readonly approvePage: (screen: never) => string;
  readonly outcomePage: (screen: never) => string;
  readonly errorPage: (screen: never) => string;
}

const HIDDEN = {
  response_type: "code",
  client_id: "agentforge-web",
  redirect_uri: "https://localhost:3443/auth/callback",
  state: "state-fixed",
};

/** One entry per screen per language. The functions are called with a loose object: the shapes are theirs. */
export function renderCodeModePages(views: Views): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const locale of ["en", "id"] as const) {
    const t = views.translator(locale);
    const base = { locale, t };
    const call = (fn: (screen: never) => string, screen: Record<string, unknown>): string => fn(screen as never);

    out[`${locale}.signIn`] = call(views.signInPage, {
      ...base,
      action: "/authorize/email",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
    });
    out[`${locale}.signIn.error`] = call(views.signInPage, {
      ...base,
      action: "/authorize/email",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
      email: "person@example.test",
      error: t("signIn.emailMissing"),
    });
    out[`${locale}.enterCode`] = call(views.enterCodePage, {
      ...base,
      action: "/authorize/verify",
      resendAction: "/authorize/email",
      restartAction: "/authorize/email",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
      email: "person@example.test",
      lead: t("sent.body", { email: "person@example.test", minutes: 10 }),
      error: t("code.invalid", { attempts: 3 }),
      notice: t("sent.cooldown", { minutes: 1 }),
    });
    out[`${locale}.invite`] = call(views.inviteCodePage, {
      ...base,
      action: "/authorize/invite",
      resendAction: "/authorize/invite/resend",
      restartAction: "/authorize/email",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
      email: "person@example.test",
      error: t("invite.wrong", { attempts: 4 }),
    });
    out[`${locale}.state`] = call(views.statePage, {
      ...base,
      title: t("state.noAccess.title"),
      message: t("state.noAccess.body"),
      restartAction: "/authorize/email",
      csrfToken: "csrf-fixed",
      hidden: HIDDEN,
    });
    out[`${locale}.userCode`] = call(views.userCodePage, {
      ...base,
      action: "/activate",
      userCode: "ABCD-2345",
      error: t("approve.unknownCode"),
      account: { email: "person@example.test", signOutAction: "/logout", csrfToken: "csrf-fixed" },
    });
    out[`${locale}.approve`] = call(views.approvePage, {
      ...base,
      action: "/auth/device/approve",
      csrfToken: "csrf-fixed",
      userCode: "ABCD-2345",
      platform: t("platform.windows"),
      deviceLabel: "Fixed device",
      account: { email: "person@example.test", signOutAction: "/logout", csrfToken: "csrf-fixed" },
    });
    out[`${locale}.signedOut`] = call(views.outcomePage, {
      ...base,
      title: t("signedOut.title"),
      message: t("signedOut.body"),
    });
    out[`${locale}.error`] = call(views.errorPage, { ...base, message: t("error.expiredForm") });
  }
  return Object.freeze(out);
}
