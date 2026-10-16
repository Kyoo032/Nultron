import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NDA_TERMS_PATH = "nultron-files/release/nda-terms.txt";

export class NdaTermsError extends Error {}

export function parseNdaTerms(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.toLowerCase());
}

export function readNdaTerms(repoRoot) {
  const file = join(repoRoot, NDA_TERMS_PATH);
  if (!existsSync(file)) {
    throw new NdaTermsError(`NDA terms file not found: ${NDA_TERMS_PATH} (one term per line; it stays gitignored)`);
  }
  const terms = parseNdaTerms(readFileSync(file, "utf8"));
  if (terms.length === 0) throw new NdaTermsError(`NDA terms file has no terms: ${NDA_TERMS_PATH}`);
  return terms;
}

export function ndaTermCount(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length;
}
