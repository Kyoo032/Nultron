/**
 * How the Chat pane reads the context chip's knowledge rows.
 *
 * `GET /api/v1/knowledge/context?query=` retrieves, and retrieving embeds the query through the
 * gateway: a paid call on a keyed desk. The pane used to make it with the last user message on every
 * change of `messages`, so opening an old thread, and every send, cost an embedding the send had
 * already paid for (found driving webdev, 2026-10-01). It now asks with the thread alone, which the
 * host answers from what the thread's last turn was handed, and only when the chip can be on screen
 * (a reply exists) and the turn it describes has changed. The host half is
 * `packages/host/src/knowledge-context-route.test.ts`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { knowledgeContextPath, knowledgeContextWanted, lastAssistantId, parseContextParts } from "./knowledge-context";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const chatSession = readFileSync(join(web, "components", "chat-session.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("knowledgeContextPath", () => {
  it("names the thread and never a query", () => {
    expect(knowledgeContextPath("t-1")).toBe("/api/v1/knowledge/context?threadId=t-1");
    expect(knowledgeContextPath("t-1")).not.toContain("query");
  });

  it("escapes the id it puts in the address", () => {
    expect(knowledgeContextPath("a b&c=d")).toBe("/api/v1/knowledge/context?threadId=a%20b%26c%3Dd");
  });
});

describe("knowledgeContextWanted", () => {
  const ready = { keyMissing: false, hasReply: true, threadId: "t-1" };

  it("wants the rows for a thread that has a reply on a desk that can answer", () => {
    expect(knowledgeContextWanted(ready)).toBe(true);
  });

  it("does not ask when the chip is not on screen: no reply yet, or no thread to describe", () => {
    expect(knowledgeContextWanted({ ...ready, hasReply: false })).toBe(false);
    expect(knowledgeContextWanted({ ...ready, threadId: null })).toBe(false);
  });

  it("does not ask a desk the host would refuse (`403 gateway_blocked`)", () => {
    expect(knowledgeContextWanted({ ...ready, keyMissing: true })).toBe(false);
  });
});

describe("lastAssistantId", () => {
  it("is the id of the newest reply, so a new turn is what asks again", () => {
    expect(
      lastAssistantId([
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        { id: "a2", role: "assistant" },
        { id: "u3", role: "user" },
      ]),
    ).toBe("a2");
  });

  it("is empty before any reply", () => {
    expect(lastAssistantId([])).toBe("");
    expect(lastAssistantId([{ id: "u1", role: "user" }])).toBe("");
  });
});

describe("parseContextParts", () => {
  it("keeps the rows that carry a label and drops the rest", () => {
    expect(
      parseContextParts({
        parts: [
          { label: "Soul", detail: "Nultron", tokens: 12 },
          { detail: "no label", tokens: 3 },
          null,
          "Sources",
          { label: "Sources", detail: "2 chunks", tokens: 90 },
        ],
      }),
    ).toEqual([
      { label: "Soul", detail: "Nultron", tokens: 12 },
      { label: "Sources", detail: "2 chunks", tokens: 90 },
    ]);
  });

  it("answers nothing for a payload without a list", () => {
    expect(parseContextParts(null)).toEqual([]);
    expect(parseContextParts({})).toEqual([]);
    expect(parseContextParts({ parts: "Soul" })).toEqual([]);
  });
});

describe("the pane", () => {
  it("never sends the last message as a query", () => {
    expect(chatSession).not.toContain('params.set("query"');
    expect(chatSession).not.toContain("/api/v1/knowledge/context?");
    expect(chatSession).toContain("knowledgeContextPath(");
  });

  it("asks again only when the thread, the desk's key or the newest reply changes, not on every message", () => {
    const start = chatSession.indexOf("knowledgeContextWanted(");
    expect(start).toBeGreaterThan(-1);
    const effect = chatSession.slice(start, chatSession.indexOf('<main className="flex h-full', start));
    expect(effect).toMatch(/\}, \[keyMissing, threadId, hasReply, newestReplyId\]\);/);
    expect(effect).not.toMatch(/\}, \[messages/);
  });

  it("forgets the rows of a thread it has left instead of showing them on the next one", () => {
    expect(chatSession).toMatch(/if \(!knowledgeContextWanted\([^)]*\)\) \{[^}]*setKnowledgeParts/);
    expect(chatSession).toContain("let cancelled = false;");
  });
});
