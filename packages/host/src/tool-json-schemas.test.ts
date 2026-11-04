import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { listTools } from "@agentforge/core";
import { describe, expect, it } from "vitest";
import { ensureToolsRegistered } from "./register-tools";

const GOLDEN_URL = new URL("./__fixtures__/tool-json-schemas.json", import.meta.url);
const RECORD = process.env.RECORD_TOOL_SCHEMAS === "1";

type AsSchema = (schema: unknown) => { jsonSchema: unknown | PromiseLike<unknown> };

async function sdkAsSchema(): Promise<AsSchema> {
  const fromCore = createRequire(new URL("../../core/package.json", import.meta.url));
  return ((await import(pathToFileURL(fromCore.resolve("ai")).href)) as { asSchema: AsSchema }).asSchema;
}

async function currentSchemas(): Promise<Record<string, unknown>> {
  ensureToolsRegistered();
  const asSchema = await sdkAsSchema();
  const out: Record<string, unknown> = {};
  for (const tool of [...listTools()].sort((a, b) => a.key.localeCompare(b.key))) {
    out[tool.key] = JSON.parse(JSON.stringify(await asSchema(tool.schema).jsonSchema));
  }
  return out;
}

describe("the JSON schema the model is sent for every registered tool", () => {
  it("is the recorded one", async () => {
    const current = await currentSchemas();
    if (RECORD) {
      writeFileSync(GOLDEN_URL, `${JSON.stringify(current, null, 1)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as Record<string, unknown>;
    expect(Object.keys(current)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) {
      expect(current[key], key).toEqual(golden[key]);
    }
  }, 120_000);
});
