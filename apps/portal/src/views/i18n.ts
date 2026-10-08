/**
 * The portal's copy, in `en` and `id`.
 *
 * `AGENTS.md`: "Every user-facing string exists in both `en` and `id` catalogs." The portal has no
 * renderer, so its catalogs live in `apps/portal/locales/<locale>/portal.json` and are read from
 * disk once at module load rather than imported -- a JSON import would need a `tsconfig` change in
 * a file this lane does not own, and the catalogs are two small files read once.
 *
 * The reason-code copy in those catalogs is the table from `docs/internal/portal/device-code-login.md`
 * ("Login checks and reason codes") **verbatim**, and it is the single source for both the HTML the
 * portal renders and the `message_en` / `message_id` fields of every JSON error body. One table,
 * two consumers -- the alternative is two copies that drift.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTAL_LOCALES = ["en", "id"] as const;
export type PortalLocale = (typeof PORTAL_LOCALES)[number];
export const DEFAULT_PORTAL_LOCALE: PortalLocale = "en";

/** `apps/portal` -- this file is at `apps/portal/src/views/i18n.ts`. */
const LOCALES_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "locales");

type Catalog = Readonly<Record<string, unknown>>;

function loadCatalog(locale: PortalLocale): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, "portal.json"), "utf8")) as Catalog;
}

const CATALOGS: Readonly<Record<PortalLocale, Catalog>> = Object.freeze({
  en: loadCatalog("en"),
  id: loadCatalog("id"),
});

export function catalogFor(locale: PortalLocale): Catalog {
  return CATALOGS[locale];
}

function lookup(catalog: Catalog, key: string): string | null {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") {
      return null;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

export type Vars = Readonly<Record<string, string | number>>;

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) {
    return template;
  }
  // The result is escaped by `src/views/escape.ts` on the way into a page, so a variable that
  // happens to contain markup is inert; this only fills the slots.
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export type Translate = (key: string, vars?: Vars) => string;

/**
 * The two sentences the pages SHARE between the sign-ins that talk about an e-mailed code, and the
 * keys that say the password version. In `PORTAL_SIGNIN_MODE=password` the translator reads the right
 * side wherever a page asks for the left: the footer of every page ("Never share a sign-in code ...")
 * and the signed-out page ("... your e-mail and a code next time"). The default mode never uses this.
 */
const PASSWORD_MODE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "footer.note": "footer.notePassword",
  "signedOut.body": "signedOut.bodyPassword",
});

export interface TranslatorOptions {
  /** `PORTAL_SIGNIN_MODE=password`: swap the shared sentences that mention an e-mailed code. */
  readonly passwordMode?: boolean;
}

/** A missing `id` key falls back to `en`; a key missing from both returns the key itself. */
export function translator(locale: PortalLocale, options: TranslatorOptions = {}): Translate {
  return (key, vars) => {
    const asked = options.passwordMode ? (PASSWORD_MODE_KEYS[key] ?? key) : key;
    const own = lookup(CATALOGS[locale], asked);
    const value = own ?? lookup(CATALOGS[DEFAULT_PORTAL_LOCALE], asked) ?? key;
    return interpolate(value, vars);
  };
}

/**
 * A wait in the unit that reads best: minutes under an hour, otherwise whole hours rounded up (a
 * person told "19 h" will not come back to a lock that is still on). The words are the catalog's
 * (`wait.minutes`, `wait.hours`), so Indonesian says "jam".
 */
export function waitText(t: Translate, seconds: number): string {
  const safe = Math.max(1, Math.ceil(seconds));
  return safe < 3600 ? t("wait.minutes", { n: Math.ceil(safe / 60) }) : t("wait.hours", { n: Math.ceil(safe / 3600) });
}

/** Both locales at once -- the shape `message_en` / `message_id` need. */
export function copyPair(key: string, vars?: Vars): { readonly en: string; readonly id: string } {
  return Object.freeze({ en: translator("en")(key, vars), id: translator("id")(key, vars) });
}

export function parsePortalLocale(value: string | null | undefined): PortalLocale | null {
  const normalised = value?.trim().toLowerCase().split("-")[0];
  return normalised === "en" || normalised === "id" ? normalised : null;
}

/**
 * `?lang=` wins, then `Accept-Language` in q-order, then English.
 *
 * An explicit `?lang=id` beats the browser because the user asked; an unknown value is English
 * rather than an error, the same rule `packages/core/src/locale.ts` uses for the product.
 */
export function negotiateLocale(
  query: URLSearchParams,
  acceptLanguage: string | string[] | undefined,
): PortalLocale {
  const asked = parsePortalLocale(query.get("lang"));
  if (asked) {
    return asked;
  }
  const header = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage;
  if (!header) {
    return DEFAULT_PORTAL_LOCALE;
  }
  const ranked = header
    .split(",")
    .map((entry) => {
      const [tag, ...params] = entry.split(";");
      const quality = params.find((part) => part.trim().startsWith("q="));
      return { tag: tag.trim(), q: quality ? Number(quality.split("=")[1]) : 1 };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const entry of ranked) {
    const locale = parsePortalLocale(entry.tag);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_PORTAL_LOCALE;
}
