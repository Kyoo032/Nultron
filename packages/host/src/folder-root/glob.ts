import { FOLDER_SEARCH_PATTERN_MAX } from "./constants";
import { refuse } from "./refusal";

const MAX_ALTERNATIVES = 16;

/** Expand one level of `{a,b}` into plain patterns. More than `MAX_ALTERNATIVES` is refused. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  const close = open === -1 ? -1 : pattern.indexOf("}", open);
  if (open === -1 || close === -1) {
    return [pattern];
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(",");
  const expanded = options.flatMap((option) => expandBraces(`${head}${option}${tail}`));
  if (expanded.length > MAX_ALTERNATIVES) {
    return refuse("bad_pattern");
  }
  return expanded;
}

/** `*` and `?` inside one name, by two-pointer backtracking: O(name x pattern), no regex. */
function matchName(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      resume = n;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") {
    p += 1;
  }
  return p === pattern.length;
}

/** Segment-wise match where `**` swallows zero or more whole segments. Memoised, so it cannot blow up. */
function matchSegments(pattern: readonly string[], parts: readonly string[]): boolean {
  const seen = new Map<number, boolean>();
  const walk = (pi: number, si: number): boolean => {
    const key = pi * (parts.length + 1) + si;
    const cached = seen.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let result: boolean;
    if (pi === pattern.length) {
      result = si === parts.length;
    } else if (pattern[pi] === "**") {
      result = walk(pi + 1, si) || (si < parts.length && walk(pi, si + 1));
    } else {
      result = si < parts.length && matchName(pattern[pi], parts[si]) && walk(pi + 1, si + 1);
    }
    seen.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/**
 * A matcher for `list_files` and `search_files` globs. Case-insensitive. A pattern with no `/` is
 * matched against the file name at any depth (`*.md`); one with a `/` is matched against the whole
 * path from the folder root (`src/**\/*.ts`). Supports `*`, `?`, `**` and one level of `{a,b}`.
 */
export function compileGlob(glob: string | undefined): (relPath: string) => boolean {
  if (glob === undefined || glob.trim() === "") {
    return () => true;
  }
  if (glob.length > FOLDER_SEARCH_PATTERN_MAX || glob.includes("\\") || glob.includes("\0")) {
    return refuse("bad_pattern");
  }
  const patterns = expandBraces(glob.toLowerCase()).map((pattern) => pattern.split("/").filter(Boolean));
  return (relPath) => {
    const parts = relPath.toLowerCase().split("/");
    return patterns.some((pattern) => {
      if (pattern.length === 1 && pattern[0] !== "**") {
        return matchName(pattern[0], parts[parts.length - 1]);
      }
      return matchSegments(pattern, parts);
    });
  };
}
