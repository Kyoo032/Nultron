/**
 * Safe web search on the Chat run path: a Knowledge Base excerpt in the prompt taints the turn from its first
 * step, so a search that repeats it is never sent.
 *
 * Real router-side code (`startModalityRun`, the Knowledge Base, the thread store), the real AI SDK runtime
 * and the real `web_search` tool on its keyless backend. The only stand-in is `fetch`: the gateway answers
 * with a scripted tool call, and every other request is a search provider that must never be reached.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => {
      const runtime = new actual.AiSdkRuntime({ openai: "sk-test", openaiBaseUrl: "https://api.tokotokenai.com/v1" });
      return { execute: (input) => runtime.execute(actual.maskOutboundRunInput(input)) };
    },
  };
});

const KB_TEXT =
  "Catatan proyek ZEBRAQUILL. Pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh setiap bulan ke rekening escrow.";
const LEAK = "pembayaran tahap kedua dilakukan paling lambat tanggal sepuluh";

const encoder = new TextEncoder();

function sse(frames: unknown[]): Response {
  const body = `${frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage } : {}),
  };
}

function searchCall(query: string): Response {
  return sse([
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify({ query }) },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);
}

function text(answer: string): Response {
  return sse([chunk({ role: "assistant", content: answer }), chunk({}, "stop")]);
}

let gatewayBodies: string[] = [];
let searchRequests: string[] = [];
let tenant: TenantContext;
let agentId = "";

async function drain(run: AsyncIterable<string>): Promise<string> {
  let raw = "";
  for await (const part of run) {
    raw += part;
  }
  return raw;
}

function framesOf(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

beforeAll(async () => {
  const { agentService, getTenant } = await import("./tenant");
  tenant = await getTenant();
  agentId = (await agentService.ensureDefaultChat(tenant)).agent.id;
  const { addPastedSource } = await import("./knowledge");
  await addPastedSource(tenant, "Kontrak escrow", KB_TEXT);
  await import("./runs");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  gatewayBodies = [];
  searchRequests = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (!target.includes("api.tokotokenai.com")) {
      searchRequests.push(target);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    gatewayBodies.push(String(init?.body ?? ""));
    return gatewayBodies.length === 1 ? searchCall(LEAK) : text("I could not search for that.");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("a Chat turn with a Knowledge Base excerpt in its prompt", () => {
  it("refuses a search that repeats the excerpt, before any search provider is reached", async () => {
    const { createThread } = await import("./threads");
    const { startModalityRun } = await import("./runs");
    const thread = await createThread(tenant, agentId, "Outbound");

    const raw = await drain(
      startModalityRun({
        tenant,
        threadId: thread.id,
        modality: "text",
        body: { content: "Apa isi catatan ZEBRAQUILL?", model: "gpt-4o" },
      }),
    );

    expect(gatewayBodies[0]).toContain("dilakukan paling lambat tanggal sepuluh");
    expect(searchRequests).toEqual([]);
    const completed = framesOf(raw).find((frame) => frame.type === "tool.completed" && frame.toolKey === "web_search");
    expect(completed?.output).toEqual({
      ok: false,
      reason: "outbound",
      kind: "private",
      message:
        "Not sent: this search or page address carries the person's private details (a phrase, number or code from their files, knowledge or earlier chats). Search again in general terms, without the person's details.",
    });
  });
});
