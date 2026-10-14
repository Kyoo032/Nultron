/**
 * Continue shows only on a turn the host marked with a `step_limit` part.
 * A turn that merely contains the step-limit sentence, and an interrupted turn, do not get it.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurn, messageHasDisplayableContent } from "@/components/chat-turn";
import { CONTINUE_PROMPT, stepLimitToolsOf } from "@/lib/chat-continue";
import { applyLocale, resetLocaleForTests } from "@/lib/i18n";

const sentence =
  "list_files finished, but the answer didn't. Ask me to continue and I will pick up from where I stopped.";

const marked = [
  { type: "tool_call", toolKey: "list_files", status: "completed" },
  { type: "text", text: sentence },
  { type: "step_limit", tools: ["list_files"] },
];

afterEach(() => {
  resetLocaleForTests();
});

describe("Continue on a step-limit turn", () => {
  it("shows the control only when the host marked the turn", () => {
    applyLocale("en");
    const onContinue = () => undefined;
    const withMark = renderToStaticMarkup(<ChatTurn role="assistant" content={marked} onContinue={onContinue} />);
    const sentenceOnly = renderToStaticMarkup(
      <ChatTurn role="assistant" content={[{ type: "text", text: sentence }]} onContinue={onContinue} />,
    );
    const asUser = renderToStaticMarkup(<ChatTurn role="user" content={marked} onContinue={onContinue} />);
    const interrupted = renderToStaticMarkup(
      <ChatTurn
        role="assistant"
        content={[
          {
            type: "text",
            text: 'The tool steps above ran, but I could not finish the answer.\n\nSend "continue" and I will try again.',
          },
        ]}
        onContinue={onContinue}
      />,
    );
    const live = renderToStaticMarkup(
      <ChatTurn
        role="assistant"
        content={marked}
        live={{ thinking: "", tools: [], streaming: sentence, running: false }}
        onContinue={onContinue}
      />,
    );

    expect(withMark).toContain('data-testid="chat-continue"');
    expect(withMark).toContain(">Continue<");
    const button = withMark.slice(withMark.indexOf("<button"), withMark.indexOf("</button>"));
    expect(button).toContain('data-testid="chat-continue"');
    expect(button).not.toContain("disabled");
    expect(sentenceOnly).not.toContain("chat-continue");
    expect(asUser).not.toContain("chat-continue");
    expect(interrupted).not.toContain("chat-continue");
    expect(live).not.toContain("chat-continue");
    const noTools = renderToStaticMarkup(
      <ChatTurn
        role="assistant"
        content={[{ type: "text", text: "No tool finished, but the answer didn't." }, { type: "step_limit", tools: [] }]}
        onContinue={onContinue}
      />,
    );
    expect(noTools).toContain('data-testid="chat-continue"');
  });

  it("labels the control in Bahasa Indonesia", () => {
    applyLocale("id");
    const html = renderToStaticMarkup(<ChatTurn role="assistant" content={marked} onContinue={() => undefined} />);
    expect(html).toContain('data-testid="chat-continue"');
    expect(html).toContain(">Lanjutkan<");
    expect(html).not.toContain(">Continue<");
  });

  it("disables the control while a run is already going", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(
      <ChatTurn role="assistant" content={marked} onContinue={() => undefined} continueDisabled />,
    );
    expect(html).toMatch(/data-testid="chat-continue"[^>]*disabled/);
  });

  it("reads the host mark and sends the word continue", () => {
    expect(CONTINUE_PROMPT).toBe("continue");
    expect(stepLimitToolsOf(marked)).toEqual(["list_files"]);
    expect(stepLimitToolsOf([{ type: "text", text: sentence }])).toBeNull();
    expect(stepLimitToolsOf("continue")).toBeNull();
    expect(messageHasDisplayableContent([{ type: "step_limit", tools: ["list_files"] }])).toBe(true);
  });

  it("wires the click to the composer's text send of the word continue", () => {
    const session = readFileSync(new URL("../components/chat-session.tsx", import.meta.url), "utf8");
    const composer = readFileSync(new URL("../components/chat-composer.tsx", import.meta.url), "utf8");
    const turn = readFileSync(new URL("../components/chat-turn.tsx", import.meta.url), "utf8");
    expect(session).toContain("continueSendRef.current?.(CONTINUE_PROMPT)");
    expect(session).not.toContain("stepLimitNote");
    expect(composer).toContain("void send(text)");
    expect(composer).toContain("const continuing = override !== undefined");
    expect(turn).toContain("onClick={() => onContinue?.(CONTINUE_PROMPT)}");
    expect(turn).toContain("stepLimitToolsOf(content)");
    expect(turn).not.toContain("finished, but the answer");
  });
});
