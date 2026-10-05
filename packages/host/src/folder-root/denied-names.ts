/**
 * Which names in an owner's folder the agent may never touch, and which it should not wade through.
 *
 * Matching is by name only, case-insensitive, on every platform. A name is checked wherever it
 * appears in a path, so `.git/config` and `src/.ssh/known_hosts` are both refused.
 */

const DENIED_EXACT: ReadonlySet<string> = new Set([
  ".env",
  ".envrc",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  // Directories: a segment with one of these names puts everything below it out of reach.
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
]);

const DENIED_EXTENSIONS: readonly string[] = [".pem", ".key", ".p12", ".pfx"];

const DENIED_PREFIXES: readonly string[] = [".env.", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

/** Readable when asked for by path, but left out of listings and searches: they are noise, not work. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", ".next", ".turbo"]);

/** Directories a folder may not be mounted from or inside, whatever their parent. */
export const SENSITIVE_DIR_NAMES: ReadonlySet<string> = new Set([".git", ".ssh", ".aws", ".gnupg"]);

export function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (DENIED_EXACT.has(lower)) {
    return true;
  }
  if (DENIED_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return DENIED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isDeniedPath(segments: readonly string[]): boolean {
  return segments.some(isDeniedName);
}

export function isSkippedDirName(name: string): boolean {
  return SKIPPED_DIRS.has(name.toLowerCase());
}
