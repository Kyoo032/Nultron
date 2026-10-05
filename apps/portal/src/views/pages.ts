/**
 * The screens.
 *
 *   sign-in (e-mail) -> enter code | enter invite code | no access / invite spent / too many attempts
 *        -> [approve a device] -> success | error
 *
 * Which of those follows the e-mail step is the portal's decision (`flows/sign-in.ts`), and the
 * page says so plainly: since 2026-10-01 the sign-in tells a person which situation they are in.
 *
 * Every screen is a `<form method="post">` with a hidden CSRF field and whatever the flow has to
 * carry forward. Nothing is stored in a URL that does not have to be: `state`, `client_id` and
 * `redirect_uri` ride in hidden fields across the posts rather than in the query string, so
 * they never reach a browser history entry or a `Referer` -- and they are **re-validated** on
 * every post regardless, because a hidden field is a field the user controls.
 *
 * The device details on the approve screen come from the `device_codes` row, never from the query.
 * `device-code-login.md` is explicit about that: the browser is a different party from the device,
 * and must not be able to restate what the device claimed.
 */
import { html, type SafeHtml } from "./escape";
import type { PortalLocale, Translate } from "./i18n";
import { page } from "./layout";

export interface ScreenBase {
  readonly locale: PortalLocale;
  readonly t: Translate;
}

/** Hidden inputs, escaped by the tag like everything else. */
function hiddenFields(fields: Readonly<Record<string, string>>): SafeHtml {
  return html`${Object.entries(fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  )}`;
}

function errorLine(message: string | undefined): SafeHtml | string {
  return message ? html`<p class="bad">${message}</p>` : "";
}

function noticeLine(message: string | undefined): SafeHtml | string {
  return message ? html`<p class="notice">${message}</p>` : "";
}

// ---------------------------------------------------------------------------
// Account banner: who the portal thinks is signed in on this browser
// ---------------------------------------------------------------------------

export interface AccountBanner {
  readonly email: string;
  readonly signOutAction: string;
  readonly csrfToken: string;
}

/** "You are signed in as ..." and the way out if that is the wrong person on a shared browser. */
function accountBanner(t: Translate, account: AccountBanner | undefined): SafeHtml | string {
  if (!account) {
    return "";
  }
  return html`<div class="account">
<p>${t("account.signedInAs", { email: account.email })}</p>
<form method="post" action="${account.signOutAction}">
${hiddenFields({ csrf_token: account.csrfToken })}
<button class="secondary" type="submit">${t("account.signOut")}</button>
</form>
</div>
`;
}

// ---------------------------------------------------------------------------
// The e-mail step
// ---------------------------------------------------------------------------

export interface SignInScreen extends ScreenBase {
  readonly action: string;
  readonly csrfToken: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly error?: string;
  readonly email?: string;
}

/**
 * Step one: an e-mail address and nothing else. What happens next depends on who the address is --
 * the portal decides -- so the button says "Continue", not "Send code": a person who needs the
 * invite they were e-mailed must not be told a code is on its way.
 */
export function signInPage(screen: SignInScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: t("signIn.title"),
    footer: t("footer.note"),
    body: html`<h1>${t("signIn.title")}</h1>
<p class="lead">${t("signIn.intro")}</p>
${errorLine(screen.error)}
<form method="post" action="${screen.action}">
${hiddenFields({ ...screen.hidden, csrf_token: screen.csrfToken })}
<label for="email">${t("signIn.emailLabel")}</label>
<input id="email" name="email" type="email" autocomplete="email" inputmode="email" required
 autofocus maxlength="254" value="${screen.email ?? ""}">
<button type="submit">${t("signIn.submit")}</button>
</form>`,
  });
}

// ---------------------------------------------------------------------------
// The second steps: a sign-in code for a member, an invite code for an invitee
// ---------------------------------------------------------------------------

/** The two ways out every second-step screen offers: ask again, or start over with another address. */
interface FollowUp {
  readonly csrfToken: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly email: string;
  readonly resendAction: string;
  readonly resendLabel: string;
  /** Sent with the resend form, so the e-mail step can tell "send a new code" from a first request. */
  readonly resendField?: Readonly<Record<string, string>>;
  readonly restartAction: string;
  readonly restartLabel: string;
}

function followUpForms(follow: FollowUp): SafeHtml {
  const carried = { ...follow.hidden, csrf_token: follow.csrfToken };
  return html`<form method="post" action="${follow.resendAction}">
${hiddenFields({ ...carried, email: follow.email, ...(follow.resendField ?? {}) })}
<button class="secondary" type="submit">${follow.resendLabel}</button>
</form>
<form method="post" action="${follow.restartAction}">
${hiddenFields({ ...carried, restart: "1" })}
<button class="secondary" type="submit">${follow.restartLabel}</button>
</form>`;
}

export interface EnterCodeScreen extends ScreenBase {
  /** `POST .../verify`. */
  readonly action: string;
  /** The e-mail step again; with `resend=1` it is "send me a new code". */
  readonly resendAction: string;
  readonly restartAction: string;
  readonly csrfToken: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly email: string;
  /** The sentence under the heading: where the code went, or why none did. Already translated. */
  readonly lead: string;
  readonly error?: string;
  readonly notice?: string;
}

/**
 * Step two for a member: the six-digit code. It names the address (the lead) now -- the sign-in
 * tells a person which situation they are in, SR-30 -- and offers the two ways out: a new code, or
 * another address.
 */
export function enterCodePage(screen: EnterCodeScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: t("sent.title"),
    footer: t("footer.note"),
    body: html`<h1>${t("sent.title")}</h1>
<p class="lead">${screen.lead}</p>
${noticeLine(screen.notice)}
${errorLine(screen.error)}
<form method="post" action="${screen.action}">
${hiddenFields({ ...screen.hidden, csrf_token: screen.csrfToken, email: screen.email })}
<label for="code">${t("sent.codeLabel")}</label>
<input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
 autocomplete="one-time-code" required autofocus>
<button type="submit">${t("sent.submit")}</button>
</form>
${followUpForms({
  csrfToken: screen.csrfToken,
  hidden: screen.hidden,
  email: screen.email,
  resendAction: screen.resendAction,
  resendLabel: t("sent.resend"),
  resendField: { resend: "1" },
  restartAction: screen.restartAction,
  restartLabel: t("state.restart"),
})}`,
  });
}

export interface InviteCodeScreen extends ScreenBase {
  /** `POST .../invite`. */
  readonly action: string;
  /** `POST .../invite/resend`. */
  readonly resendAction: string;
  readonly restartAction: string;
  readonly csrfToken: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly email: string;
  readonly error?: string;
  readonly notice?: string;
}

/**
 * Step two for an invitee: the invite code they were e-mailed. No sign-in code has been sent yet --
 * that follows a valid invite, so the inbox is still proved. The code is never echoed back.
 */
export function inviteCodePage(screen: InviteCodeScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: t("invite.title"),
    footer: t("footer.note"),
    body: html`<h1>${t("invite.title")}</h1>
<p class="lead">${t("invite.lead", { email: screen.email })}</p>
${noticeLine(screen.notice)}
${errorLine(screen.error)}
<form method="post" action="${screen.action}">
${hiddenFields({ ...screen.hidden, csrf_token: screen.csrfToken, email: screen.email })}
<label for="invite_code">${t("invite.label")}</label>
<input id="invite_code" name="invite_code" type="text" autocomplete="off" autocapitalize="characters"
 spellcheck="false" required autofocus maxlength="64">
<button type="submit">${t("invite.submit")}</button>
</form>
${followUpForms({
  csrfToken: screen.csrfToken,
  hidden: screen.hidden,
  email: screen.email,
  resendAction: screen.resendAction,
  resendLabel: t("invite.resend"),
  restartAction: screen.restartAction,
  restartLabel: t("state.restart"),
})}`,
  });
}

export interface StateScreen extends ScreenBase {
  readonly title: string;
  readonly message: string;
  readonly restartAction: string;
  readonly csrfToken: string;
  readonly hidden: Readonly<Record<string, string>>;
}

/**
 * The dead ends -- no access yet, the invite is spent, too many attempts. Each says what is true and
 * who can change it, and offers the one thing the person can do alone: try another address.
 */
export function statePage(screen: StateScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: screen.title,
    footer: t("footer.note"),
    body: html`<h1>${screen.title}</h1>
<p class="lead">${screen.message}</p>
<form method="post" action="${screen.restartAction}">
${hiddenFields({ ...screen.hidden, csrf_token: screen.csrfToken, restart: "1" })}
<button class="secondary" type="submit">${t("state.restart")}</button>
</form>`,
  });
}

// ---------------------------------------------------------------------------
// The device-code screens
// ---------------------------------------------------------------------------

export interface UserCodeScreen extends ScreenBase {
  readonly action: string;
  readonly csrfToken: string;
  readonly userCode?: string;
  readonly error?: string;
  readonly account?: AccountBanner;
}

/** `GET /activate` with no usable `?code=`: ask for the code shown on the device. */
export function userCodePage(screen: UserCodeScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: t("approve.title"),
    footer: t("footer.note"),
    body: html`${accountBanner(t, screen.account)}<h1>${t("approve.title")}</h1>
<p class="lead">${t("approve.codeIntro")}</p>
${errorLine(screen.error)}
<form method="post" action="${screen.action}">
${hiddenFields({ csrf_token: screen.csrfToken })}
<label for="user_code">${t("approve.codeLabel")}</label>
<input id="user_code" name="user_code" type="text" maxlength="9" autocomplete="off"
 spellcheck="false" required autofocus value="${screen.userCode ?? ""}">
<button type="submit">${t("approve.codeSubmit")}</button>
</form>`,
  });
}

export interface ApproveScreen extends ScreenBase {
  readonly action: string;
  readonly csrfToken: string;
  /** From the `device_codes` row -- displayed `XXXX-XXXX`. */
  readonly userCode: string;
  /** From the row's `platform` column, already mapped to a copy key. */
  readonly platform: string;
  readonly deviceLabel: string | null;
  readonly account?: AccountBanner;
}

export function approvePage(screen: ApproveScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: t("approve.title"),
    footer: t("footer.note"),
    body: html`${accountBanner(t, screen.account)}<h1>${t("approve.title")}</h1>
<p class="lead">${t("approve.intro")}</p>
<dl>
<dt>${t("approve.userCode")}</dt><dd class="code">${screen.userCode}</dd>
<dt>${t("approve.platform")}</dt><dd>${screen.platform}</dd>
${screen.deviceLabel ? html`<dt>${t("approve.device")}</dt><dd>${screen.deviceLabel}</dd>` : ""}
</dl>
<p class="warn">${t("approve.warning")}</p>
<form method="post" action="${screen.action}">
${hiddenFields({ csrf_token: screen.csrfToken, user_code: screen.userCode, decision: "approve" })}
<button type="submit">${t("approve.approve")}</button>
</form>
<form method="post" action="${screen.action}">
${hiddenFields({ csrf_token: screen.csrfToken, user_code: screen.userCode, decision: "deny" })}
<button class="secondary" type="submit">${t("approve.deny")}</button>
</form>`,
  });
}

export interface OutcomeScreen extends ScreenBase {
  readonly title: string;
  readonly message: string;
}

/** Approved, denied, signed in, and every neutral refusal. One shape, no CTA to get wrong. */
export function outcomePage(screen: OutcomeScreen): string {
  const { t } = screen;
  return page({
    locale: screen.locale,
    product: t("product"),
    title: screen.title,
    footer: t("footer.note"),
    body: html`<h1>${screen.title}</h1>
<p class="lead">${screen.message}</p>`,
  });
}

/**
 * The one error page. It carries a sentence and nothing else -- no request id, no client id, no
 * `state`, no hint about whether the failure was the client's or the user's.
 */
export function errorPage(screen: ScreenBase & { readonly message: string }): string {
  return outcomePage({
    locale: screen.locale,
    t: screen.t,
    title: screen.t("error.title"),
    message: screen.message,
  });
}
