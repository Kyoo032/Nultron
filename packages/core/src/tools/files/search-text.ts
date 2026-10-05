import { createContext, Script } from "node:vm";
import { type EnvLike, isServerMode } from "../../server-mode";
import { cutText, MAX_LINE_CHARS, splitLines } from "./lines";
import { fileRefusal } from "./refusals";
import type { DeskPath, FileRefusal, SearchHit } from "./types";

export const MAX_SEARCH_HITS = 200;
export const MAX_SEARCH_PATTERN_CHARS = 200;
export const MAX_HIT_TEXT_CHARS = 300;

const REGEX_BUDGET_MS = 4000;
const REGEX_PER_FILE_MS = 1000;

/**
 * Boundary check for the pattern the model sent. Every problem with the pattern itself is
 * `bad_pattern`, and nothing has been searched when it is returned.
 *
 * Regex search is refused outright on the hosted server: it runs synchronously in `node:vm` for up
 * to `REGEX_BUDGET_MS`, which blocks the one event loop every tenant shares. Desktop and webdev keep it.
 * The refusal comes before the pattern is compiled, so no regex is built or run on that path.
 */
export function checkSearchPattern(pattern: string, regex: boolean, env: EnvLike = process.env): FileRefusal | null {
  if (pattern === "") {
    return fileRefusal("bad_pattern", "The search pattern is empty.");
  }
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    return fileRefusal("bad_pattern", `The search pattern is longer than ${MAX_SEARCH_PATTERN_CHARS} characters.`);
  }
  if (regex && isServerMode(env)) {
    return fileRefusal(
      "bad_pattern",
      "Regular expression search is not available here. Search for plain text instead: leave regex off and use a distinctive piece of the text.",
    );
  }
  if (regex) {
    try {
      new RegExp(pattern);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return fileRefusal("bad_pattern", `The regular expression is not valid: ${reason}`);
    }
  }
  return null;
}

/** Case-sensitive substring search, one hit per matching line. The reference for what a root's `search` returns. */
export function searchLiteralLines(path: DeskPath, text: string, needle: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
    const line = lines[index] as string;
    if (line.includes(needle)) {
      hits.push({ path, line: index + 1, text: cutText(line, MAX_HIT_TEXT_CHARS) });
    }
  }
  return hits;
}

/**
 * Regex matching runs inside a `node:vm` context with a timeout, because a JavaScript regex cannot be
 * interrupted from outside and a pattern like `(a|a)*b` runs for years on a long line. The script
 * is fixed text; the model's pattern only ever reaches `new RegExp`. Lines are tested up to
 * `MAX_LINE_CHARS` characters.
 */
const SCAN_SOURCE = `(function () {
  const re = new RegExp(source);
  const found = [];
  for (let index = 0; index < lines.length && found.length < limit; index += 1) {
    const line = lines[index];
    if (re.test(line.length > cap ? line.slice(0, cap) : line)) {
      found.push(index);
    }
  }
  return found;
})()`;

let scanScript: Script | null = null;

function getScanScript(): Script {
  scanScript ??= new Script(SCAN_SOURCE);
  return scanScript;
}

export type RegexScanner = (path: DeskPath, text: string, limit: number) => SearchHit[] | "too_slow";

function isTooSlow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const failure = error as { code?: unknown; name?: unknown };
  return failure.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || failure.name === "RangeError";
}

/**
 * One scanner per search: it carries the time budget for the whole search, so a pattern that is
 * slow on many files cannot hold the host longer than `budgetMs` in total.
 */
export function createRegexScanner(source: string, budgetMs = REGEX_BUDGET_MS): RegexScanner {
  // The context's globals are this object's properties, so the per-file inputs are set on it.
  const sandbox = { source, lines: [] as string[], limit: 0, cap: MAX_LINE_CHARS };
  const context = createContext(sandbox);
  const deadline = Date.now() + budgetMs;
  return (path, text, limit) => {
    const remaining = deadline - Date.now();
    if (remaining < 1) {
      return "too_slow";
    }
    const lines = splitLines(text);
    sandbox.lines = lines;
    sandbox.limit = limit;
    try {
      const found = getScanScript().runInContext(context, {
        timeout: Math.max(1, Math.floor(Math.min(remaining, REGEX_PER_FILE_MS))),
      }) as number[];
      return Array.from(found, (index) => ({
        path,
        line: index + 1,
        text: cutText(lines[index] as string, MAX_HIT_TEXT_CHARS),
      }));
    } catch (error) {
      if (isTooSlow(error)) {
        return "too_slow";
      }
      throw error;
    }
  };
}
