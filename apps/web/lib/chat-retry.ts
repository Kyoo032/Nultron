export type RetryMessage = { id: string; role: string; content: unknown };

export type RetryPayload = { text: string; parts?: readonly unknown[] };

function isTextPart(part: unknown): boolean {
  return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text";
}

export function retryTextOf(payload: RetryPayload): string | null {
  return (payload.parts ?? []).every(isTextPart) ? payload.text : null;
}

function storedTextOf(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content) || !content.every(isTextPart)) {
    return null;
  }
  return content.map((part) => (part as { text: string }).text).join("");
}

export function canOfferRetry(input: {
  failed: boolean;
  retryText: string | null;
  messages: readonly RetryMessage[];
}): boolean {
  if (!input.failed || input.retryText === null) {
    return false;
  }
  const last = input.messages[input.messages.length - 1];
  if (last?.role !== "user" || last.id.startsWith("local-")) {
    return false;
  }
  return storedTextOf(last.content) === input.retryText;
}
