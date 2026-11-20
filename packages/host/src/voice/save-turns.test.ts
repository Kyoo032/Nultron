/**
 * `saveVoiceTurn`: a spoken turn lands in the thread the way a typed one does — the person's row,
 * then the desk's — with the ask's `tool_call` parts ahead of the text, so a reload renders the
 * exchange and the delegate card under the spoken answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext, ToolCallPart } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { saveVoiceTurn } from "./save-turns";

let tenant: TenantContext;
let agentId = "";
let threads: typeof import("../threads");

async function newThread(): Promise<string> {
  const thread = await threads.createThread(tenant, agentId, "Voice saves");
  if (!thread) {
    throw new Error("thread was not created");
  }
  return thread.id;
}

const DELEGATE: ToolCallPart = {
  type: "tool_call",
  toolKey: "delegate",
  status: "completed",
  input: { agent: "research", task: "Find three reliable sources on QRIS fees." },
  output: {
    ok: true,
    agent: "research",
    agentName: "Research agent",
    thread: { id: "t-9" },
    summary: "Fees are capped at 0.3 percent.",
    truncated: false,
    toolsUsed: ["web_search"],
  },
};

beforeAll(async () => {
  const { agentService, getTenant } = await import("../tenant");
  tenant = await getTenant();
  agentId = (await agentService.ensureDefaultChat(tenant)).agent.id;
  threads = await import("../threads");
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("saveVoiceTurn", () => {
  it("writes the person's row, then the desk's, tool calls before the text", async () => {
    const threadId = await newThread();
    await saveVoiceTurn(tenant, threadId, "ask research about QRIS", "Research says fees are capped.", [DELEGATE]);
    const rows = await threads.listMessages(tenant, threadId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    const parts = rows[1]?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "tool_call", toolKey: "delegate", status: "completed" });
    expect(parts[1]).toMatchObject({ type: "text", text: "Research says fees are capped." });
  });

  it("keeps an assistant row that is only a tool call, when the answer had no words", async () => {
    const threadId = await newThread();
    await saveVoiceTurn(tenant, threadId, "ask research", "", [DELEGATE]);
    const rows = await threads.listMessages(tenant, threadId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1]?.content as unknown[]).toHaveLength(1);
  });

  it("writes a plain spoken turn with no tool parts, as before", async () => {
    const threadId = await newThread();
    await saveVoiceTurn(tenant, threadId, "how are you", "Fine.");
    const rows = await threads.listMessages(tenant, threadId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1]?.content).toEqual([{ type: "text", text: "Fine." }]);
  });

  it("writes nothing when there is nothing to say", async () => {
    const threadId = await newThread();
    await saveVoiceTurn(tenant, threadId, "   ", "  ", []);
    expect(await threads.listMessages(tenant, threadId)).toHaveLength(0);
  });
});

describe("recentVoiceHistory", () => {
  it("reads the spoken turns back as text only, tool parts and all", async () => {
    const { recentVoiceHistory } = await import("./save-turns");
    const threadId = await newThread();
    await saveVoiceTurn(tenant, threadId, "first question", "first answer", [DELEGATE]);
    await saveVoiceTurn(tenant, threadId, "second question", "second answer");
    const history = await recentVoiceHistory(tenant, threadId);
    expect(history.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(history)).not.toContain("tool_call");
    expect(JSON.stringify(history)).toContain("first answer");
  });
});
