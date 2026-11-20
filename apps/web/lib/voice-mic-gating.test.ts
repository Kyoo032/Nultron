/**
 * Live voice talks to the orchestrator only. The mic is offered by the chat session, so the rule is
 * pinned against the sources the way `agent-chat-pane.test.ts` does: the session defaults the flag
 * on and hands it to the hook as `allowed`, the hook folds it into `available`, and the two panes
 * that are not the orchestrator pass it off.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(web, path), "utf8").replace(/\r\n/g, "\n");

const session = read("components/chat-session.tsx");
const hook = read("components/voice/use-voice-session.ts");
const agentPane = read("components/agent-chat-pane.tsx");
const botPane = read("components/team-bot-chat-pane.tsx");

describe("the microphone is the orchestrator's alone", () => {
  it("defaults on in the session and hands it to the voice hook as `allowed`", () => {
    expect(session).toContain("voiceEnabled = true");
    expect(session).toContain("allowed: voiceEnabled");
  });

  it("lets the hook's availability fall when the pane is not allowed, even with voice on", () => {
    expect(hook).toContain("options.allowed === false");
    expect(hook).toContain("available && options.allowed !== false");
  });

  it("keeps the mic for the generalist and takes it from a hired specialist", () => {
    expect(agentPane).toContain("voiceEnabled={agent.generalist}");
  });

  it("takes the mic from a team bot's chat", () => {
    expect(botPane).toContain("voiceEnabled={false}");
  });
});
