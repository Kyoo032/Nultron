const BEARER_RE = /\bBearer(?:\s+|%20)[A-Za-z0-9\-._~+/%]{8,}/g;

const KEY_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9\-_]{8,}/g,
  /\bsk-[A-Za-z0-9\-_]{8,}/g,
  /\btvly-[A-Za-z0-9\-_]{8,}/g,
  /\bAIza[A-Za-z0-9\-_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Shapes this app handles that no prefix rule above sees. Each is specific on purpose: none is the broad
 * "long opaque run" rule, so a hash, a signed link or a number in a spreadsheet row is not touched.
 */

/** A PEM private key block, to its end line or, when the text was cut, to the end of the text. A certificate is public and stays. */
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g;

/** The user and password of a URL (`postgres://user:pass@host`, `https://token@host`); the scheme and host stay. */
const URL_USERINFO_RE = /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#()[\]<>"'`]+@/gi;

/** A JWT: three dot-separated base64url parts, the first of which is a JSON header (`{"` encodes to `eyJ`). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** A Telegram bot token: the bot id, a colon, 35 characters that include at least one letter. */
const TELEGRAM_TOKEN_RE = /(?<![0-9])\d{6,12}:(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g;

/** An AWS access key id, except inside a presigned link's `Credential=` parameter, which the link needs to work. */
const AWS_ACCESS_KEY_ID_RE = /(?<!Credential=)\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

/** A `Cookie:` or `Set-Cookie:` header line. Needs a `name=value` after the colon, so the word cookie in a sentence is safe. */
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie[ \t]*:[ \t]*)([^\r\n]+)/gi;

function maskCookieHeader(match: string, head: string, value: string): string {
  return value.includes("=") ? `${head}[REDACTED]` : match;
}

const BASIC_AUTH_RE = /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?Basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}/gi;

const ENV_ASSIGNMENT_RE = /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)(\S[^\r\n]*)/gm;
const SECRET_NAME_PART_RE = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)(?:_|$)/;

function maskEnvAssignment(match: string, head: string, name: string, equals: string): string {
  return SECRET_NAME_PART_RE.test(name) ? `${head}${name}${equals}[REDACTED]` : match;
}

/** Min length for a standalone base64-like token to be treated as sensitive. */
const BASE64_RE = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;

/**
 * Masks what is shaped like a credential: a bearer token, a Basic credential in an Authorization header, a key
 * with a known prefix (including GitHub and Slack tokens), a JWT, a Telegram bot token, an AWS access key id, a
 * PEM private key block, the user and password of a URL, a cookie header, or the value of an upper-case `.env`
 * line whose name has a KEY, SECRET, TOKEN or PASSWORD part.
 * It leaves long opaque runs alone, so a content hash, a signed link or a long identifier stays readable.
 * Use it where the text is data a person or a program reads back (a tool's input or output); use
 * `redactSecrets` for a message that is only ever shown.
 */
export function redactCredentials(text: string): string {
  if (!text) {
    return text;
  }
  let result = text
    .replace(PRIVATE_KEY_BLOCK_RE, "[REDACTED]")
    .replace(URL_USERINFO_RE, "[REDACTED]@")
    .replace(COOKIE_HEADER_RE, maskCookieHeader)
    .replace(JWT_RE, "[REDACTED]")
    .replace(TELEGRAM_TOKEN_RE, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_ID_RE, "[REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(BASIC_AUTH_RE, "$1[REDACTED]")
    .replace(ENV_ASSIGNMENT_RE, maskEnvAssignment);
  for (const pattern of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  return redactCredentials(text).replace(BASE64_RE, "[REDACTED]");
}
