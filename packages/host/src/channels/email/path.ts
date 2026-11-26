/**
 * The names the email webhook is known by, in a module with no imports — the same reason
 * `inbox/webhook-path.ts` exists: the HTTP adapter, the auth gate and the handler must agree on
 * the path and the header before the database loads.
 */

/** The one public inbound route for email. A literal path, exempt from the session gate and CSRF. */
export const EMAIL_WEBHOOK_PATH = "/api/v1/channels/email/webhook";

/**
 * The provider signs every POST: `sha256=` plus the hex HMAC-SHA256 of the raw body under the
 * install's webhook secret. Same envelope as Meta's `x-hub-signature-256`.
 */
export const EMAIL_SIGNATURE_HEADER = "x-agentforge-email-signature";

/** The shared secret the provider signs with. Install-wide, never per desk. */
export const EMAIL_WEBHOOK_SECRET_ENV = "AGENTFORGE_EMAIL_WEBHOOK_SECRET";

/** `smtp[s]://user:pass@host:port` — nodemailer reads the URL whole. */
export const EMAIL_SMTP_URL_ENV = "AGENTFORGE_SMTP_URL";

/** The domain outbound `Message-ID`s and the default `From` are built on. */
export const EMAIL_FROM_DOMAIN_ENV = "AGENTFORGE_EMAIL_FROM_DOMAIN";

/** Per-sender hourly inbound cap (loop protection). */
export const EMAIL_MAX_PER_SENDER_HOUR_ENV = "AGENTFORGE_EMAIL_MAX_PER_SENDER_HOUR";

/** A mail body above this is truncated before it reaches the model; the webhook body cap is lower. */
export const EMAIL_MAX_BODY_CHARS = 32_000;

/** The most a webhook delivery may be — far below the adapter's general cap. */
export const EMAIL_WEBHOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;

export const EMAIL_DEFAULT_MAX_PER_SENDER_HOUR = 20;
