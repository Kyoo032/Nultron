/**
 * Reads an OpenAI-style server-sent stream. A frame split across TCP chunks stays in the
 * buffer until the newline arrives. One bad JSON line is skipped; it is not the whole reply.
 */

export function createSseParser(): { push(text: string): unknown[] } {
  let buffer = "";
  return {
    push(text: string): unknown[] {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const events: unknown[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          events.push(JSON.parse(payload) as unknown);
        } catch {
          // One frame we cannot read is one frame.
        }
      }
      return events;
    },
  };
}
