/**
 * The names the WhatsApp webhook is known by, in a module with no imports.
 *
 * The HTTP adapter, the auth gate and the handler all have to agree on the path and the header, and
 * the first two load before the database does. Keeping the constants here lets them agree without
 * the adapter importing the handler (and through it `@agentforge/db`).
 */

/**
 * The one public inbound route for WhatsApp (defined in core so the Customers page can show it).
 * A literal path, never a prefix: it is exempt from the session gate and from the CSRF rule (see
 * `UNGATED_GETS`, `UNGATED_POSTS` and `CSRF_EXEMPT_PATHS`), so nothing else may share its spelling.
 * Meta calls GET for the handshake and POST for deliveries.
 */
export { WHATSAPP_WEBHOOK_PATH } from "@agentforge/core/inbox";

/** Meta signs every POST: `sha256=` plus the hex HMAC-SHA256 of the raw body under the app secret. */
export const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";

/** The Meta app's secret. Install-wide, in the server env like the billing secret; never per desk. */
export const WHATSAPP_APP_SECRET_ENV = "AGENTFORGE_WHATSAPP_APP_SECRET";

/** The string the operator types into Meta's webhook setup; echoed back only when it matches. */
export const WHATSAPP_VERIFY_TOKEN_ENV = "AGENTFORGE_WHATSAPP_VERIFY_TOKEN";

/**
 * The most a webhook body may be. Meta documents up to 3 MB, but a text delivery is a few KB and the
 * route is open to the internet before it has authenticated anyone, so it is held far below the
 * adapter's general cap.
 */
export const WHATSAPP_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
