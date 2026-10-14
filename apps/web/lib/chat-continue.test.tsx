/**
 * Continue shows only on a turn the host marked with a `step_limit` part.
 * A turn that merely contains the step-limit sentence, and an interrupted turn, do not get it.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTurn, messageHasDisplayableContent } from "@/components/chat-turn";
import { CONTINUE_PROMPT, continuePrompt, mayOfferContinue, sendSource, stepLimitToolsOf } from "@/lib/chat-continue";
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
        content={[
          { type: "text", text: "No tool finished, but the answer didn't." },
          { type: "step_limit", tools: [] },
        ]}
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

  it("shows no control on a marked turn that may not continue", () => {
    applyLocale("en");
    const html = renderToStaticMarkup(<ChatTurn role="assistant" content={marked} />);
    expect(html).not.toContain("chat-continue");
  });

  it("offers Continue on the newest reply only", () => {
    expect(mayOfferContinue(2, 3, "assistant")).toBe(true);
    expect(mayOfferContinue(0, 3, "assistant")).toBe(false);
    expect(mayOfferContinue(1, 3, "assistant")).toBe(false);
    expect(mayOfferContinue(2, 3, "user")).toBe(false);
  });

  it("sends only the word, never the draft or the files in the box", () => {
    const files = [{ id: "f1" }];
    const continued = sendSource("continue", "my half-written draft", files);
    expect(continued).toEqual({ continuing: true, typed: "continue", attached: [] });
    const continuedEmpty = sendSource("continue", "", []);
    expect(continuedEmpty.typed).toBe("continue");
    const ordinary = sendSource(undefined, "hello", files);
    expect(ordinary).toEqual({ continuing: false, typed: "hello", attached: files });
    expect(ordinary.attached).toBe(files);
  });

  it("sends the word in the desk language", () => {
    expect(continuePrompt("en")).toBe("continue");
    expect(continuePrompt("id")).toBe("lanjutkan");
    expect(continuePrompt("xx")).toBe("continue");
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
    expect(session).toContain("continueSendRef.current?.(continuePrompt(getLocale()))");
    expect(session).toContain("mayOfferContinue(index, shown.length, message.role)");
    expect(session).not.toContain("stepLimitNote");
    expect(composer).toContain("void send(text)");
    expect(composer).toContain("sendSource(override, text, files)");
    expect(composer).toContain("if (needsKey || (continuing && busy))");
    // The outgoing message is built from what the send carries, not from the box.
    expect(composer).toContain("let composedText = typed;");
    expect(composer).not.toContain("let composedText = text;");
    expect(turn).toContain("onClick={() => onContinue?.(continuePrompt(getLocale()))}");
    expect(turn).toContain("stepLimitToolsOf(content)");
    expect(turn).not.toContain("finished, but the answer");
  });
});
