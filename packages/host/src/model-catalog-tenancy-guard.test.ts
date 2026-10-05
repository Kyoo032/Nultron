/**
 * Enterprise BYOK, Phase A: nothing in the host reads a model catalogue without saying whose.
 *
 * The model cache is per tenant on the hosted server (`model-cache.ts`), and the catalogue functions
 * that read it take the tenant as an argument. A request in scope would rescue a caller that forgot
 * (`tenant-scope.ts`), but a stream body, a worker and a timer run outside that scope, and one of them
 * would then be refused on the hosted server (`tenant_required`) rather than answered from the wrong
 * tenant. That is the safe failure, and this guard is how it is found at review time instead of in
 * production: every call to one of the functions below must name a tenant or a scope in its arguments.
 *
 * Same idea as the gate and desk-id guards in `tenant-state.test.ts`: assert the shape of the call, in
 * a rule the compiler cannot express (the parameter is optional so a desk's callers stay unchanged).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = __dirname;

/** Every host function that reads or writes a model catalogue or its cache. */
const CATALOG_READERS = [
  "listCatalogModels",
  "listRoutedModels",
  "listSelectableModels",
  "listImageModels",
  "listVideoModels",
  "listProbedModels",
  "listProbedVideoModels",
  "listAudioModels",
  "listMusicModels",
  "listSpeechModels",
  "listEmbeddingModels",
  "defaultSelectableModel",
  "modeCatalogPayload",
  "modeDefaultsFor",
  "modelCatalogBody",
  "refreshModelCache",
  "loadModelCache",
  "saveModelCache",
  "modelCacheStamp",
  "probeSummary",
  "listStudioImageModels",
  "listStudioVideoModels",
  "listStudioMusicModels",
  "listStudioSpeechModels",
  "defaultStudioImageModel",
  "defaultStudioVideoModel",
  "defaultStudioMusicModel",
  "studioSpeechUnavailable",
  "resolveAsrCapability",
  "cachedModelIds",
  "editAgentModelId",
] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The text between the call's parentheses, balanced, or null when the call never closes. */
function argumentsOf(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  return null;
}

const NAMES_A_TENANT = /\b(?:tenant|scope)\b|\.tenant\b/;

function callsIn(file: string): Array<{ name: string; args: string; line: number }> {
  const text = withoutComments(readFileSync(file, "utf8"));
  const calls: Array<{ name: string; args: string; line: number }> = [];
  const pattern = new RegExp(`(?<![.\\w])(${CATALOG_READERS.join("|")})\\(`, "g");
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 10), start);
    if (/function\s*$/.test(before)) {
      continue;
    }
    const args = argumentsOf(text, start + match[0].length - 1);
    if (args === null) {
      continue;
    }
    calls.push({ name: match[1] as string, args, line: text.slice(0, start).split("\n").length });
  }
  return calls;
}

describe("no host source reads a model catalogue without naming a tenant", () => {
  it("finds the calls it is meant to police", () => {
    const all = sourceFiles(SRC).flatMap((file) => callsIn(file));
    // A guard that matches nothing guards nothing: these two are called from many places.
    expect(all.filter((call) => call.name === "listSelectableModels").length).toBeGreaterThan(8);
    expect(all.filter((call) => call.name === "modeDefaultsFor").length).toBeGreaterThan(8);
    expect(all.filter((call) => call.name === "loadModelCache").length).toBeGreaterThan(3);
  });

  it("passes a tenant or a scope to every one", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const call of callsIn(file)) {
        if (!NAMES_A_TENANT.test(call.args)) {
          offenders.push(`${path.relative(SRC, file)}:${call.line}: ${call.name}(${call.args.trim()})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
