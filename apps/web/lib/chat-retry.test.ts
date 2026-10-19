import { describe, expect, it } from "vitest";
import { canOfferRetry, retryTextOf, type RetryMessage } from "./chat-retry";

const stored: RetryMessage = { id: "m-2", role: "user", content: [{ type: "text", text: "draft" }] };
const answer: RetryMessage = { id: "m-3", role: "assistant", content: [{ type: "text", text: "reply" }] };
const optimistic: RetryMessage = { id: "local-170", role: "user", content: [{ type: "text", text: "draft" }] };

describe("retryTextOf", () => {
  it("keeps the text of a text-only send", () => {
    expect(retryTextOf({ text: "draft", parts: [{ type: "text", text: "draft" }] })).toBe("draft");
    expect(retryTextOf({ text: "draft" })).toBe("draft");
  });

  it("keeps nothing for a send that carries a picture or a clip", () => {
    expect(
      retryTextOf({
        text: "What is in this image?",
        parts: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "/api/v1/media/a/file" } },
        ],
      }),
    ).toBeNull();
  });
});

describe("canOfferRetry", () => {
  it("offers Try again when the newest message is the stored turn that failed", () => {
    expect(canOfferRetry({ failed: true, retryText: "draft", messages: [stored] })).toBe(true);
  });

  it("does not offer it while the send has not failed", () => {
    expect(canOfferRetry({ failed: false, retryText: "draft", messages: [stored] })).toBe(false);
  });

  it("does not offer it without a text to resend", () => {
    expect(canOfferRetry({ failed: true, retryText: null, messages: [stored] })).toBe(false);
  });

  it("does not offer it when the newest message is still the optimistic bubble", () => {
    expect(canOfferRetry({ failed: true, retryText: "draft", messages: [optimistic] })).toBe(false);
  });

  it("does not offer it when the stored turn already has an answer after it", () => {
    expect(canOfferRetry({ failed: true, retryText: "draft", messages: [stored, answer] })).toBe(false);
  });

  it("does not offer it when the stored text is different", () => {
    expect(canOfferRetry({ failed: true, retryText: "other", messages: [stored] })).toBe(false);
  });

  it("does not offer it for an empty thread", () => {
    expect(canOfferRetry({ failed: true, retryText: "draft", messages: [] })).toBe(false);
  });
});
