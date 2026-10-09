/**
 * The Edit agent's note when a turn's model call failed after a tool had already run.
 *
 * The host sends `run.interrupted` on the agent stream. The studio used to drop it, so a turn that
 * stopped after its edits ended with nothing on the panel to say why no answer came. This pins the
 * sentence in both locales, the panel that shows it, and the studio's loop that reads the frame.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { EditAgentPanel } from "@/components/edit-agent-panel";
import { editInterruptedNote } from "./edit-agent-note";
import { applyLocale, resetLocaleForTests } from "./i18n";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Line endings are Biome's business, not this test's: every source is read with LF. */
function source(relative: string): string {
  return readFileSync(join(web, relative), "utf8").replace(/\r\n/g, "\n");
}

const noop = () => {};

const PANEL = {
  project: null,
  cards: [],
  jobs: [],
  unplaced: [],
  spendCap: 2,
  emitLockActive: false,
  composerPrefill: "",
  onComposerPrefill: noop,
  onSend: noop,
  onKeep: noop,
  onUndo: noop,
  onTweak: noop,
  onCancel: noop,
  onPlanGo: noop,
  onReviewOk: noop,
  onPlace: noop,
  onDiscard: noop,
};

afterEach(() => {
  resetLocaleForTests();
});

describe("editInterruptedNote", () => {
  it("says the run stopped, keeps the edits, and gives the failure's own words", () => {
    applyLocale("en");
    const sentence = editInterruptedNote("The gateway is unavailable.");
    expect(sentence).toContain("The gateway is unavailable.");
    expect(sentence).toMatch(/stopped before it could finish/);
    expect(sentence).toMatch(/edits it already made are kept/);
    expect(sentence).not.toContain("{reason}");
  });

  it("says it in Bahasa Indonesia when the desk's language is Indonesian", () => {
    applyLocale("id");
    const sentence = editInterruptedNote("Gerbang tidak tersedia.");
    expect(sentence).toContain("Gerbang tidak tersedia.");
    expect(sentence).toMatch(/Alasan:/);
    expect(sentence).not.toMatch(/stopped/);
  });

  it("falls back to the generic agent failure when the reason is blank", () => {
    applyLocale("en");
    expect(editInterruptedNote("   ")).toContain("Agent failed");
  });
});

describe("EditAgentPanel note", () => {
  it("shows the note above the composer", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<EditAgentPanel {...PANEL} note="The run stopped." />);
    expect(html).toContain('data-testid="edit-agent-note"');
    expect(html).toContain("The run stopped.");
    expect(html.indexOf("edit-agent-note")).toBeLessThan(html.indexOf('data-testid="edit-composer"'));
  });

  it("renders no note element when there is none", () => {
    expect(renderToStaticMarkup(<EditAgentPanel {...PANEL} />)).not.toContain("edit-agent-note");
    expect(renderToStaticMarkup(<EditAgentPanel {...PANEL} note={null} />)).not.toContain("edit-agent-note");
  });
});

describe("where the studio reads the agent stream", () => {
  const studio = source("components/edit-studio.tsx");

  it("reads run.interrupted and hands its sentence to the panel", () => {
    expect(studio).toContain('if (event.type === "run.interrupted") {');
    expect(studio).toContain("setAgentNote(editInterruptedNote(");
    expect(studio).toContain("note={agentNote}");
  });

  it("clears the last note when a new turn starts", () => {
    const send = studio.slice(studio.indexOf("async function sendAgent"), studio.indexOf("async function onKeep"));
    expect(send).toContain("setAgentNote(null);");
  });
});
