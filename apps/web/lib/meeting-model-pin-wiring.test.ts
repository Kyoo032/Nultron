/**
 * Meeting sends `modelPinned` only for a model the person chose.
 *
 * Every other job studio does (`studio-model-wiring.test.ts`); Meeting used to send a bare `model`,
 * so the host could not tell a pick from the seeded default and the pick was swappable by the job model
 * fallback. The studio is a component with no DOM to drive in this node environment, so its wiring to
 * the decision in `model-choice.ts` is pinned by reading the source. The request itself is covered on
 * the host (`packages/host/src/handlers/meetings-model-pin.test.ts`).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modelPickBody, studioModelPick } from "./model-choice";

const studio = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../components/meeting-studio.tsx"),
  "utf8",
);

describe("the Meeting studio and the model it sends", () => {
  it("reads the pin from useJobModel", () => {
    expect(studio).toContain('const { models, model, pinned: modelPinned, setModel } = useJobModel("meeting");');
  });

  it("sends the pick through modelPickBody on both stream routes' one request", () => {
    expect(studio).toContain("...modelPickBody(studioModelPick(model, modelPinned))");
    // A bare `model` is the path that let the fallback swap a pick.
    expect(studio).not.toMatch(/job\.run\([^)]*\{\s*model,/);
    expect(studio).not.toContain("model: model || undefined");
  });

  it("translates in the run only when the owner chose to, and passes the prompt only when there is one", () => {
    // Translation is opt-in (doc-flow plan 7a.2): never a hard-coded `translate: true`.
    expect(studio).toMatch(
      /\.\.\.modelPickBody\(studioModelPick\(model, modelPinned\)\),\s*translate: alwaysTranslate,\s*\.\.\.\(request \? \{ prompt: request \} : \{\}\)/,
    );
    expect(studio).not.toContain("translate: true");
  });

  it("sends the pick on the translate route too, so a translation is held to the same model", () => {
    expect(studio).toMatch(/translate\/stream`,\s*modelPickBody\(studioModelPick\(model, modelPinned\)\)/);
  });
});

describe("what the request body carries", () => {
  it("pins a picked model", () => {
    expect(modelPickBody(studioModelPick("gpt-5.6-sol", true))).toEqual({ model: "gpt-5.6-sol", modelPinned: true });
  });

  it("sends the seeded default without the pin, so it stays rescuable", () => {
    expect(modelPickBody(studioModelPick("deepseek-v4-flash", false))).toEqual({ model: "deepseek-v4-flash" });
  });
});
