import { fileRefusal } from "./refusals";
import type { FileRefusal } from "./types";

export const MAX_GLOB_CHARS = 200;
export const MAX_GLOB_EXPANSIONS = 64;

type BraceGroup = { start: number; end: number; alternatives: string[] };

/** The first `{...}` that has a matching `}`. A brace with no partner is an ordinary character. */
function findBraceGroup(glob: string): BraceGroup | null {
  for (let start = glob.indexOf("{"); start !== -1; start = glob.indexOf("{", start + 1)) {
    const alternatives: string[] = [];
    let depth = 0;
    let alternativeStart = start + 1;
    for (let index = start; index < glob.length; index += 1) {
      const char = glob[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          alternatives.push(glob.slice(alternativeStart, index));
          return { start, end: index, alternatives };
        }
      } else if (char === "," && depth === 1) {
        alternatives.push(glob.slice(alternativeStart, index));
        alternativeStart = index + 1;
      }
    }
  }
  return null;
}

/** Every plain glob a brace glob stands for, or null when there would be more than the cap. */
function expandBraces(glob: string): string[] | null {
  const group = findBraceGroup(glob);
  if (!group) {
    return [glob];
  }
  const prefix = glob.slice(0, group.start);
  const suffix = glob.slice(group.end + 1);
  const expanded: string[] = [];
  for (const alternative of group.alternatives) {
    const inner = expandBraces(prefix + alternative + suffix);
    if (!inner) {
      return null;
    }
    expanded.push(...inner);
    if (expanded.length > MAX_GLOB_EXPANSIONS) {
      return null;
    }
  }
  return expanded;
}

/** `*` and `?` inside one path part. Two-pointer match: linear in the part, never backtracks deeply. */
function partMatches(pattern: readonly string[], text: readonly string[]): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starAt = p;
      p += 1;
      resumeAt = t;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      resumeAt += 1;
      t = resumeAt;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") {
    p += 1;
  }
  return p === pattern.length;
}

type GlobPart = { readonly anyDepth: true } | { readonly anyDepth: false; readonly chars: readonly string[] };

function compileGlob(glob: string): GlobPart[] {
  return glob
    .split("/")
    .map((part) => (part === "**" ? { anyDepth: true } : { anyDepth: false, chars: Array.from(part) }));
}

/**
 * Whole path against whole glob, one row of a table per glob part, so a run of `**` parts costs
 * parts times parts and nothing worse. A `**` part spans zero or more folders, except as the last
 * part, where it needs at least one more part below.
 */
function pathMatches(glob: readonly GlobPart[], path: string): boolean {
  const parts = path.split("/").map((part) => Array.from(part));
  const width = parts.length;
  let below = Array.from({ length: width + 1 }, (_, index) => index === width);
  for (let row = glob.length - 1; row >= 0; row -= 1) {
    const part = glob[row] as GlobPart;
    const current = new Array<boolean>(width + 1).fill(false);
    for (let column = width; column >= 0; column -= 1) {
      if (part.anyDepth) {
        current[column] =
          row === glob.length - 1
            ? column < width
            : (below[column] as boolean) || (column < width && (current[column + 1] as boolean));
      } else {
        current[column] =
          column < width && partMatches(part.chars, parts[column] as string[]) && (below[column + 1] as boolean);
      }
    }
    below = current;
  }
  return below[0] as boolean;
}

/**
 * A matcher for one glob, built once for a loop over many paths. Syntax: `*` and `?` stay inside
 * one folder part, a whole part `**` crosses folders, `{a,b}` picks alternatives (nesting works,
 * an unpaired brace is an ordinary character). Case sensitive, matched against the full path from
 * the top. A glob that expands past the alternative cap matches nothing.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  const expansions = expandBraces(glob);
  if (!expansions) {
    return () => false;
  }
  const compiled = expansions.map(compileGlob);
  return (path) => compiled.some((candidate) => pathMatches(candidate, path));
}

export function matchGlob(path: string, glob: string): boolean {
  return globMatcher(glob)(path);
}

/** Boundary check for a glob the model sent. The matcher itself accepts anything. */
export function checkGlob(glob: string | undefined): FileRefusal | null {
  if (glob === undefined) {
    return null;
  }
  if (glob.length > MAX_GLOB_CHARS) {
    return fileRefusal("bad_pattern", `The glob is longer than ${MAX_GLOB_CHARS} characters.`);
  }
  if (expandBraces(glob) === null) {
    return fileRefusal("bad_pattern", `The glob has more than ${MAX_GLOB_EXPANSIONS} {a,b} combinations. Split it.`);
  }
  return null;
}
