/**
 * The mailer of a portal in `PORTAL_SIGNIN_MODE=password`: it refuses to send anything.
 *
 * Nothing in password mode sends mail -- the routes that did (the e-mail step, the invite step, the
 * resend buttons) are not registered, and the operator's `invite` and `otp` commands refuse to run.
 * This is the backstop under all of that: if a future change calls `mailer.send` on this path, the
 * message goes nowhere and the failure is loud, instead of a sign-in code or an invite leaving through
 * whatever SMTP settings the environment happened to carry. It also means no transport is built, so
 * no connection to a mail host is ever opened.
 */
import type { Logger } from "../log";
import { log as defaultLog } from "../log";
import type { Mailer, SentMail } from "./types";

export class MailDisabledError extends Error {
  constructor() {
    super("mail is disabled: this portal signs people in with a username and a password and sends no e-mail");
    this.name = "MailDisabledError";
  }
}

export function createDisabledMailer(logger: Logger = defaultLog): Mailer {
  return Object.freeze({
    async send(): Promise<SentMail> {
      logger.error("mail_refused_password_mode", {});
      throw new MailDisabledError();
    },
    async close(): Promise<void> {},
  });
}
