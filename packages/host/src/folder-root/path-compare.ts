import path from "node:path";

/** Windows and macOS volumes are case-insensitive by default, so a deny rule has to be too. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export function normalizeForCompare(value: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === "win32" ? path.win32 : path.posix).resolve(value);
  return foldsCase(platform) ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is `root` or somewhere below it. Both must already be real paths. */
export function isInsideOrEqual(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const impl = platform === "win32" ? path.win32 : path.posix;
  const rel = impl.relative(normalizeForCompare(root, platform), normalizeForCompare(candidate, platform));
  if (rel === "") {
    return true;
  }
  if (impl.isAbsolute(rel)) {
    return false;
  }
  return rel.split(/[\\/]/)[0] !== "..";
}

export function isSamePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}
