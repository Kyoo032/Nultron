import type { PortalConfig } from "../config";
import type { Logger } from "../log";
import { createDisabledMailer } from "./disabled";
import { createSmtpMailer } from "./smtp";
import type { Mailer } from "./types";

export * from "./types";
export * from "./templates";
export { createDisabledMailer, MailDisabledError } from "./disabled";
export { createSmtpMailer, createSmtpTransport, type MailTransport } from "./smtp";

/**
 * The portal's mailer: SMTP, always -- except in `PORTAL_SIGNIN_MODE=password`, where it is a mailer
 * that refuses to send and builds no transport. The sandbox is chosen by `PORTAL_SMTP_HOST`, not by
 * code.
 */
export function createMailer(config: PortalConfig, logger?: Logger): Mailer {
  if (config.signInMode === "password") {
    return createDisabledMailer(logger);
  }
  return createSmtpMailer({ smtp: config.smtp, logger });
}
