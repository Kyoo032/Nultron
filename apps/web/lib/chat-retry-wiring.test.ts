import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const session = readFileSync(new URL("../components/chat-session.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("../components/chat-composer.tsx", import.meta.url), "utf8");
const body = readFileSync(new URL("./chat-tier-body.ts", import.meta.url), "utf8");

describe("Try again on a failed text turn", () => {
  it("shows the button only when the newest message is the stored turn that failed", () => {
    expect(session).toContain("canOfferRetry({ failed: sendFailed, retryText, messages })");
    expect(session).toContain('data-testid="chat-retry"');
    expect(session).toContain('t("chat.turn.retry")');
  });

  it("sends the same text through the composer's override path, with retry set", () => {
    expect(session).toContain('continueSendRef.current?.(retryText ?? "", true)');
    expect(composer).toContain("void send(text, retry)");
    expect(composer).toContain("sendSource(override, text, files)");
    expect(composer).toContain("buildChatRunBody(outgoing, tier, retrying)");
  });

  it("does not add the message to the pane a second time when it is retried", () => {
    expect(session).toContain("payload.retry ? current : [...current,");
    expect(composer).toContain("retry: retrying,");
  });

  it("writes retry into the body only on a retry", () => {
    expect(body).toContain("retry ? { content, tier, retry: true as const } : { content, tier }");
  });
});
