import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The renderer runs in a browser, so nothing the Vite dev server serves it may import a Node
 * builtin. `@agentforge/core`'s barrel (`src/index.ts`) re-exports `crypto/envelope.ts`, which
 * imports `node:crypto`; one `import { x } from "@agentforge/core"` in a component made the dev
 * server throw `Module "crypto" has been externalized for browser compatibility` and the whole app
 * mounted nothing. Unit tests and the production build do not see it: only a browser loading the
 * dev bundle does.
 *
 * So this walks the real import graph the way the bundler does: from the renderer entry through
 * relative imports, the `@/` alias and the `exports` map of every `@agentforge/*` workspace package,
 * following value imports only (a type-only import is erased and costs the bundle nothing). Any
 * Node builtin it reaches is a failure, reported with the chain that reaches it. The fix for a red
 * is a browser-safe subpath export in `packages/core/package.json`, the way `./images`,
 * `./documents` and `./slide-design` are, never the bare barrel.
 */
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");
const RENDERER_ENTRY = path.join(WEB_ROOT, "src", "main.tsx");

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const NODE_BUILTINS = new Set(builtinModules);

type Resolution = { kind: "node" } | { kind: "file"; file: string } | { kind: "skip" };

type Offender = { file: string; specifier: string; chain: string[] };

type Walk = { reached: Set<string>; offenders: Offender[] };

function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.includes(path.extname(file));
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

/** A relative path or alias target to a source file, an asset to skip, or a loud failure. */
function resolveFile(base: string, specifier: string, from: string): Resolution {
  if (isFile(base)) {
    return isCodeFile(base) ? { kind: "file", file: base } : { kind: "skip" };
  }
  const withoutJs = base.replace(/\.(m?)js$/, "");
  const candidates = [
    ...CODE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...CODE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
    ...(withoutJs === base ? [] : [`${withoutJs}.ts`, `${withoutJs}.tsx`]),
  ];
  const found = candidates.find(isFile);
  if (!found) {
    throw new Error(`renderer-bundle-safety: cannot resolve "${specifier}" from ${path.relative(REPO_ROOT, from)}`);
  }
  return { kind: "file", file: found };
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    return exportTarget(conditions.import ?? conditions.default);
  }
  return undefined;
}

function resolveWorkspace(pkg: string, subpath: string, specifier: string, from: string): Resolution {
  const packageDir = path.join(REPO_ROOT, "packages", pkg);
  const manifestPath = path.join(packageDir, "package.json");
  if (!isFile(manifestPath)) {
    return { kind: "skip" };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> };
  const target = exportTarget(manifest.exports?.[subpath]);
  if (!target) {
    throw new Error(
      `renderer-bundle-safety: "${specifier}" (from ${path.relative(REPO_ROOT, from)}) is not an export of @agentforge/${pkg}`,
    );
  }
  return resolveFile(path.join(packageDir, target), specifier, from);
}

function resolveSpecifier(specifier: string, from: string): Resolution {
  const bare = specifier.split("?")[0];
  if (bare.startsWith("node:") || NODE_BUILTINS.has(bare)) {
    return { kind: "node" };
  }
  if (bare.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(from), bare), specifier, from);
  }
  if (bare.startsWith("@/")) {
    return resolveFile(path.join(WEB_ROOT, bare.slice(2)), specifier, from);
  }
  const workspace = /^@agentforge\/([^/]+)(\/.+)?$/.exec(bare);
  if (workspace) {
    return resolveWorkspace(workspace[1], workspace[2] ? `.${workspace[2]}` : ".", specifier, from);
  }
  return { kind: "skip" };
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const named = clause.namedBindings;
  return (
    !clause.name &&
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  const named = node.exportClause;
  return (
    node.isTypeOnly ||
    (named !== undefined &&
      ts.isNamedExports(named) &&
      named.elements.length > 0 &&
      named.elements.every((element) => element.isTypeOnly))
  );
}

/** Every module this file pulls in at runtime. A type-only import is erased, so it is not one. */
function valueSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, false, kind);
  const found: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !isTypeOnlyExport(node)
    ) {
      found.push(node.moduleSpecifier.text);
    }
  }
  // A dynamic `import("x")` can sit anywhere, so only files that contain one are walked in full.
  if (/\bimport\s*\(/.test(text)) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        found.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function displayPath(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function chainTo(file: string, parents: Map<string, string | null>): string[] {
  const chain: string[] = [];
  for (let cursor: string | null | undefined = file; cursor; cursor = parents.get(cursor)) {
    chain.unshift(displayPath(cursor));
  }
  return chain;
}

function walkRendererGraph(entry: string): Walk {
  const parents = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const offenders: Offender[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const specifier of valueSpecifiers(file)) {
      const resolution = resolveSpecifier(specifier, file);
      if (resolution.kind === "node") {
        offenders.push({ file: displayPath(file), specifier, chain: chainTo(file, parents) });
      } else if (resolution.kind === "file" && !parents.has(resolution.file)) {
        parents.set(resolution.file, file);
        queue.push(resolution.file);
      }
    }
  }
  return { reached: new Set([...parents.keys()].map(displayPath)), offenders };
}

function describeOffenders(offenders: Offender[]): string[] {
  return offenders.map((o) => `${o.file} imports "${o.specifier}" (reached via ${o.chain.join(" -> ")})`);
}

describe("renderer bundle stays free of Node builtins", () => {
  // One walk of the real renderer graph, shared: it parses a few hundred files (about 5 s on a
  // cold Windows run), so the test that pays for it carries its own budget.
  const WALK_BUDGET_MS = 60_000;
  let rendererWalk: Walk | undefined;
  const realWalk = (): Walk => {
    rendererWalk ??= walkRendererGraph(RENDERER_ENTRY);
    return rendererWalk;
  };

  it("reaches no Node builtin from the renderer entry", () => {
    expect(describeOffenders(realWalk().offenders)).toEqual([]);
  }, WALK_BUDGET_MS);

  it("really crosses into the workspace packages, so a clean walk is not an empty one", () => {
    const { reached } = realWalk();
    expect(reached.size).toBeGreaterThan(50);
    expect(reached).toContain("apps/web/src/App.tsx");
    expect(reached).toContain("packages/core/src/presentation/slide-design.ts");
  }, WALK_BUDGET_MS);

  it("keeps the presentation components on the slide-design subpath, not the core barrel", () => {
    for (const component of ["open-slide-stage.tsx", "presentation-preview.tsx"]) {
      const specifiers = valueSpecifiers(path.join(WEB_ROOT, "components", component));
      expect(specifiers, component).toContain("@agentforge/core/slide-design");
      expect(specifiers, component).not.toContain("@agentforge/core");
    }
  });
});

describe("the walker itself (fixtures, so the guard cannot go vacuous)", () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "renderer-bundle-safety-"));
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  function fixture(files: Record<string, string>): string {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(fixtureDir, name)), { recursive: true });
      writeFileSync(path.join(fixtureDir, name), text);
    }
    return path.join(fixtureDir, "entry.ts");
  }

  it("flags a Node builtin reached through a relative import, with the chain", () => {
    const entry = fixture({
      "entry.ts": 'import { mid } from "./nested/mid";\nexport const x = mid;',
      "nested/mid.ts": 'import { createCipheriv } from "node:crypto";\nexport const mid = createCipheriv;',
    });
    const { offenders } = walkRendererGraph(entry);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].specifier).toBe("node:crypto");
    expect(offenders[0].chain).toHaveLength(2);
  });

  it("flags a bare builtin name and a dynamic import, but not an unrelated package", () => {
    const entry = fixture({
      "entry.ts": 'import path from "path";\nimport react from "react";\nexport const load = () => import("node:os");',
    });
    const { offenders } = walkRendererGraph(entry);
    expect(offenders.map((o) => o.specifier).sort()).toEqual(["node:os", "path"]);
  });

  it("ignores type-only imports and exports, which the bundler erases", () => {
    const entry = fixture({
      "entry.ts": [
        'import type { Cipher } from "node:crypto";',
        'import { type Hash } from "node:crypto";',
        'export type { Hmac } from "node:crypto";',
        "export type Both = Cipher | Hash;",
      ].join("\n"),
    });
    expect(walkRendererGraph(entry).offenders).toEqual([]);
  });

  it("still flags a mixed import that carries a value", () => {
    const entry = fixture({ "entry.ts": 'import { type Hash, createHash } from "node:crypto";\nexport { createHash };' });
    expect(walkRendererGraph(entry).offenders).toHaveLength(1);
  });

  it("follows a workspace subpath through the package exports map", () => {
    const entry = fixture({ "entry.ts": 'import { assignSlideLayout } from "@agentforge/core/slide-design";\nexport { assignSlideLayout };' });
    const { reached, offenders } = walkRendererGraph(entry);
    expect(offenders).toEqual([]);
    expect(reached).toContain("packages/core/src/presentation/slide-design.ts");
  });

  it("refuses a workspace subpath the package does not export, instead of skipping it", () => {
    const entry = fixture({ "entry.ts": 'import { nope } from "@agentforge/core/not-a-real-subpath";\nexport { nope };' });
    expect(() => walkRendererGraph(entry)).toThrow(/not an export of @agentforge\/core/);
  });
});
