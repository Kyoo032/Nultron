/**
 * The OTP e-mail, in both locales.
 *
 * `AGENTS.md`: "Every user-facing string exists in both `en` and `id` catalogs." The portal's copy
 * lives here rather than in a renderer catalog, for the same reason host copy stays host-side —
 * the portal has no renderer, and this text is sent from the server.
 *
 * The copy says three things and no more: the code, how long it lasts, and what to do if it was
 * not you. No links (a sign-in mail with a link is a phishing template), no branding block to
 * template-inject into, no tracking pixel.
 */
import { translator } from "../views/i18n";
import type { MailMessage } from "./types";

export type MailLocale = "en" | "id";

export interface OtpMessageInput {
  readonly to: string;
  readonly code: string;
  readonly expiresInMinutes: number;
  readonly locale?: MailLocale;
  /**
   * The tenant's product name, e.g. "AIHub Metranet", from `otp/product-name.ts`. Unset when the
   * tenant has not chosen one, and then the portal's own copy applies -- see below.
   */
  readonly productName?: string;
}

/**
 * The name the PAGES print, read from the same catalog they read it from
 * (`locales/<locale>/portal.json`, key `product`).
 *
 * This used to be a constant here, and it named the product one thing while every page of the same
 * sign-in named it another. One catalog entry, two consumers -- the alternative is two copies that
 * drift, and this file is the proof that they do.
 */
function defaultProductName(locale: MailLocale): string {
  return translator(locale)("product");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const COPY = {
  en: (product: string, code: string, minutes: number) => ({
    subject: `${product} sign-in code: ${code}`,
    lines: [
      `Your ${product} sign-in code is ${code}.`,
      ``,
      `It expires in ${minutes} minutes and can be used once.`,
      `If you did not start a sign-in, ignore this message — nobody can use the code without it.`,
    ],
  }),
  id: (product: string, code: string, minutes: number) => ({
    subject: `Kode masuk ${product}: ${code}`,
    lines: [
      `Kode masuk ${product} Anda adalah ${code}.`,
      ``,
      `Kode ini berlaku selama ${minutes} menit dan cuma bisa dipakai sekali.`,
      `Kalau Anda tidak sedang masuk, abaikan saja email ini. Kodenya tidak bisa dipakai orang lain tanpa akses ke email Anda.`,
    ],
  }),
} as const;

export function otpMessage(input: OtpMessageInput): MailMessage {
  const locale: MailLocale = input.locale === "id" ? "id" : "en";
  const product = input.productName?.trim() || defaultProductName(locale);
  const { subject, lines } = COPY[locale](product, input.code, input.expiresInMinutes);

  const html = [
    "<html><body style=\"font-family:system-ui,sans-serif;font-size:15px;line-height:1.5\">",
    ...lines.map((line) =>
      line === "" ? "<p></p>" : `<p>${escapeHtml(line).replace(escapeHtml(input.code), `<strong>${escapeHtml(input.code)}</strong>`)}</p>`,
    ),
    "</body></html>",
  ].join("");

  return Object.freeze({ to: input.to, subject, text: lines.join("\n"), html });
}

export interface InviteMessageInput {
  readonly to: string;
  /** The raw invite code, `XXXXX-XXXXX-XXXXX-XXXXX`. It exists in this message and nowhere else. */
  readonly code: string;
  /** When the invite stops working, as an ISO instant. Printed as a UTC date. */
  readonly expiresAt: string;
  readonly locale?: MailLocale;
  readonly productName?: string;
}

const INVITE_COPY = {
  en: (product: string, code: string, to: string, date: string) => ({
    subject: `You are invited to ${product}`,
    lines: [
      `You have been invited to ${product}.`,
      ``,
      `Your invite code: ${code}`,
      ``,
      `It works for ${to} only, once, and stops working after ${date} (UTC).`,
      `To sign in for the first time, open ${product}, enter this e-mail address, then this invite code.`,
      `We will then e-mail you a six-digit code to confirm it is your inbox. Later sign-ins need only that e-mailed code.`,
      `If you were not expecting this, ignore this message — the code is useless without your inbox.`,
    ],
  }),
  id: (product: string, code: string, to: string, date: string) => ({
    subject: `Anda diundang ke ${product}`,
    lines: [
      `Anda diundang ke ${product}.`,
      ``,
      `Kode undangan Anda: ${code}`,
      ``,
      `Kode ini cuma berlaku untuk ${to}, bisa dipakai sekali, dan kedaluwarsa setelah ${date} (UTC).`,
      `Untuk masuk pertama kali, buka ${product}, masukkan alamat email ini, lalu kode undangan ini.`,
      `Setelah itu kami kirim kode enam digit ke email Anda, untuk memastikan kotak masuk itu milik Anda. Untuk masuk berikutnya, cukup pakai kode dari email itu.`,
      `Kalau Anda tidak merasa diundang, abaikan saja email ini. Kodenya tidak berguna tanpa akses ke kotak masuk Anda.`,
    ],
  }),
} as const;

/**
 * The invite e-mail: the code, whose address it is bound to, when it stops working, and what to do
 * with it. No link, for the reason the OTP mail has none: a sign-in mail with a link is a phishing
 * template, and the tester was told where the app is by the person who invited them.
 */
export function inviteMessage(input: InviteMessageInput): MailMessage {
  const locale: MailLocale = input.locale === "id" ? "id" : "en";
  const product = input.productName?.trim() || defaultProductName(locale);
  const date = input.expiresAt.slice(0, 10);
  const { subject, lines } = INVITE_COPY[locale](product, input.code, input.to, date);

  const html = [
    "<html><body style=\"font-family:system-ui,sans-serif;font-size:15px;line-height:1.5\">",
    ...lines.map((line) =>
      line === ""
        ? "<p></p>"
        : `<p>${escapeHtml(line).replace(escapeHtml(input.code), `<strong>${escapeHtml(input.code)}</strong>`)}</p>`,
    ),
    "</body></html>",
  ].join("");

  return Object.freeze({ to: input.to, subject, text: lines.join("\n"), html });
}
