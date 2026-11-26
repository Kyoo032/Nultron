/**
 * Sender → user resolution (F5b): a `From:` header to an address, an address to the allowlist row
 * that lets it in, an allowlist row to the Nultron user it acts as.
 */
import type { EmailAllowlistRow } from "./store";

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** `Jane Doe <jane@example.com>`, `<jane@example.com>` or `jane@example.com` → the address, lowercased. */
export function senderAddressOf(fromHeader: unknown): string | null {
  if (typeof fromHeader !== "string") {
    return null;
  }
  const angle = fromHeader.match(/<([^<>]+)>/);
  const candidate = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  return ADDRESS_RE.test(candidate) ? candidate : null;
}

/** A stored allowlist pattern is valid input only as an address or a domain. */
export function normalizeAllowlistPattern(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value.startsWith("@") || value.startsWith("*@")) {
    const domain = value.replace(/^\*?@/, "");
    if (domain.length > 0 && !domain.includes("@") && !domain.includes("<")) {
      return `@${domain}`;
    }
    return "";
  }
  return ADDRESS_RE.test(value) ? value : "";
}

/**
 * Whether a pattern admits a sender. An exact address matches itself only; a domain pattern
 * (`@example.com`) matches any address on that domain. First match wins.
 */
export function patternMatches(pattern: string, address: string): boolean {
  const normalized = normalizeAllowlistPattern(pattern);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("@")) {
    return address.endsWith(normalized) && address.length > normalized.length;
  }
  return address === normalized;
}

/** The first allowlist row that admits this sender, or null — an unknown sender. */
export function matchAllowlist(entries: readonly EmailAllowlistRow[], address: string): EmailAllowlistRow | null {
  return entries.find((entry) => patternMatches(entry.pattern, address)) ?? null;
}
