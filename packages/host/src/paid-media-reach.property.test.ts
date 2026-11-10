import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPaidMediaTool, mediaRequestArgs } from "@agentforge/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PAID_MEDIA_GRANTS_MAX, readMediaPermission } from "./paid-media-body";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Entry = {
  readonly how: "gated" | "tools stripped" | "tools bounded by the mode spec" | "no gate: the Edit agent's own tools";
  readonly why: string;
};

const RUN_ENTRIES: Readonly<Record<string, Entry>> = {
  "packages/host/src/runs.ts": {
    how: "gated",
    why: "Chat and every mode agent. Passes the turn's `mediaPermission`, read from the body by `readMediaPermission`, which always asks.",
  },
  "packages/host/src/voice/ask.ts": {
    how: "gated",
    why: "The voice thinker. Passes the `mediaPermission` of its own Chat turn setup (`prepareChatRun`, a body with no grants, so the gate always asks). Its bindings (`voiceBindings` in `voice/ask-tools.ts`) are an allow-list of read tools plus `request_tap`; it holds neither `image_generate` nor `video_generate`.",
  },
  "packages/host/src/delegation/run-delegation.ts": {
    how: "tools stripped",
    why: "A delegated run binds `delegateToolKeys(agent)`, which drops `image_generate` and `video_generate` (checked for every agent in core).",
  },
  "packages/host/src/job-regen.ts": {
    how: "tools bounded by the mode spec",
    why: "A studio or worker job binds only what its mode's harness spec lists, through `toolKeysWithinSpec`; no spec but Chat's lists a paid tool (checked in core).",
  },
  "packages/host/src/edit/agent-run.ts": {
    how: "no gate: the Edit agent's own tools",
    why: "The Edit agent makes media with its own `generate_image` and `generate_video`, not the gated tools. Named residual of SR-167.",
  },
};

const TOOL_OBJECT_USERS: Readonly<Record<string, string>> = {
  "packages/core/src/tools/platform/register.ts":
    "Registers the tools so a run can bind them. A model's call to either goes through invokeToolGuarded, with the run's gate.",
  "packages/host/src/studio-generate.ts": "The Images and Videos studios call the tool directly: Generate is the person's own click.",
};

const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "build", ".turbo", ".ci-local", "coverage", "out", ".git"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        found.push(...sourceFiles(join(dir, entry.name)));
      }
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function allSource(): string[] {
  const roots = ["packages", "apps"].flatMap((top) =>
    readdirSync(join(repoRoot, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, top, entry.name)),
  );
  return roots.flatMap(sourceFiles);
}

const rel = (file: string) => relative(repoRoot, file).split(sep).join("/");

type CallSite = { readonly file: string; readonly line: number; readonly passesPermission: boolean };

function runCallSites(file: string, text: string): CallSite[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: CallSite[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "execute" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const names = new Set(
        node.arguments[0].properties.flatMap((property) =>
          property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [property.name.text] : [],
        ),
      );
      if (names.has("bindings")) {
        sites.push({
          file: rel(file),
          line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          passesPermission: names.has("mediaPermission"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
}

type GateBuilder = { readonly file: string; readonly line: number; readonly owner: string; readonly inLoop: boolean };

function gateBuilders(file: string, text: string): GateBuilder[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: GateBuilder[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createMediaPermission") {
      let owner = "<module>";
      let inLoop = false;
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isForStatement(up) || ts.isWhileStatement(up) || ts.isDoStatement(up) || ts.isForOfStatement(up) || ts.isForInStatement(up)) {
          inLoop = true;
        }
        if (ts.isMethodDeclaration(up) || ts.isFunctionDeclaration(up)) {
          owner = up.name && ts.isIdentifier(up.name) ? up.name.text : "<anonymous>";
          break;
        }
        if (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) {
          owner = "<closure>";
          break;
        }
      }
      found.push({ file: rel(file), line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, owner, inLoop });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function usesGeneratorTool(file: string, text: string): boolean {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let used = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && (node.text === "imageGenerateTool" || node.text === "videoGenerateTool")) {
      const parent = node.parent;
      const isImportOrExport = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
      const isDefinition = ts.isVariableDeclaration(parent) && parent.name === node;
      if (!isImportOrExport && !isDefinition) {
        used = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return used;
}

const scanned = (() => {
  const sites: CallSite[] = [];
  const direct: string[] = [];
  const builders: GateBuilder[] = [];
  const texts = new Map<string, string>();
  for (const file of allSource()) {
    const text = readFileSync(file, "utf8");
    if (text.includes(".execute(") && text.includes("bindings")) {
      sites.push(...runCallSites(file, text));
    }
    if (text.includes("createMediaPermission(")) {
      builders.push(...gateBuilders(file, text));
    }
    if (/imageGenerateTool|videoGenerateTool/.test(text) && usesGeneratorTool(file, text)) {
      direct.push(rel(file));
    }
    texts.set(rel(file), text);
  }
  return { sites, direct, builders, texts };
})();

describe("every way into a model-driven run is accounted for", () => {
  it("lists exactly the files that start a run with tools bound", () => {
    const found = [...new Set(scanned.sites.map((site) => site.file))].sort();
    const unlisted = found.filter((file) => !(file in RUN_ENTRIES));
    const gone = Object.keys(RUN_ENTRIES).filter((file) => !found.includes(file));
    expect(
      { unlisted, gone },
      `A run entry changed. For each file in "unlisted", decide how it keeps image_generate and video_generate behind Run (pass mediaPermission, bind no paid tool, or write down why not) and add it to RUN_ENTRIES with that reason. A file in "gone" no longer starts a run: remove it.`,
    ).toEqual({ unlisted: [], gone: [] });
  });

  it("passes the turn's permission at every call that says it is gated", () => {
    for (const [file, entry] of Object.entries(RUN_ENTRIES)) {
      if (entry.how !== "gated") {
        continue;
      }
      const sites = scanned.sites.filter((site) => site.file === file);
      expect(sites.length, `${file} has no run call to check`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(site.passesPermission, `${site.file}:${site.line} starts a run with tools bound and no mediaPermission`).toBe(true);
      }
    }
  });

  it("binds a delegated run through delegateToolKeys and a job through toolKeysWithinSpec", () => {
    expect(scanned.texts.get("packages/host/src/delegation/run-delegation.ts")).toContain("delegateToolKeys(");
    expect(scanned.texts.get("packages/host/src/job-regen.ts")).toContain("toolKeysWithinSpec(");
  });

  it("lists exactly the files that use a generator tool object", () => {
    const found = [...scanned.direct].sort();
    expect(
      found,
      "A file uses imageGenerateTool or videoGenerateTool itself. If a model can reach that code, it spends money with no Run press. Add the file to TOOL_OBJECT_USERS only if the person's own click starts it, or it only registers the tool.",
    ).toEqual(Object.keys(TOOL_OBJECT_USERS).sort());
  });
});

describe("one gate per run", () => {
  it("is built once, in the runtime's stream method, outside any loop or closure", () => {
    expect(
      scanned.builders.map(({ file, owner, inLoop }) => ({ file, owner, inLoop })),
      "createMediaPermission must be called exactly once, directly in AiSdkRuntime.stream. A gate built per attempt hands the same grant out again on every retry; a second builder is a second place that decides what may start.",
    ).toEqual([{ file: "packages/core/src/runtime/ai-sdk-runtime.ts", owner: "stream", inLoop: false }]);
  });
});

const VALID_GRANT = { tool: "image_generate", args: { prompt: "a red fox" } };
const GRANT_LISTS: readonly unknown[] = [
  undefined,
  null,
  "yes",
  [],
  [VALID_GRANT],
  Array.from({ length: PAID_MEDIA_GRANTS_MAX * 4 }, () => VALID_GRANT),
  [{ tool: "web_search", args: { prompt: "x" } }],
  [{ tool: "image_generate" }],
  [{ tool: "image_generate", args: { prompt: "" } }],
  [{ tool: "image_generate", args: { prompt: "p", model: "default", image_url: "https://example.com/", extra: 1 } }],
  [{ tool: "__proto__", args: { prompt: "p" } }],
  [null, 1, "x", [], {}],
];
const PAID_MEDIA_VALUES: readonly unknown[] = [
  undefined,
  null,
  "yes",
  [],
  {},
  { ask: false },
  { ask: false, grants: [VALID_GRANT] },
  { policy: { ask: false } },
  ...GRANT_LISTS.map((grants) => ({ grants })),
  ...GRANT_LISTS.map((grants) => ({ ask: false, grants })),
  JSON.parse('{"__proto__":{"ask":false},"grants":[]}'),
];
const HOSTILE_BODIES: readonly unknown[] = [
  undefined,
  null,
  7,
  "paidMedia",
  [],
  { ask: false },
  JSON.parse('{"__proto__":{"ask":false}}'),
  ...PAID_MEDIA_VALUES.map((paidMedia) => ({ content: "hi", tier: "daily", paidMedia })),
];

describe("the request body cannot weaken the gate", () => {
  it(`always asks, holds at most ${PAID_MEDIA_GRANTS_MAX} grants, and keeps only grants a card could have shown`, () => {
    expect(HOSTILE_BODIES.length).toBeGreaterThan(30);
    for (const body of HOSTILE_BODIES) {
      const policy = readMediaPermission(body);
      const label = JSON.stringify(body)?.slice(0, 120);
      expect(Object.keys(policy).sort(), label).toEqual(["ask", "grants"]);
      expect(policy.ask, label).toBe(true);
      expect(policy.grants.length, label).toBeLessThanOrEqual(PAID_MEDIA_GRANTS_MAX);
      for (const grant of policy.grants) {
        expect(isPaidMediaTool(grant.tool), label).toBe(true);
        expect(typeof grant.args.prompt, label).toBe("string");
        expect(grant.args, label).toEqual(mediaRequestArgs(grant.tool, grant.args));
      }
    }
  });
});

describe("the check can fail", () => {
  it("sees a gate built inside a closure or a loop", () => {
    const inClosure = `class R { stream() { const go = () => createMediaPermission(p); go(); } }`;
    const inLoop = `class R { stream() { for (;;) { const g = createMediaPermission(p); } } }`;
    const once = `class R { stream() { const g = createMediaPermission(p); } }`;
    expect(gateBuilders("fake.ts", inClosure)[0]?.owner).toBe("<closure>");
    expect(gateBuilders("fake.ts", inLoop)[0]?.inLoop).toBe(true);
    expect(gateBuilders("fake.ts", once)).toEqual([expect.objectContaining({ owner: "stream", inLoop: false })]);
  });

  it("sees a run call that forgets the permission", () => {
    const bad = `await runtime.execute({ tenant, bindings, history, onEvent });`;
    const sites = runCallSites("fake.ts", bad);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.passesPermission).toBe(false);
  });

  it("does not count a comment or a string as the permission", () => {
    const sneaky = `// mediaPermission\nawait runtime.execute({ tenant, bindings, note: "mediaPermission" });`;
    expect(runCallSites("fake.ts", sneaky)[0]?.passesPermission).toBe(false);
  });

  it("sees a run call that passes it, whatever the receiver is", () => {
    const good = `await createRuntime(settings, models).execute({ bindings, mediaPermission, history });`;
    expect(runCallSites("fake.ts", good)[0]?.passesPermission).toBe(true);
  });

  it("sees a direct use of a generator tool and ignores its import and definition", () => {
    expect(usesGeneratorTool("fake.ts", `import { imageGenerateTool } from "x"; imageGenerateTool.execute(a, b);`)).toBe(true);
    expect(usesGeneratorTool("fake.ts", `import { imageGenerateTool } from "x"; export { imageGenerateTool };`)).toBe(false);
    expect(usesGeneratorTool("fake.ts", `export const videoGenerateTool = defineTool({});`)).toBe(false);
  });
});
