/**
 * The character and a live chat turn.
 *
 * In the chat-first shell (tester code) no character is drawn inside a thread at all: the owner's
 * rule of 2026-10-09 is that the character must not overlap generated content, so the head in the
 * rail is the status character and the turn only tells it what the reply is doing.
 *
 * The published layout still draws a decorative mascot beside the live turn. That code is unchanged
 * here, so its promise (hidden from a screen reader, which already hears "Thinking" from the
 * disclosure) is held by reading the source: with `SHELL_LAYOUT` at `chat-first` it does not render.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SHELL_LAYOUT } from "@agentforge/core/product-modes";
import { ChatTurn } from "@/components/chat-turn";

const live = { thinking: "", tools: [], streaming: "", running: true };
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "components", "chat-turn.tsx"),
  "utf8",
);

describe("the character and a live chat turn", () => {
  it("is the chat-first shell here", () => {
    expect(SHELL_LAYOUT).toBe("chat-first");
  });

  it("draws no character inside the thread while the turn runs", () => {
    const html = renderToStaticMarkup(<ChatTurn role="assistant" live={live} />);
    expect(html).not.toContain('data-testid="chat-mascot"');
    expect(html).not.toContain("nx-root");
    // The turn itself is still there: the Thinking disclosure says what it is doing.
    expect(html).toContain('data-testid="message-thinking"');
  });

  it("draws none when the turn failed or is streaming text either", () => {
    for (const state of [
      { ...live, running: false, failed: true },
      { ...live, streaming: "Half an answer" },
    ]) {
      const html = renderToStaticMarkup(<ChatTurn role="assistant" live={state} />);
      expect(html).not.toContain('data-testid="chat-mascot"');
    }
  });

  it("keeps the published layout's inline mascot decorative, behind the shell switch", () => {
    expect(source).toMatch(/live && liveState && !takesStatus && SHELL_LAYOUT !== "chat-first" \?/);
    expect(source).toMatch(/<NultronMascot state=\{liveState\}[^>]*\bdecorative\b/);
  });
});
