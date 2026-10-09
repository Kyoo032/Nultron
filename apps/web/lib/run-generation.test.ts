import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startRun } from "@/lib/run-generation";

/**
 * Chat now frees Send when the host says `run.completed`, before the stream closes. A second turn can
 * start in that gap, and the first turn's tail (`finish`, `finally { setBusy(false) }`) must then do
 * nothing: it would clear the second turn's live reply and re-enable Send in the middle of it.
 */
describe("startRun", () => {
  it("is current until a newer run starts", () => {
    const generation = { current: 0 };
    const first = startRun(generation);
    expect(first()).toBe(true);
    const second = startRun(generation);
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("lets only the newest run reset shared state, whatever order the tails run in", () => {
    const generation = { current: 0 };
    const state = { busy: false, streaming: "" };
    const tail = (isCurrent: () => boolean) => {
      if (isCurrent()) {
        state.busy = false;
        state.streaming = "";
      }
    };
    const first = startRun(generation);
    state.busy = true;
    // Turn 1 completed and freed Send; the person sends turn 2 before turn 1's stream closed.
    state.busy = false;
    const second = startRun(generation);
    state.busy = true;
    state.streaming = "turn 2 so far";
    tail(first);
    expect(state).toEqual({ busy: true, streaming: "turn 2 so far" });
    tail(second);
    expect(state).toEqual({ busy: false, streaming: "" });
  });
});

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const composer = readFileSync(join(web, "components/chat-composer.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("chat composer run generations", () => {
  it("numbers every send", () => {
    expect(composer).toContain("const isCurrentRun = startRun(runGenerationRef);");
  });

  it("lets a stale run neither complete the pane nor free Send", () => {
    expect(composer).toContain("const finish = async () => {\n      if (!isCurrentRun()) {");
    expect(composer).toContain(
      "if (!isCurrentRun()) {\n          return;\n        }\n        setBusy(false);\n        onSettled?.();",
    );
    expect(composer).toContain("if (showing() && isCurrentRun()) {\n        setBusy(false);");
  });
});
