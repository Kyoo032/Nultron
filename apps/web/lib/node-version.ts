/**
 * The oldest Node.js major the web server runs on (SH-001). better-sqlite3 13 declares `>=22` and is
 * built for N-API 10; on Node 20 loading it segfaults (exit 139) with no message. The root
 * `package.json` `engines.node` and `.nvmrc` name the same major, so change all three together.
 *
 * Pure on purpose: no imports and no reads of `process`, so the test can feed it any string.
 */
export const MIN_NODE_MAJOR = 22;

const VERSION_PATTERN = /^v?(\d+)\.\d+\.\d+/;

/** Throws when `version` (the form of `process.version`, e.g. `v22.11.0`) is older than the minimum or unreadable. */
export function assertSupportedNode(version: string): void {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Could not read the Node.js version "${version}". This server needs Node.js ${MIN_NODE_MAJOR} or newer.`,
    );
  }
  if (Number(match[1]) < MIN_NODE_MAJOR) {
    throw new Error(
      `This server needs Node.js ${MIN_NODE_MAJOR} or newer; it was started with ${version}. Install Node.js ${MIN_NODE_MAJOR} (the repo's .nvmrc names it) and start the server again.`,
    );
  }
}
