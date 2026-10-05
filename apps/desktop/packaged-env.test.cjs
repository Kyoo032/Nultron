const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// main.cjs needs Electron, so what the packaged bootstrap does to the environment is pinned from the
// source text, the way lifecycle.test.cjs pins its boot order.
//
// The rule being held: a packaged build ignores every dev/test endpoint hook
// (AGENTFORGE_GATEWAY_URL, AGENTFORGE_TELEGRAM_API_URL) because `AGENTFORGE_PACKAGED` is "1" when
// host.cjs loads (`packages/core/src/gateway/pinned.ts`), and a brand flavor still gets its own
// gateway through AGENTFORGE_BRAND_GATEWAY_URL, which main.cjs assigns itself. Before this test,
// nothing set AGENTFORGE_PACKAGED, so the "ignored when packaged" rule never applied.

const MAIN = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

/** Drop block and whole-line comments so a sentence that mentions an assignment is not mistaken for one. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function functionBody(source, header, nextHeader) {
  const start = source.indexOf(header);
  assert.ok(start > 0, `found ${header} in main.cjs`);
  const end = source.indexOf(nextHeader, start);
  assert.ok(end > start, `found ${nextHeader} after ${header}`);
  return source.slice(start, end);
}

const code = stripComments(MAIN);
const bootstrap = functionBody(code, "async function bootstrapPackaged()", "async function recordEditFfmpeg");
const hostRequire = bootstrap.indexOf('require("./host.cjs")');
assert.ok(hostRequire > 0, "bootstrapPackaged still loads host.cjs");

// ---------- the packaged marker ----------

const packagedAssignments = code.match(/process\.env\.AGENTFORGE_PACKAGED\s*=(?!=)/g) ?? [];
assert.equal(packagedAssignments.length, 1, "AGENTFORGE_PACKAGED is assigned in exactly one place in main.cjs");
const packagedAt = bootstrap.search(/process\.env\.AGENTFORGE_PACKAGED\s*=\s*"1"\s*;/);
assert.ok(packagedAt >= 0, 'bootstrapPackaged sets AGENTFORGE_PACKAGED to "1"');
assert.ok(packagedAt < hostRequire, "AGENTFORGE_PACKAGED is set before host.cjs loads");

// ---------- the dev hook is never handed to the host ----------

assert.equal(
  /process\.env\.AGENTFORGE_GATEWAY_URL\s*=(?!=)/.test(code),
  false,
  "main.cjs never assigns the dev hook AGENTFORGE_GATEWAY_URL (it used to copy brand.json into it)",
);
const dropDevHook = bootstrap.search(/delete\s+process\.env\.AGENTFORGE_GATEWAY_URL\s*;/);
assert.ok(dropDevHook >= 0, "bootstrapPackaged clears any AGENTFORGE_GATEWAY_URL the user's environment carried");
assert.ok(dropDevHook < hostRequire, "and does so before host.cjs loads");

// ---------- the brand flavor keeps its gateway, through its own channel ----------

const brandAssign = bootstrap.search(/process\.env\.AGENTFORGE_BRAND_GATEWAY_URL\s*=\s*brandGateway\s*;/);
assert.ok(brandAssign >= 0, "bootstrapPackaged hands a flavor's gateway over as AGENTFORGE_BRAND_GATEWAY_URL");
assert.ok(brandAssign < hostRequire, "AGENTFORGE_BRAND_GATEWAY_URL is set before host.cjs loads");
assert.ok(
  /const\s+brandGateway\s*=\s*brandGatewayOverride\(brand\)\s*;/.test(bootstrap),
  "the value comes from brandGatewayOverride(brand), which is empty for the public build",
);
assert.ok(
  /delete\s+process\.env\.AGENTFORGE_BRAND_GATEWAY_URL\s*;/.test(bootstrap),
  "with no flavor gateway, an inherited AGENTFORGE_BRAND_GATEWAY_URL is deleted rather than trusted",
);
assert.equal(
  (code.match(/process\.env\.AGENTFORGE_BRAND_GATEWAY_URL\s*=(?!=)/g) ?? []).length,
  1,
  "AGENTFORGE_BRAND_GATEWAY_URL is assigned in exactly one place",
);

// ---------- webdev (unpackaged) never gets the marker ----------

const dev = functionBody(code, "async function bootstrapDev()", "function applyProductPaths");
assert.equal(/AGENTFORGE_PACKAGED/.test(dev), false, "bootstrapDev does not mark the process as packaged");

console.log("packaged-env.test.cjs: ok");
