/**
 * Tests for scripts/audit-deployed.mjs.
 *
 * Node's own test runner rather than vitest: this script is repo tooling and lives outside every
 * workspace package, so no package's vitest config would ever collect it. `node --test scripts/*.test.mjs`
 * runs it, and `pnpm ci:local` does exactly that.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atOrAbove, closureNames, DEPLOYED_FILTER, LIST_ARGS, partition } from "./audit-deployed.mjs";

/** The shape `pnpm list --depth Infinity --json` prints, trimmed to what the script reads. */
const list = [
  {
    name: "@agentforge/web",
    dependencies: {
      react: { version: "19.2.8" },
      ai: {
        version: "5.0.40",
        dependencies: { "@ai-sdk/provider-utils": { version: "3.0.12" } },
      },
      // tsx is the production entrypoint and a dependency since SR-113, so it ships.
      tsx: { version: "4.20.6", dependencies: { esbuild: { version: "0.24.2" } } },
    },
    devDependencies: {
      // tailwindcss builds the renderer and is not in the image. braces is how SR-113 reached the gate.
      tailwindcss: {
        version: "3.4.19",
        dependencies: { micromatch: { version: "4.0.8", dependencies: { braces: { version: "3.0.3" } } } },
      },
      vite: { version: "7.3.6", dependencies: { rollup: { version: "4.0.0" } } },
    },
  },
];

function advisory(module_name, severity) {
  return { module_name, severity, title: `${module_name} is unhappy`, patched_versions: ">=9" };
}

test("collects every shipped name, at any depth", () => {
  const names = closureNames(list);
  assert.ok(names.has("react"));
  assert.ok(names.has("@ai-sdk/provider-utils"), "a transitive dependency counts");
  assert.ok(names.has("tsx"), "the entrypoint ships");
  assert.ok(names.has("esbuild"), "and so does what it depends on");
  assert.equal(names.size, 5);
});

test("a dev dependency, and what only it pulls in, is not in the image", () => {
  const names = closureNames(list);
  for (const dev of ["tailwindcss", "micromatch", "braces", "vite", "rollup"]) {
    assert.ok(!names.has(dev), `${dev} reaches the gate only through a devDependency`);
  }
});

test("a package that is both a dev dependency and a shipped transitive one still counts", () => {
  const both = [
    {
      dependencies: { express: { version: "5.0.0", dependencies: { braces: { version: "3.0.3" } } } },
      devDependencies: { tailwindcss: { version: "3.4.19", dependencies: { braces: { version: "3.0.3" } } } },
    },
  ];
  assert.ok(closureNames(both).has("braces"));
});

test("optionalDependencies ship, at the root and below it", () => {
  const optional = [
    {
      dependencies: {
        "@firecrawl/anydoc": {
          version: "0.2.4",
          optionalDependencies: { "@firecrawl/anydoc-linux-x64-gnu": { version: "0.2.4" } },
        },
      },
      optionalDependencies: { fsevents: { version: "2.3.3" } },
    },
  ];
  const names = closureNames(optional);
  assert.ok(names.has("@firecrawl/anydoc-linux-x64-gnu"));
  assert.ok(names.has("fsevents"));
});

test("survives a node with no children and a root with no groups", () => {
  assert.equal(closureNames([{ name: "x" }]).size, 0);
  assert.equal(closureNames([]).size, 0);
});

test("does not loop forever on a cyclic tree", () => {
  const cycle = { version: "1.0.0" };
  cycle.dependencies = { a: cycle };
  assert.equal(closureNames([{ dependencies: { a: cycle } }]).size, 1);
});

test("splits advisories by whether the image carries the package", () => {
  const audit = {
    advisories: {
      1: advisory("esbuild", "moderate"),
      2: advisory("electron", "critical"),
      3: advisory("tar", "high"),
      4: advisory("react", "low"),
      5: advisory("braces", "high"),
    },
  };
  const { inImage, elsewhere } = partition(audit, closureNames(list));
  assert.deepEqual(
    inImage.map((a) => a.module_name),
    ["esbuild", "react"],
  );
  assert.deepEqual(
    elsewhere.map((a) => a.module_name),
    ["electron", "tar", "braces"],
    "sorted worst first, and braces (dev tooling only) is reported, not gating",
  );
});

test("an empty report is not an error", () => {
  const { inImage, elsewhere } = partition({}, closureNames(list));
  assert.deepEqual(inImage, []);
  assert.deepEqual(elsewhere, []);
});

test("the gate counts only what is at or above the level", () => {
  const found = [advisory("a", "critical"), advisory("b", "high"), advisory("c", "moderate"), advisory("d", "low")];
  assert.equal(atOrAbove(found, "high").length, 2);
  assert.equal(atOrAbove(found, "critical").length, 1);
  assert.equal(atOrAbove(found, "low").length, 4);
});

/**
 * The state of the repo today, and the reason the gate is set where it is: the 1 critical and 19
 * high the workspace-wide audit reports are all reachable only from `apps/desktop`. If a high ever
 * does land in the web closure this flips, which is the point.
 */
test("a high in the image blocks, and the same high outside it does not", () => {
  const audit = { advisories: { 1: advisory("tar", "high") } };
  const outside = partition(audit, closureNames(list));
  assert.equal(atOrAbove(outside.inImage, "high").length, 0);

  const withTar = closureNames([{ dependencies: { tar: { version: "6.2.0" } } }]);
  const inside = partition(audit, withTar);
  assert.equal(atOrAbove(inside.inImage, "high").length, 1);
});

/**
 * SR-113 in one test. braces 3.0.3 has a HIGH advisory with no patched release, and it is in the
 * install only under tailwindcss, a devDependency of apps/web. It must not fail the gate while it
 * is dev tooling, and it must the day it becomes something the image ships.
 */
test("braces under a dev dependency does not block, and braces under a shipped one does", () => {
  const audit = { advisories: { 1: advisory("braces", "high") } };

  const devOnly = partition(audit, closureNames(list));
  assert.equal(atOrAbove(devOnly.inImage, "high").length, 0);
  assert.equal(devOnly.elsewhere.length, 1, "still printed, so it stays visible");

  const shipped = [{ dependencies: { express: { version: "5.0.0", dependencies: { braces: { version: "3.0.3" } } } } }];
  assert.equal(atOrAbove(partition(audit, closureNames(shipped)).inImage, "high").length, 1);
});

/**
 * The gate and the image have to select the same packages. This is a source check on purpose: the
 * runtime image installs with `--prod` in its own stage and copies that tree, and the audit asks
 * pnpm for the same filter with the same flag. If somebody drops `--prod` from the Dockerfile the
 * image ships the dev toolchain again and this script would be auditing less than it deploys; if
 * they drop it here the gate goes red on tooling the image never carries.
 */
test("the audit selects the same packages as the Dockerfile's production install", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("../webapp-deploy/Dockerfile", import.meta.url)), "utf8");
  const install = dockerfile.match(/^RUN pnpm install ([^\n]*)$/gm) ?? [];
  const prod = install.filter((line) => line.includes("--prod"));
  assert.equal(prod.length, 1, "exactly one production install in the Dockerfile");
  assert.ok(prod[0].includes("--frozen-lockfile"), "and it is frozen to the lockfile");
  assert.ok(prod[0].includes(`--filter "${DEPLOYED_FILTER}"`), "with the filter the audit uses");
  assert.ok(LIST_ARGS.includes("--prod"), "the audit lists production dependencies only");
  assert.deepEqual(LIST_ARGS.slice(LIST_ARGS.indexOf("--filter"), LIST_ARGS.indexOf("--filter") + 2), [
    "--filter",
    DEPLOYED_FILTER,
  ]);
  assert.match(dockerfile, /^COPY --from=prod --chown=node:node \/app \/app$/m, "the runtime copies the prod tree");
  assert.doesNotMatch(
    dockerfile,
    /^COPY --from=build [^\n]*\/app \/app$/m,
    "the runtime does not copy the build tree back in",
  );
});

test("tsx, the production entrypoint, is a dependency and not a devDependency", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../apps/web/package.json", import.meta.url)), "utf8"));
  assert.ok(pkg.dependencies?.tsx, "apps/web must list tsx under dependencies");
  assert.equal(pkg.devDependencies?.tsx, undefined);
});
