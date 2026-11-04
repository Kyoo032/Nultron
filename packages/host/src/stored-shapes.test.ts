import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Recorded = Record<string, { inputs: unknown[]; outputs: unknown[] }>;
type Schema = { parse: (value: unknown) => unknown };

const REPO = new URL("../../../", import.meta.url);
const recorded = JSON.parse(
  readFileSync(new URL("./__fixtures__/stored-shapes-zod3.json", import.meta.url), "utf8"),
) as Recorded;

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("records written under zod 3 read back the same", () => {
  it("covers the stored-data modules", () => {
    expect(Object.keys(recorded).length).toBeGreaterThan(100);
  });

  for (const [key, { inputs, outputs }] of Object.entries(recorded)) {
    it(key, async () => {
      const [path, name] = key.split("#") as [string, string];
      const schema = (await import(new URL(path, REPO).href))[name] as Schema;
      outputs.forEach((stored, index) => {
        expect(asJson(schema.parse(stored)), `stored ${index}`).toEqual(stored);
        expect(asJson(schema.parse(inputs[index])), `input ${index}`).toEqual(stored);
      });
    }, 120_000);
  }
});
