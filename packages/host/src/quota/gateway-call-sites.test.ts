import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATEWAY_CALL_SITES, RUNTIME_CALLERS } from "./call-sites";

const CENSUS_PATTERNS = [
  "Bearer",
  "/embeddings",
  "images/generations",
  "video/generations",
  "/suno",
  "audio/transcriptions",
  "/audio/speech",
  "/rerank",
  "/moderations",
  "x-api-key",
  "fetchImpl",
  "createOpenAI(",
  "createAnthropic(",
  "createGoogleGenerativeAI(",
];

const RUNTIME_CALL_PATTERN =
  /(?<!function\s)\bcreateRuntime\(|new AiSdkRuntime\(|(?<!function\s)\bresolveProviderKeys\(/;

const EXCLUDED_DIR_NAMES = new Set(["__fixtures__", "eval", "node_modules"]);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.has(entry.name)) collectSourceFiles(full, out);
    } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

function packageSourceFiles(root: string): string[] {
  const packagesDir = path.join(root, "packages");
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    const src = path.join(packagesDir, pkg.name, "src");
    if (pkg.isDirectory() && existsSync(src)) collectSourceFiles(src, files);
  }
  return files;
}

function repoRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function filesMatching(root: string, matches: (text: string) => boolean): Set<string> {
  const found = new Set<string>();
  for (const file of packageSourceFiles(root)) {
    if (matches(readFileSync(file, "utf8"))) found.add(repoRelative(root, file));
  }
  return found;
}

function staleEntries(root: string, entries: string[], matches: Set<string>): string[] {
  return entries
    .filter((file) => !matches.has(file))
    .map((file) =>
      existsSync(path.join(root, file)) ? `${file} (no longer matches)` : `${file} (file no longer exists)`,
    )
    .sort();
}

const censusFiles = filesMatching(REPO_ROOT, (text) => CENSUS_PATTERNS.some((pattern) => text.includes(pattern)));
const runtimeCallerFiles = filesMatching(REPO_ROOT, (text) => RUNTIME_CALL_PATTERN.test(text));
const registered = Object.keys(GATEWAY_CALL_SITES);
const runtimeRegistered = Object.keys(RUNTIME_CALLERS);

describe("gateway call-site census", () => {
  it("finds the gateway call sites in packages/*/src", () => {
    expect(censusFiles.size).toBeGreaterThan(0);
  });

  it("has a registry entry for every source file that touches the gateway", () => {
    const missing = [...censusFiles].filter((file) => !registered.includes(file)).sort();
    expect(missing).toEqual([]);
  });

  it("has no registry entry whose file is gone or no longer touches the gateway", () => {
    expect(staleEntries(REPO_ROOT, registered, censusFiles)).toEqual([]);
  });

  it("tags every entry work, platform, or none with a reason", () => {
    const invalid = registered.filter((file) => {
      const tag = GATEWAY_CALL_SITES[file];
      return tag !== "work" && tag !== "platform" && !(tag?.startsWith("none:") && tag.length > "none:".length);
    });
    expect(invalid).toEqual([]);
  });

  it("finds the runtime callers in packages/*/src", () => {
    expect(runtimeCallerFiles.size).toBeGreaterThan(0);
  });

  it("lists every file that calls createRuntime, AiSdkRuntime or resolveProviderKeys", () => {
    const unlisted = [...runtimeCallerFiles].filter((file) => !runtimeRegistered.includes(file)).sort();
    expect(unlisted).toEqual([]);
  });

  it("has no runtime caller entry whose file is gone or no longer calls them", () => {
    expect(staleEntries(REPO_ROOT, runtimeRegistered, runtimeCallerFiles)).toEqual([]);
  });
});
