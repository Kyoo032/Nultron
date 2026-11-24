/**
 * The portal's one logger: one JSON object per line, level-gated, redacted at the sink.
 *
 * The rule from `device-code-login.md` ("Security notes") and `AGENTS.md` is absolute: a
 * `user_code`, a `device_code`, a refresh token, a JWT or an OTP never reaches a log. That is not
 * left to the call site — this file drops any field whose *name* carries a credential word, and
 * scrubs any string *value* that looks like a token, wherever it appears.
 *
 * Deliberately standalone: the portal is the backend team's service, and it imports nothing from
 * `@agentforge/host` or `@agentforge/db`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

/** Written in place of a value whose field name may never reach a log. */
export const DROPPED_MARKER = "[dropped]";
/** Written in place of a string that matched a secret shape. */
export const REDACTED_MARKER = "[redacted]";
const DEPTH_MARKER = "[depth]";

export const LOG_LEVEL_ENV = "PORTAL_LOG_LEVEL";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL: LogLevel = "info";
const MAX_DEPTH = 4;
const MAX_ARRAY = 32;

/**
 * A field whose name *contains* one of these, in any case, is dropped whole. Substring and not an
 * exact list, because `otp`, `otpCode`, `raw_otp` and `otp_hash` are all the same mistake and an
 * exact list only ever catches the spelling someone thought of.
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "authorization",
  "csrf",
  "otp",
  "jwt",
  "credential",
  "user_code",
  "usercode",
  "invite_code",
  "invitecode",
  "device_code",
  "devicecode",
  "client_secret",
  "signing",
];

/**
 * Exact names, because these are ordinary words that a substring rule would over-eat: `code` is
 * the raw thing we mail, while `reason_code`, `status_code` and `reasonCode` must stay readable --
 * they are the whole point of the audit trail.
 */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(["code", "secret", "state", "hash", "key"]);

function isForbiddenField(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_FIELDS.has(lower) || FORBIDDEN_SUBSTRINGS.some((word) => lower.includes(word));
}

/** A JWT: three base64url segments starting with the `{"alg"` header prefix. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
/**
 * A 32-byte value in base64url is 43 characters. Anything that long and that shaped is a refresh
 * token, a device code or an authorization code; nothing the portal wants to read is.
 */
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;

/** Scrubs a string of anything token-shaped, wherever in it that appears. */
export function redactSecrets(value: string): string {
  return value.replace(JWT_PATTERN, REDACTED_MARKER).replace(LONG_TOKEN_PATTERN, REDACTED_MARKER);
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const NPWP_DOTTED_RE = /\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/g;
const NIK_PROVINCES = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "21",
  "31", "32", "33", "34", "35", "36", "51", "52", "53",
  "61", "62", "63", "64", "65", "71", "72", "73", "74", "75", "76",
  "81", "82", "91", "92", "93", "94", "95", "96", "99",
]);
const NIK_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const NIK_BARE_RE = /(?<![\d.,-])\d{16}(?![\d.,-])/g;
const LOCAL_PHONE_RE = /(?<![\d.,-])08\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g;
const INTL_PHONE_RE = /(?:\+|00)\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const CARD_PREFIX_RE = /^(?:4|5[1-5]|2[2-7]|34|37|6011|64[4-9]|65|35|30[0-5]|36|3[89]|62)/;

function isLikelyNik(digits: string): boolean {
  if (!NIK_PROVINCES.has(digits.slice(0, 2))) return false;
  if (Number(digits.slice(2, 4)) === 0 || Number(digits.slice(4, 6)) === 0) return false;
  const rawDay = Number(digits.slice(6, 8));
  const day = rawDay > 40 ? rawDay - 40 : rawDay;
  const month = Number(digits.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > NIK_DAYS_IN_MONTH[month - 1]) return false;
  const serial = Number(digits.slice(12));
  return serial > 0 && serial % 1000 !== 0;
}

function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Lightweight standalone PII scrub (email, NPWP, NIK, phone, Luhn card) for portal logs. */
export function scrubPii(value: string): string {
  if (!value) {
    return value;
  }
  return value
    .replace(EMAIL_RE, "[email]")
    .replace(NPWP_DOTTED_RE, "[npwp]")
    .replace(NIK_BARE_RE, (match) => (isLikelyNik(match) ? "[nik]" : match))
    .replace(LOCAL_PHONE_RE, (match) => {
      const len = match.replace(/\D/g, "").length;
      return len >= 10 && len <= 13 ? "[phone]" : match;
    })
    .replace(INTL_PHONE_RE, (match) => {
      const len = match.replace(/\D/g, "").length;
      return len >= 10 && len <= 15 ? "[phone]" : match;
    })
    .replace(CARD_CANDIDATE_RE, (match) => {
      const digits = match.replace(/\D/g, "");
      if (!passesLuhn(digits)) return match;
      if (/[ -]/.test(match) || (CARD_PREFIX_RE.test(digits) && !/0{4}$/.test(digits))) {
        return "[card]";
      }
      return match;
    });
}

function sanitiseText(value: string): string {
  return scrubPii(redactSecrets(value));
}

function sanitiseValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return sanitiseText(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Error) {
    return sanitiseText(value.message ? `${value.name}: ${value.message}` : value.name);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    // A Buffer here is a hash or a key. Its length is the only safe thing to say about it.
    return `[bytes:${value.length}]`;
  }
  if (depth >= MAX_DEPTH) {
    return DEPTH_MARKER;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((item) => sanitiseValue(item, depth + 1));
    return value.length > MAX_ARRAY ? [...kept, `[+${value.length - MAX_ARRAY} more]`] : kept;
  }
  if (typeof value === "object") {
    return sanitiseFields(value as Record<string, unknown>, depth + 1);
  }
  return sanitiseText(String(value));
}

function sanitiseFields(fields: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (isForbiddenField(name)) {
      out[name] = DROPPED_MARKER;
      continue;
    }
    const safe = sanitiseValue(value, depth);
    if (safe !== undefined) {
      out[name] = safe;
    }
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sink?: LogSink;
  readonly fields?: LogFields;
}

const consoleSink: LogSink = (level, line) => {
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else if (level === "debug") {
    console.debug(line);
  } else {
    console.info(line);
  }
};

function resolveLevel(env: Readonly<Record<string, string | undefined>>): LogLevel {
  const raw = env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  return raw && raw in LEVEL_RANK ? (raw as LogLevel) : DEFAULT_LEVEL;
}

export function formatLine(level: LogLevel, event: string, fields: LogFields): string {
  const record = { ts: new Date().toISOString(), level, event: sanitiseText(event), ...sanitiseFields(fields, 0) };
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: record.ts, level, event: record.event, fields: "[unserialisable]" });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const sink = options.sink ?? consoleSink;
  const base = options.fields ?? {};
  const threshold = LEVEL_RANK[resolveLevel(env)];

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < threshold) {
      return;
    }
    sink(level, formatLine(level, event, { ...base, ...fields }));
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

export const log: Logger = createLogger();
