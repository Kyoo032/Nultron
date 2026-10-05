import { fileRefusal, FileRootError } from "./refusals";
import { createRegexScanner, MAX_SEARCH_HITS } from "./search-text";
import type { FileRefusal, FileRoot, SearchHit } from "./types";

export const MAX_SCAN_FILES = 2000;
export const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export type RegexSearchOutcome = {
  readonly hits: SearchHit[];
  /** More hits, or more files, than the search looked at. */
  readonly truncated: boolean;
};

/**
 * `FileRoot.search` takes one string and cannot say "this is a regex", so the tool does regex
 * search itself over `list` and `read`. That keeps a root's own refusals (denied names, missing
 * files) in force and keeps the safe matcher in one place.
 */
export async function searchByRegex(
  root: FileRoot,
  source: string,
  glob: string | undefined,
): Promise<RegexSearchOutcome | FileRefusal> {
  const entries = await root.list(null, glob);
  const files = entries.filter((entry) => entry.kind === "file").sort((a, b) => (a.path < b.path ? -1 : 1));
  const scanner = createRegexScanner(source);
  const hits: SearchHit[] = [];
  let scannedBytes = 0;
  let truncated = files.length > MAX_SCAN_FILES;
  for (const entry of files.slice(0, MAX_SCAN_FILES)) {
    if (scannedBytes + entry.bytes > MAX_SCAN_BYTES) {
      truncated = true;
      break;
    }
    let file: Awaited<ReturnType<FileRoot["read"]>>;
    try {
      file = await root.read(entry.path);
    } catch (error) {
      if (error instanceof FileRootError && (error.code === "not_found" || error.code === "denied")) {
        continue;
      }
      throw error;
    }
    scannedBytes += entry.bytes;
    const found = scanner(file.path, file.text, MAX_SEARCH_HITS + 1 - hits.length);
    if (found === "too_slow") {
      return fileRefusal(
        "bad_pattern",
        "That regular expression is too slow to run. Use a simpler pattern, or search for plain text.",
      );
    }
    hits.push(...found);
    if (hits.length > MAX_SEARCH_HITS) {
      truncated = true;
      break;
    }
  }
  return { hits: hits.slice(0, MAX_SEARCH_HITS), truncated };
}
