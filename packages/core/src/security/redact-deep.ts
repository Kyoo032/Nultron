import { redactCredentials } from "./redact";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[circular]";
const TOO_DEEP = "[too deep]";

/** Deeper than any tool result is nested; what is past it is replaced, never passed on unread. */
export const REDACT_MAX_DEPTH = 32;

/**
 * A key that holds a credential whatever the value looks like. Exact names, case-insensitive, so a field
 * called `max_tokens` or a sentence that says "token" is left alone.
 */
const SECRET_KEY =
  /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|secret|client[-_]?secret|password|passwd|token|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|bearer|(?:telegram[-_]?)?bot[-_]?token|cookie|set-cookie|private[-_]?key|secret[-_]?key|access[-_]?key|credentials?)$/i;

function isLeaf(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set
  );
}

function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    return redactCredentials(value);
  }
  if (typeof value !== "object" || value === null || isLeaf(value)) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (depth >= REDACT_MAX_DEPTH) {
    return TOO_DEEP;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "string" && item.length > 0 && SECRET_KEY.test(key)
          ? REDACTED
          : walk(item, depth + 1, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/**
 * A copy of a tool's input or output with every credential masked, for what is stored, streamed to the
 * screen or logged. It masks text shaped like a key or a bearer token at any depth, and the value of a key
 * that is named like a secret (`authorization`, `api_key`, `password`, `token`, and the like). The
 * original is never changed, and a cycle or a subtree past `REDACT_MAX_DEPTH` is replaced by a marker.
 *
 * It does not apply `redactSecrets`'s rule for long opaque runs: that would erase the content hashes,
 * signed media links and long identifiers a tool result legitimately carries, and the renderer needs
 * them. A secret with no known prefix, under a key that is not named like one, is not caught here.
 *
 * Never use the result as what the model reads back. The model needs the real content to go on.
 */
export function redactSecretsDeep(value: unknown): unknown {
  return walk(value, 0, new Set());
}
