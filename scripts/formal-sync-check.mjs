#!/usr/bin/env node
/**
 * Formal-verification sync check: detects when covered product files moved after a formal check's
 * recorded `Sync commit` without a maintenance pass (`/maintain-formal-verification-skill`).
 *
 * Reads every `.cursor/skills/<name>/SKILL.md` that declares `Sync commit: \`<sha>\``, extracts its
 * covered paths (from `Coverage:` lines and/or `## Coverage record` table cells), and checks
 * `git log --oneline <sha>..<base> -- <paths>` for commits that touched covered code.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_COMMIT_RE = /\*{0,2}Sync commit:\s*`([0-9a-f]{7,40})`\*{0,2}/i;
const PATH_PREFIX_RE = /^(?:packages|apps|scripts|formal|webapp-deploy|nix|\.cursor)\//;

function normalizePathToken(token) {
  let clean = token.trim().replace(/^`+|`+$/g, "");
  if (!PATH_PREFIX_RE.test(clean)) return null;
  // Turn glob tails like `packages/core/src/harness/modes/*` into directory prefixes git accepts.
  clean = clean.replace(/\/\*+$/, "").replace(/\*+$/, "");
  return clean || null;
}

function extractPaths(text) {
  const paths = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const normalized = normalizePathToken(match[1]);
    if (normalized) paths.push(normalized);
  }
  return [...new Set(paths)];
}

/** Parses one SKILL.md for `syncCommit` and `coveredPaths`. Returns null when not a synced formal skill. */
export function parseFormalSkill(markdown, filePath = "SKILL.md") {
  const syncMatch = SYNC_COMMIT_RE.exec(markdown);
  if (!syncMatch) return null;

  const lines = markdown.split(/\r?\n/);
  const covered = new Set();
  let inCoverageTable = false;

  for (const line of lines) {
    if (/^##\s+Coverage record\b/i.test(line)) {
      inCoverageTable = true;
      continue;
    }
    if (inCoverageTable && /^##\s+/.test(line)) {
      inCoverageTable = false;
    }
    if (/^\s*Coverage:/i.test(line)) {
      for (const p of extractPaths(line)) covered.add(p);
      continue;
    }
    if (inCoverageTable && /^\s*\|/.test(line) && !/^\s*\|\s*---/.test(line)) {
      const cells = line.split("|").slice(1, -1);
      if (cells[0]) {
        for (const p of extractPaths(cells[0])) covered.add(p);
      }
    }
  }

  return {
    file: filePath,
    syncCommit: syncMatch[1],
    coveredPaths: [...covered],
  };
}

export function discoverFormalSkills(root) {
  const skillsDir = path.join(root, ".cursor", "skills");
  if (!existsSync(skillsDir)) return [];
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const found = [];
  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const parsed = parseFormalSkill(readFileSync(skillPath, "utf8"), `.cursor/skills/${entry.name}/SKILL.md`);
    if (parsed) found.push({ name: entry.name, ...parsed });
  }
  return found;
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function checkFormalSync({ root = defaultRoot, base = "HEAD" } = {}) {
  const skills = discoverFormalSkills(root);
  const results = [];
  for (const skill of skills) {
    if (skill.coveredPaths.length === 0) {
      results.push({
        ...skill,
        status: "error",
        reason: "Sync commit present but no covered paths parsed",
        commits: [],
        changedPaths: [],
      });
      continue;
    }
    try {
      git(root, ["rev-parse", "--verify", "--quiet", `${skill.syncCommit}^{commit}`]);
    } catch {
      results.push({
        ...skill,
        status: "skipped",
        reason: `sync commit ${skill.syncCommit} not in local git history`,
        commits: [],
        changedPaths: [],
      });
      continue;
    }
    const log = git(root, ["log", "--oneline", `${skill.syncCommit}..${base}`, "--", ...skill.coveredPaths]);
    const commits = log ? log.split(/\r?\n/).filter(Boolean) : [];
    const changedPaths =
      commits.length === 0
        ? []
        : [
            ...new Set(
              git(root, [
                "log",
                "--name-only",
                "--pretty=format:",
                `${skill.syncCommit}..${base}`,
                "--",
                ...skill.coveredPaths,
              ])
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
            ),
          ].sort();
    results.push({
      ...skill,
      status: commits.length === 0 ? "in_sync" : "drifted",
      commits,
      changedPaths,
    });
  }
  return results;
}

export function parseArgs(argv) {
  const args = { root: defaultRoot, base: "HEAD", advisory: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--advisory") args.advisory = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--root" || flag === "--base") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${flag} needs a value`);
      args[flag.slice(2)] = value;
      i += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = checkFormalSync({ root: path.resolve(args.root), base: args.base });
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (results.length === 0) {
    console.log("formal-sync-check: no formal verification skills found");
  } else {
    for (const item of results) {
      if (item.status === "in_sync") {
        console.log(`pass  ${item.name} (${item.syncCommit}, ${item.coveredPaths.length} covered paths)`);
      } else if (item.status === "skipped") {
        console.log(`skip  ${item.name} (${item.reason})`);
      } else if (item.status === "error") {
        console.log(`FAIL  ${item.name}: ${item.reason}`);
      } else {
        console.log(
          `${args.advisory ? "warn" : "FAIL"}  ${item.name}: ${item.commits.length} commit(s) touched covered code since ${item.syncCommit}`,
        );
        if (item.changedPaths.length > 0) {
          console.log(`      paths: ${item.changedPaths.join(", ")}`);
        }
        for (const commit of item.commits.slice(0, 10)) {
          console.log(`      ${commit}`);
        }
        if (item.commits.length > 10) {
          console.log(`      ... and ${item.commits.length - 10} more`);
        }
      }
    }
  }
  const hasBad = results.some((r) => r.status === "error" || (!args.advisory && r.status === "drifted"));
  process.exit(hasBad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
