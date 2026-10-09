import { defineTool, registerTool } from "@agentforge/core";
import { buildDeckForTenant } from "./build-deck";
import { buildDeckInputSchema, DECK_MAX_SLIDES } from "./deck-schema";

const BUILD_DECK_DESCRIPTION = [
  "Make a PowerPoint (.pptx) deck from an outline you write, and save it for the owner to download.",
  `You write every slide: a heading that states one claim, three to five short bullets, and what the presenter says in the notes. At most ${DECK_MAX_SLIDES} slides; a title slide is added from \`title\`.`,
  "Write the whole deck in the language of the conversation. Use only facts the owner gave you or that you looked up, and leave a figure out rather than guessing one.",
  "If the answer says a check failed or a limit was passed, fix exactly what it names and call build_deck again with the whole outline.",
  "When it answers ok, tell the owner the deck is ready and what it covers. The download button appears under your answer, so do not paste a link or the file name as a link.",
].join(" ");

/**
 * Chat's deck tool. `internal` trust: its answer is the host's own (an id, a file name, a count, or a
 * refusal written here), not text a page or a file wrote, so it is not scanned as untrusted output.
 */
export const buildDeckTool = defineTool({
  key: "build_deck",
  name: "Build a deck",
  description: BUILD_DECK_DESCRIPTION,
  schema: buildDeckInputSchema,
  trust: "internal",
  execute: (args, tenant) => buildDeckForTenant(args, tenant),
});

/** Registered next to the code tool by `ensureToolsRegistered`. */
export function registerDeckTools(): void {
  registerTool(buildDeckTool);
}
