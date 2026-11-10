/**
 * The tools a voice ask may use (plan W3, W5). Lane C owns this file.
 *
 * Chat's own set (`DEFAULT_CHAT_TOOLS`) mixes reads with writes, paid media and long work, and the
 * model reads its tool list at run time, so voice cannot filter after the fact: a tool is OFFERED only
 * when it is on `VOICE_READ_TOOLS`. Everything else is out by default, and a tool nobody classified is
 * out too. `ask-tools.test.ts` fails when `DEFAULT_CHAT_TOOLS` gains a key that is on neither list, so
 * whoever adds a Chat tool must decide here whether voice may run it.
 *
 * A request that needs a tool from the other list is not refused. The model gets `request_tap`, calls
 * it with one line, and the run stops: the person taps a card, and the tap sends a normal Chat turn
 * with every tool.
 */
import { z } from "zod";
import {
  DEFAULT_CHAT_TOOLS,
  GENERALIST_EXTRA_TOOLS,
  defineTool,
  registerTool,
  type ToolBindingRecord,
} from "@agentforge/core";
import { ensureToolsRegistered } from "../register-tools";

export const REQUEST_TAP_TOOL_KEY = "request_tap";

/**
 * Offered to a voice ask. A tool is here only if it cannot change the desk, spend on media, start long
 * work, or write anywhere the person did not ask. Reads only:
 *
 * - `knowledge_search`, `past_sessions`, `list_files`, `read_file`, `search_files`: the desk's own material.
 * - `calculator`, `datetime`, `self_check`: computed in process, change nothing.
 * - `web_search`, `web_fetch`: a read of the public web. They send the model's query or an address
 *   outward, so the voice run is wrapped in the same outbound guard a typed turn has (SR-112,
 *   `ask.ts`), which refuses a query built from private text. Drop them here to keep voice off the web.
 */
export const VOICE_READ_TOOLS: readonly string[] = Object.freeze([
  "calculator",
  "datetime",
  "knowledge_search",
  "past_sessions",
  "list_files",
  "read_file",
  "search_files",
  "self_check",
  "web_search",
  "web_fetch",
]);

/**
 * Not offered to a voice ask, and why. A request for any of these becomes a card (`request_tap`).
 *
 * - `write_file`, `edit_file`, `delete_file`: change the desk or the owner's folder.
 * - `image_generate`, `video_generate`: paid media (SR-167 asks the person first; a tap is that ask).
 * - `build_deck`: makes a file and a download, and takes long.
 * - `run_code`: runs a program that can write under `/workspace/out`, and starts slowly.
 * - The generalist's workers and `delegate` (`GENERALIST_EXTRA_TOOLS`): long runs that write files.
 */
export const VOICE_TAP_TOOLS: readonly string[] = Object.freeze([
  "write_file",
  "edit_file",
  "delete_file",
  "image_generate",
  "video_generate",
  "build_deck",
  "run_code",
  ...GENERALIST_EXTRA_TOOLS,
]);

const READ_SET: ReadonlySet<string> = new Set(VOICE_READ_TOOLS);

/** True when voice may run this tool itself. Anything unclassified is false. */
export function isVoiceReadTool(toolKey: string): boolean {
  return READ_SET.has(toolKey);
}

/** Chat's keys that neither list names. Empty while every Chat tool has been decided. */
export function unclassifiedChatTools(chatTools: readonly string[] = DEFAULT_CHAT_TOOLS): string[] {
  const decided = new Set<string>([...VOICE_READ_TOOLS, ...VOICE_TAP_TOOLS]);
  return chatTools.filter((key) => !decided.has(key));
}

/**
 * `request_tap`. It does nothing itself: `ask.ts` sees the call start, stops the run and turns it into a
 * card. If a run ever did execute it, the answer is a plain "noted" so the model stops.
 */
export const requestTapTool = defineTool({
  key: REQUEST_TAP_TOOL_KEY,
  name: "Ask for a tap",
  description:
    "The person asked for something that writes, sends, costs money or takes long (a deck, a document, an image, a video, research, a change to a file). Do not do it. Call this with one line saying what will start.",
  // Optional on purpose: a call with no summary must still stop the run and make a card (the person's own
  // words stand in), where a schema refusal would hand the model a second turn to answer instead.
  schema: z.object({
    summary: z.string().optional().describe("One line saying what will start if the person taps."),
  }),
  pack: "voice",
  execute: async () => ({ ok: true, note: "A card is on the person's screen. Stop here." }),
});

let registered = false;

/** Registers `request_tap` beside Chat's tools. Safe to call every ask. */
export function ensureVoiceToolsRegistered(): void {
  ensureToolsRegistered();
  if (!registered) {
    registerTool(requestTapTool);
    registered = true;
  }
}

/**
 * The bindings of a voice ask: the run's own, cut down to `VOICE_READ_TOOLS`, plus `request_tap`. The
 * cut is an allow-list, so a binding the agent holds that voice never heard of is dropped.
 */
export function voiceBindings(bindings: readonly ToolBindingRecord[]): ToolBindingRecord[] {
  const kept = bindings.filter((binding) => isVoiceReadTool(binding.toolKey));
  const template = bindings[0];
  return [
    ...kept,
    {
      id: "voice-request-tap",
      agentVersionId: template?.agentVersionId ?? "",
      organizationId: template?.organizationId ?? "",
      toolKey: REQUEST_TAP_TOOL_KEY,
      config: {},
      enabled: true,
    },
  ];
}
