/**
 * Outbound mail (F5b): thread replies and Owner notices over nodemailer, configured by
 * `AGENTFORGE_SMTP_URL` + `AGENTFORGE_EMAIL_FROM_DOMAIN`. The product's own transport — portal's
 * `apps/portal/src/mail/smtp.ts` is the control plane's and must not be imported here.
 *
 * Agent-initiated mail to third parties is *not* this module: that stays gated behind F3. The only
 * recipients are the allowlisted sender of the thread being answered and the desk's owner.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { EMAIL_FROM_DOMAIN_ENV, EMAIL_SMTP_URL_ENV } from "./path";

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("email outbound is not configured (set AGENTFORGE_SMTP_URL and AGENTFORGE_EMAIL_FROM_DOMAIN)");
    this.name = "EmailNotConfiguredError";
  }
}

export type Mailer = {
  send(mail: {
    to: string;
    subject: string;
    text: string;
    fromAddress: string;
    fromName?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<void>;
};

export function fromDomain(env: NodeJS.ProcessEnv): string | null {
  const value = env[EMAIL_FROM_DOMAIN_ENV]?.trim();
  return value ? value.replace(/^@/, "") : null;
}

/** A mailer over the configured SMTP URL, or null when outbound is not configured. */
export function createMailer(env: NodeJS.ProcessEnv): Mailer | null {
  const url = env[EMAIL_SMTP_URL_ENV]?.trim();
  const domain = fromDomain(env);
  if (!url || !domain) {
    return null;
  }
  // `createTransport(url)` takes no options, so the URL is unfolded here: the timeouts and the TLS
  // floor a mail relay should always carry.
  const parsed = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  const transport: Transporter = nodemailer.createTransport({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "smtps:" ? 465 : 587,
    secure: parsed.protocol === "smtps:",
    // A remote relay on smtp:// must offer STARTTLS — without it replies would ride in plaintext.
    requireTLS: parsed.protocol === "smtp:" && !loopback,
    auth: parsed.username
      ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) }
      : undefined,
    connectionTimeout: 4_000,
    greetingTimeout: 4_000,
    socketTimeout: 8_000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  return {
    async send(mail) {
      await transport.sendMail({
        from: mail.fromName ? `"${mail.fromName}" <${mail.fromAddress}>` : mail.fromAddress,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo ?? undefined,
        references: mail.references,
      });
    },
  };
}

/** Reply subject per convention: `Re:` once, never stacked. */
export function replySubject(subject: string | null | undefined): string {
  const base = (subject ?? "").trim() || "(no subject)";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}
