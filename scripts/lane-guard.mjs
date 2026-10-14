#!/usr/bin/env node
/**
 * Lane guard: a change says which lanes it touches, keeps its map page, and stays brand-neutral.
 * Plan: docs/internal/white-label-and-agent-guardrails-plan.md.
 *
 * Why: one source repo feeds four lanes (Nultron Personal, Nultron Enterprise, HYP AI, the tester
 * code). Agents cannot see the vault note that lists which files the tester branch edits, and a
 * brand name typed into shared code ships to HYP AI. `lanes.json` at the repo root is that list, in
 * the repo, and this script reads it.
 *
 * Usage (repo root):
 *   node scripts/lane-guard.mjs                    the diff origin/main...HEAD
 *   node scripts/lane-guard.mjs <range>            e.g. main...HEAD or abc123..HEAD
 *   node scripts/lane-guard.mjs --branch <name>    judge this branch, not the checked-out one (the pre-push hook)
 *   node scripts/lane-guard.mjs --strict           also exit 1 on map warnings (ci:local does not pass this)
 *   node scripts/lane-guard.mjs --write-baseline   record today's brand-literal counts, see below
 *   node scripts/lane-guard.mjs --root <dir>       run against another repo (tests)
 *
 * Three BLOCKING rules (exit 1 with or without --strict):
 *   never-promote  a path added or changed in a diff to main that matches lanes.json `neverPromote`
 *                  (tester-only config, data and env files). Skipped on the tester branch itself and
 *                  for ranges whose base is not main.
 *   protected      a file marked "protected" changed and no commit in the range has a `Lanes:` line.
 *   brand          a brand literal (Nultron, Toko Token, TokenKu, HYP AI, Hypey) appears more often in a
 *                  shared-code file than `scripts/lane-guard.baseline.json` recorded. "Nultron" is the
 *                  default brand and the mascot name today, so a plain ban would be red on day one;
 *                  the ratchet only lets the count go down. Regenerate the baseline on a clean tree
 *                  with `--write-baseline` after a cleanup lowers a count, never to excuse an increase.
 *
 * One ADVISORY rule (exit 0 unless --strict):
 *   map        code under a lanes.json glob changed, but none of that glob's map pages did.
 *              Tests, markdown and fixtures never trigger it. An entry with "map": null is exempt.
 *
 * It skips (prints a line, exits 0, even under --strict) when lanes.json or docs/internal is absent
 * (the HYP AI import strips docs/internal) or when the range cannot be resolved or is empty (a
 * clone with no remote, or `main` itself). A lanes.json that cannot be read exits 1: an unreadable
 * manifest must not pass as a clean one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TESTER_BRANCH } from "./where-am-i.mjs";

const DEFAULT_RANGE = "origin/main...HEAD";
const LANES_FILE = "lanes.json";
const BASELINE_FILE = "scripts/lane-guard.baseline.json";
const DOCS_DIR = "docs/internal";

// ---------------------------------------------------------------------------------------------
// Pure helpers (tested in lane-guard.test.mjs)
// ---------------------------------------------------------------------------------------------

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** `**` crosses directories (and may match none), `*` stays inside one, `?` is one character, `{a,b}` is a choice. */
export function globToRegExp(glob) {
  return new RegExp(`^${globSource(glob)}$`);
}

function globSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "{" && glob.indexOf("}", i) > i) {
      const close = glob.indexOf("}", i);
      out += `(?:${glob
        .slice(i + 1, close)
        .split(",")
        .map(globSource)
        .join("|")})`;
      i = close;
    } else if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(REGEX_SPECIALS, "\\$&");
  }
  return out;
}

const compiled = new Map();
const matchesGlob = (file, glob) => {
  if (!compiled.has(glob)) compiled.set(glob, globToRegExp(glob));
  return compiled.get(glob).test(file);
};

/** Every lanes.json entry whose glob matches `file`. A file may match several. */
export function entriesFor(file, entries) {
  return entries.filter((entry) => matchesGlob(file, entry.glob));
}

const MAP_EXEMPT = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.md",
  "**/__fixtures__/**",
  "**/test/**",
  "**/tests/**",
  "docs/**",
];

/** A change to a test, a fixture or a document does not need a map refresh. */
export function isMapExempt(file) {
  return MAP_EXEMPT.some((glob) => matchesGlob(file, glob));
}

/**
 * Group changed code by the set of map pages it answers to. A group warns when none of its pages
 * changed in the same diff; one page being refreshed is enough, because a broad glob and a narrow
 * one may both claim a file and the narrow page is the one that describes it.
 */
export function mapWarnings(changed, entries) {
  const changedSet = new Set(changed);
  const groups = new Map();
  for (const file of changed) {
    if (isMapExempt(file)) continue;
    const maps = [
      ...new Set(
        entriesFor(file, entries)
          .map((e) => e.map)
          .filter(Boolean),
      ),
    ].sort();
    if (maps.length === 0) continue;
    const key = maps.join("|");
    const group = groups.get(key) ?? { maps, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => !g.maps.some((m) => changedSet.has(m)));
}

/** The text after `Lanes:` on any line that starts with it, case-insensitively; empty values are ignored. */
export function parseLanesLines(message) {
  const found = [];
  for (const line of String(message ?? "").split(/\r?\n/)) {
    const match = /^Lanes:[ \t]*(\S.*)$/i.exec(line);
    if (match) found.push(match[1].trim());
  }
  return found;
}

/** Protected files changed in a range whose commits carry no `Lanes:` line. */
export function protectedWarnings(changed, entries, messages) {
  const labelled = messages.some((m) => parseLanesLines(m).length > 0);
  if (labelled) return [];
  const files = changed.filter((file) => entriesFor(file, entries).some((e) => e.protected));
  if (files.length === 0) return [];
  const lanes = [...new Set(files.flatMap((f) => entriesFor(f, entries).flatMap((e) => e.lanes ?? [])))].sort();
  return [{ files, lanes }];
}

/** Changed paths (added, copied, modified, renamed) that match a `neverPromote` glob. */
export function neverPromoteWarnings(changed, globs) {
  return changed.filter((file) => globs.some((glob) => globToRegExp(glob).test(file)));
}

/**
 * The never-promote rule judges a diff to main, from any branch but the tester's. A detached HEAD
 * (`branch` null) is still a diff to main. Ranges with another base are not promotions.
 */
export function neverPromoteApplies({ base, branch }) {
  return (base === "main" || base === "origin/main") && branch !== TESTER_BRANCH;
}

/** `{ Nultron: 2 }` for the literals present at least once. Case-sensitive, substring. */
export function countLiterals(text, literals) {
  const counts = {};
  for (const literal of literals) {
    const n = text.split(literal).length - 1;
    if (n > 0) counts[literal] = n;
  }
  return counts;
}

/** Is this file shared code the brand rule applies to? */
export function inBrandScope(file, scope) {
  const ext = path.posix.extname(file);
  if (!scope.extensions.includes(ext)) return false;
  if (!scope.include.some((g) => matchesGlob(file, g))) return false;
  return !scope.exclude.some((g) => matchesGlob(file, g));
}

/**
 * For each changed shared-code file, any literal that now appears more often than the baseline says.
 * `read(file)` returns the file's text at the end of the range, or null when it is gone.
 */
export function brandWarnings(changed, scope, literals, baseline, read) {
  const warnings = [];
  for (const file of changed) {
    if (!inBrandScope(file, scope)) continue;
    const text = read(file);
    if (text === null) continue;
    const now = countLiterals(text, literals);
    const was = baseline.files?.[file] ?? {};
    for (const literal of literals) {
      const after = now[literal] ?? 0;
      const before = was[literal] ?? 0;
      if (after > before) warnings.push({ file, literal, was: before, now: after });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

const resolves = (root, ref) =>
  git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }) !== null;

/** The checked-out branch, or null on a detached HEAD. */
const currentBranch = (root) => (git(root, ["branch", "--show-current"], { allowFail: true }) ?? "").trim() || null;

const splitNul = (text) => (text ?? "").split("\0").filter(Boolean);

/** `A...B`, `A..B` or a lone ref (meaning `ref...HEAD`) → { base, tip }. */
export function splitRange(range) {
  const triple = range.indexOf("...");
  if (triple >= 0) return { base: range.slice(0, triple), tip: range.slice(triple + 3) || "HEAD" };
  const double = range.indexOf("..");
  if (double >= 0) return { base: range.slice(0, double), tip: range.slice(double + 2) || "HEAD" };
  return { base: range, tip: "HEAD" };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Tracked, in-scope files, for the baseline. */
function trackedInScope(root, scope) {
  const listed = git(root, ["ls-files", "-z"]) ?? "";
  return listed.split("\0").filter((file) => file && inBrandScope(file, scope));
}

function writeBaseline(root, config) {
  const files = {};
  for (const file of trackedInScope(root, config.brandScope).sort()) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const counts = countLiterals(readFileSync(abs, "utf8"), config.brandLiterals);
    if (Object.keys(counts).length > 0) files[file] = counts;
  }
  const out = path.join(root, BASELINE_FILE);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ literals: config.brandLiterals, files }, null, 2)}\n`);
  return Object.keys(files).length;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const VALUE_FLAGS = { "--root": "a directory", "--branch": "a branch name" };

export function parseArgs(argv) {
  const args = { range: null, strict: false, writeBaseline: false, root: null, branch: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") args.strict = true;
    else if (arg === "--write-baseline") args.writeBaseline = true;
    else if (VALUE_FLAGS[arg]) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs ${VALUE_FLAGS[arg]}`);
      args[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else args.range = arg;
  }
  return args;
}

/** lanes.json `neverPromote`: an array of glob strings. Anything else is a broken manifest. */
function readNeverPromote(config) {
  const globs = config.neverPromote ?? [];
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
    throw new Error(`${LANES_FILE} neverPromote must be an array of glob strings`);
  }
  return globs;
}

/**
 * Returns the printable lines, the blocking count and the advisory count. Throws when lanes.json cannot
 * be read or its neverPromote is malformed; main() turns that into exit 1.
 */
export function run(args, defaultRoot) {
  const root = path.resolve(args.root ?? defaultRoot);
  const lanesPath = path.join(root, LANES_FILE);
  if (!existsSync(lanesPath))
    return { lines: [`lane-guard: ${LANES_FILE} not found, skipped.`], blocking: 0, advisory: 0 };
  if (!existsSync(path.join(root, DOCS_DIR))) {
    return { lines: [`lane-guard: ${DOCS_DIR} not found (stripped import?), skipped.`], blocking: 0, advisory: 0 };
  }
  const config = readJson(lanesPath);
  const neverPromote = readNeverPromote(config);

  if (args.writeBaseline) {
    const n = writeBaseline(root, config);
    return {
      lines: [`lane-guard: wrote ${BASELINE_FILE} (${n} files carry a brand literal).`],
      blocking: 0,
      advisory: 0,
    };
  }

  const range = args.range ?? DEFAULT_RANGE;
  let { base, tip } = splitRange(range);
  if (!resolves(root, base) && !args.range && resolves(root, "main")) base = "main";
  if (!resolves(root, base) || !resolves(root, tip)) {
    return { lines: [`lane-guard: cannot resolve ${range} here (no remote?), skipped.`], blocking: 0, advisory: 0 };
  }
  const changed = (git(root, ["diff", "--name-only", "-z", `${base}...${tip}`]) ?? "").split("\0").filter(Boolean);
  if (changed.length === 0)
    return { lines: [`lane-guard: nothing changed in ${base}...${tip}, skipped.`], blocking: 0, advisory: 0 };
  const messages = (git(root, ["log", `${base}..${tip}`, "--format=%B%x00"]) ?? "").split("\0").filter((m) => m.trim());

  const branch = args.branch ?? currentBranch(root);
  const lines = [`lane-guard: ${base}...${tip}, ${changed.length} changed file(s), ${messages.length} commit(s).`];
  const found = { blocking: 0, advisory: 0 };
  const block = (text) => {
    found.blocking += 1;
    lines.push(text);
  };
  const warn = (text) => {
    found.advisory += 1;
    lines.push(text);
  };

  if (neverPromote.length > 0) {
    if (neverPromoteApplies({ base, branch })) {
      const added = splitNul(git(root, ["diff", "--name-only", "--diff-filter=d", "-z", `${base}...${tip}`]));
      for (const file of neverPromoteWarnings(added, neverPromote)) {
        block(
          `BLOCK never-promote: ${file} is tester-only (lanes.json neverPromote). A diff to main must not carry it; take it out of the change.`,
        );
      }
    } else if (branch === TESTER_BRANCH) {
      lines.push("lane-guard: never-promote skipped (the tester branch).");
    }
  }

  for (const w of mapWarnings(changed, config.entries ?? [])) {
    const shown = w.files.slice(0, 3).join(", ") + (w.files.length > 3 ? `, +${w.files.length - 3} more` : "");
    warn(
      `WARN map: ${shown} changed; refresh ${w.maps.join(" or ")} in the same PR (rewrite in place, bump "Last verified").`,
    );
  }
  for (const w of protectedWarnings(changed, config.entries ?? [], messages)) {
    block(
      `BLOCK protected: ${w.files.join(", ")} ${w.files.length > 1 ? "are" : "is"} shared with ${w.lanes.join(", ") || "other lanes"}; add a "Lanes: ..." line to a commit message naming the lanes this touches.`,
    );
  }
  const baselinePath = path.join(root, BASELINE_FILE);
  if (existsSync(baselinePath) && config.brandScope && config.brandLiterals) {
    const read = (file) => git(root, ["show", `${tip}:${file}`], { allowFail: true });
    for (const w of brandWarnings(changed, config.brandScope, config.brandLiterals, readJson(baselinePath), read)) {
      block(
        `BLOCK brand: ${w.file} has "${w.literal}" ${w.was} -> ${w.now}; shared code reads productName / gatewayName instead of a brand name.`,
      );
    }
  } else {
    lines.push(`lane-guard: no ${BASELINE_FILE}, brand check skipped.`);
  }
  if (found.blocking + found.advisory === 0) lines.push("lane-guard: no warnings.");
  return { lines, ...found };
}

function main() {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lane-guard: ${error.message}`);
    return 1;
  }
  try {
    const { lines, blocking, advisory } = run(args, defaultRoot);
    console.log(lines.join("\n"));
    if (blocking > 0) {
      console.log(`lane-guard: ${blocking} blocking problem(s); exit 1.`);
      return 1;
    }
    if (advisory === 0) return 0;
    if (args.strict) {
      console.log(`lane-guard: ${advisory} advisory warning(s) under --strict; exit 1.`);
      return 1;
    }
    console.log(`lane-guard: ${advisory} advisory warning(s); exit 0 (use --strict to fail).`);
    return 0;
  } catch (error) {
    // A manifest or git call that fails means the guard did not run. That must not pass as clean.
    console.error(`lane-guard: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
