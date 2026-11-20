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
// A run may end in `=` padding of any length and/or a `.`/`~` tail that holds at least one `~`
// (`token.~`, `token~`, `token=.~`, `token==~`, `token~=`): padding and tail are captured apart
// from the token so a masked run keeps none of them, while a lone `.` stays ambiguous with
// sentence punctuation and is never eaten.
const OPAQUE_RUN_RE =
  /(?<![A-Za-z0-9+./\\_-])(\.*)([A-Za-z0-9+/\\_-][A-Za-z0-9+./\\_-]{30,}[A-Za-z0-9+/\\_-])(=*)((?:[.~]*~)?=*)/g;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FILE_EXTENSION_RE = /\.[a-z][a-z0-9]{0,9}$/i;

// Exact event names emitted by the app that would otherwise resemble opaque credentials.
const DIAGNOSTIC_LABELS = new Set([
  "artifacts_knowledge_card_not_dropped",
  "code_runner_ship_path_unsupported",
  "edit_starter_rollback_media_row_kept",
  "entitlement_period_roll_not_persisted",
  "file_extract_native_converter_unavailable",
  "finance_budget_embeddings_unavailable",
  "finance_xlsx_formula_cells_without_value",
  "knowledge_backend_chunk_index_fallback_failed",
  "knowledge_backend_fts_query_failed",
  "knowledge_embed_vectors_not_written",
  "knowledge_expand_chunk_read_failed",
  "knowledge_extract_document_conversion_failed",
  "knowledge_extract_docx_directory_unreadable",
  "knowledge_extract_docx_parse_failed",
  "knowledge_extract_docx_too_large",
  "knowledge_graph_cites_not_recorded",
  "knowledge_graph_prune_step_skipped",
  "knowledge_graph_retrieval_projection_skipped",
  "knowledge_ingest_blocked_card_not_recorded",
  "knowledge_ingest_chat_card_skipped",
  "knowledge_ingest_failure_not_recorded",
  "knowledge_ingest_origin_lookup_failed",
  "knowledge_map_graph_projection_skipped",
  "knowledge_map_source_not_forgotten",
  "knowledge_owned_artifacts_not_removed",
  "knowledge_retrievals_count_failed",
  "knowledge_retrievals_not_recorded",
  "knowledge_stored_upload_not_removed",
  "knowledge_verify_plant_not_removed",
  "meeting_knowledge_card_not_dropped",
  "meeting_minutes_items_unverified",
  "settings_injection_guard_bypass_dropped",
  "settings_injection_guard_bypass_not_cleared",
  "settings_legacy_json_not_deleted",
  "settings_stored_gateway_endpoint_ignored",
  "tenant_erase_portal_signout_failed",
  "tenant_state_adopted_file_not_renamed",
  "threads_knowledge_card_not_dropped",
]);

// A run with a backslash is a path only when it is a Windows or UNC one: `\\server\share`, or the tail of
// `C:\...` after the drive colon (a colon never sits inside a run). Any other backslash run is an
// escaped or obfuscated token and stays on the masking path.
const isWindowsPathRun = (token: string, followsColon: boolean): boolean =>
  token.startsWith("\\\\") || (followsColon && token.startsWith("\\"));

// In a URL run after a scheme colon, a path segment this long and shapeless is a token (a webhook's
// secret part, a signed link's key); words, ids, hosts and short segments stay readable. The bare
// 24+ rule also asks for token entropy — at least two of lower, upper and digit — so a long
// word-like segment (`gettingstartedwithinstallation`) keeps its text.
const URL_TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{24,}$/;
const URL_OPAQUE_SEGMENT_RE = /^[A-Za-z0-9+._~-]{32,}$/;
const URL_SEGMENT_CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/];
const looksLikeUrlToken = (segment: string): boolean =>
  URL_SEGMENT_CLASSES.filter((cls) => cls.test(segment)).length >= 2;

function maskUrlRun(match: string, token: string): string {
  const masked = token
    .split("/")
    .map((segment, index) => {
      // A `.`/`~` tail or `=` padding the opaque run joined into the token is not part of the
      // segment's shape: the token rule tests the bare segment, the opaque rule the segment
      // with `=` padding removed (`.~` still counts toward its length).
      const bare = segment.replace(/[.~]*~=*$/, "").replace(/=*$/, "");
      return index > 2 &&
        !UUID_RE.test(bare) &&
        ((URL_TOKEN_SEGMENT_RE.test(bare) && looksLikeUrlToken(bare)) ||
          URL_OPAQUE_SEGMENT_RE.test(segment.replace(/=/g, "")))
        ? "[REDACTED]"
        : segment;
    })
    .join("/");
  return masked === token ? match : match.replace(token, masked);
}

function isPathLike(token: string, padded: boolean, followsColon: boolean): boolean {
  if (isWindowsPathRun(token, followsColon)) {
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

function maskOpaqueRun(
  match: string,
  leadingDots: string,
  token: string,
  padding: string,
  tail: string,
  offset: number,
  text: string,
): string {
  if (text[offset - 1] === ":" && token.startsWith("//")) {
    return maskUrlRun(match, token + padding + tail);
  }
  if (
    isPathLike(token, padding !== "", text[offset - 1] === ":") ||
    UUID_RE.test(token) ||
    DIAGNOSTIC_LABELS.has(token)
  ) {
    return match;
  }
  if (/[._-]/.test(token) && /[a-z0-9]/i.test(token)) {
    return `${leadingDots}[REDACTED]`;
  }
  if (token.includes("\\")) {
    return `${leadingDots}[REDACTED]`;
  }
  const masked = match.replace(BASE64_RE, "[REDACTED]");
  return masked === match ? match : masked.replace(/=*[.~]*~=*$/, "").replace(/=+$/, "");
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
