const BEARER_RE = /\bBearer(?:\s+|%20|\+)[A-Za-z0-9\-._~+/%]{8,}/gi;

const KEY_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9\-_]{8,}/g,
  /\bsk-[A-Za-z0-9\-_]{8,}/g,
  /\btvly-[A-Za-z0-9\-_]{8,}/g,
  /\bAIza[A-Za-z0-9\-_]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-\d+-[A-Za-z0-9-]{8,}/g,
  /\bxoxe(?:-\d-|\.xox[a-z]-\d-)[A-Za-z0-9-]{10,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_live_[A-Za-z0-9]{10,}/g,
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

const JWT_CHAIN_RE = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*eyJ[A-Za-z0-9_.-]*/g;
const JWT_HEADER_RE = /(?<![A-Za-z0-9_])eyJ(?=[A-Za-z0-9_-]{8})/;
const JWT_PART_MIN_LENGTH = 8;

function maskJwts(chain: string): string {
  const parts = chain.split(".");
  const kept: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const header = parts[index].search(JWT_HEADER_RE);
    const hasTwoMoreParts =
      index + 2 < parts.length &&
      parts[index + 1].length >= JWT_PART_MIN_LENGTH &&
      parts[index + 2].length >= JWT_PART_MIN_LENGTH;
    if (header >= 0 && hasTwoMoreParts) {
      kept.push(`${parts[index].slice(0, header)}[REDACTED]`);
      index += 3;
    } else {
      kept.push(parts[index]);
      index += 1;
    }
  }
  return kept.join(".");
}

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

const API_KEY_HEADER_RE = /\b(x-api-key["']?[ \t]*[:=][ \t]*["']?)[^\s"',;&#)}\]>]{8,}/gi;

const ENV_ASSIGNMENT_RE = /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)(\S[^\r\n]*)/gm;
const SECRET_NAME_ENDING_RE = /(?:PASSWORD|PASSWD|APIKEY)$|(?:^|_)(?:KEY|SECRET|TOKEN|PASS|SECRET_KEY_BASE)$|_PWD$/;

const PLAIN_SETTING_VALUE_RE =
  /^["']?(?:[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|true|false)["']?(?:[ \t]+#.*)?[ \t]*$/i;

function maskEnvAssignment(match: string, head: string, name: string, equals: string, value: string): string {
  if (!SECRET_NAME_ENDING_RE.test(name) || PLAIN_SETTING_VALUE_RE.test(value)) {
    return match;
  }
  return `${head}${name}${equals}[REDACTED]`;
}

const BASE64_RE = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
const OPAQUE_RUN_RE = /(?<![A-Za-z0-9+./\\_-])(\.*)([A-Za-z0-9+/\\_-][A-Za-z0-9+./\\_-]{30,}[A-Za-z0-9+/\\_-])={0,2}/g;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_LABEL_RE = /^[a-z]+(?:_[a-z]+){2,}$/;
const FILE_EXTENSION_RE = /\.[a-z][a-z0-9]{0,9}$/i;

function isPathLike(token: string, padded: boolean, followsColon: boolean): boolean {
  if (token.includes("\\") || (followsColon && token.startsWith("//"))) {
    return true;
  }
  if (padded || token.includes("+")) {
    return false;
  }
  const absolute = token.startsWith("/");
  const slash = token.indexOf("/", absolute ? 1 : 0);
  // A slash alone is ambiguous with base64; prefer paths only with another path signal.
  return (
    slash !== -1 &&
    (FILE_EXTENSION_RE.test(token) || (/^[a-z0-9._/-]+$/.test(token) && (absolute || token.includes("/", slash + 1))))
  );
}

function maskOpaqueRun(match: string, leadingDots: string, token: string, offset: number, text: string): string {
  if (
    isPathLike(token, match.endsWith("="), text[offset - 1] === ":") ||
    UUID_RE.test(token) ||
    DIAGNOSTIC_LABEL_RE.test(token)
  ) {
    return match;
  }
  if (/[._-]/.test(token) && /[a-z0-9]/i.test(token)) {
    return `${leadingDots}[REDACTED]`;
  }
  return match.replace(BASE64_RE, "[REDACTED]");
}

export function redactCredentials(text: string): string {
  if (!text) {
    return text;
  }
  let result = text
    .replace(PRIVATE_KEY_BLOCK_RE, "[REDACTED]")
    .replace(URL_USERINFO_RE, "[REDACTED]@")
    .replace(COOKIE_HEADER_RE, maskCookieHeader)
    .replace(JWT_CHAIN_RE, maskJwts)
    .replace(TELEGRAM_TOKEN_RE, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_ID_RE, "[REDACTED]")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(BASIC_AUTH_RE, "$1[REDACTED]")
    .replace(API_KEY_HEADER_RE, "$1[REDACTED]")
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
  return redactCredentials(text).replace(OPAQUE_RUN_RE, maskOpaqueRun);
}
