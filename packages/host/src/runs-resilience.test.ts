import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatTurnCopy,
  stepLimitNote,
  openPayload,
  reportToolIo,
  type AgentRuntime,
  type ContentPart,
  type TenantContext,
} from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * What a Chat turn does with a tool's input and output, with a run that ends at its step limit, and with a
 * tool the run does not offer. The runtime is scripted, so the host's own work is what is read: the frames
 * sent to the screen, the `tool_invocations` rows, the saved message and the prompt the runtime is handed.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-runs-resilience-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "d".repeat(64);
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_CODE_RUNS;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];
const executed: ExecuteInput[] = [];
let script: (input: ExecuteInput) => Promise<void> = async () => undefined;

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (): AgentRuntime => ({
      async execute(input) {
        executed.push(input);
        await actual.runWithToolIoSink(() => script(input));
      },
    }),
  };
});

// The real card, with a spy on it: the Knowledge Base card a turn writes is read back from the call.
vi.mock("./work-cards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./work-cards")>();
  return { ...actual, chatWorkCard: vi.fn(actual.chatWorkCard) };
});

const KEY = "sk-live-0123456789abcdefABCDEF";
const BEARER = "abcdefghijklmnop1234567890";
const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let threadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await dispatch(request(method, path, { body }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return (result.body ?? {}) as T;
}

type Frame = { event: string; data: Record<string, unknown> };

/** Posts one turn and returns every frame the screen would have received, parsed. */
async function postTurn(): Promise<{ frames: Frame[]; raw: string }> {
  const result = await dispatch(
    request("POST", `/api/v1/threads/${threadId}/runs/text`, { params: { threadId }, body: { content: "hello" } }),
  );
  if (result.type !== "stream") {
    throw new Error(`expected a stream, got ${result.type}: ${JSON.stringify((result as { body?: unknown }).body)}`);
  }
  let raw = "";
  for await (const frame of result.events) {
    raw += frame;
  }
  const frames = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
      const data = JSON.parse((lines.find((line) => line.startsWith("data:")) ?? "data: {}").slice(5)) as Record<
        string,
        unknown
      >;
      return { event, data };
    });
  return { frames, raw };
}

async function lastAssistantParts(): Promise<ContentPart[]> {
  const { listMessages } = await import("./threads");
  const rows = (await listMessages(tenant, threadId)).filter((row) => row.role === "assistant");
  return (rows[rows.length - 1]?.content ?? []) as ContentPart[];
}

async function toolRows(runId: string): Promise<Array<{ input: unknown; output: unknown; status: string }>> {
  const { db, toolInvocations } = await import("@agentforge/db");
  const { getLocalVaultKey } = await import("@agentforge/db/vault-key");
  const rows = await db.select().from(toolInvocations).where(eq(toolInvocations.runId, runId));
  return rows.map((row) => ({
    input: row.input == null ? null : openPayload(row.input, getLocalVaultKey()),
    output: row.output == null ? null : openPayload(row.output, getLocalVaultKey()),
    status: row.status,
  }));
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const chat = await json<{ agent: { id: string } }>("GET", "/api/v1/chat");
  const created = await json<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId: chat.agent.id });
  threadId = created.thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  executed.length = 0;
  script = async (input) => {
    await input.onEvent({ type: "assistant.delta", text: "hello" });
    await input.onEvent({ type: "run.completed", runId: input.runId });
  };
});

afterEach(() => {
  delete process.env.AGENTFORGE_CODE_RUNS;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a tool's input and output on a Chat turn", () => {
  const input = {
    url: "https://example.test/a",
    headers: { Authorization: `Bearer ${BEARER}`, Accept: "text/html" },
    note: `my key is ${KEY}`,
  };
  const output = { success: true, body: `the page echoed ${KEY}`, sha256: SHA, api_key: "opaque-no-prefix" };

  beforeEach(() => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "web_fetch", input });
      reportToolIo({ toolKey: "web_fetch", input, full: output, thin: output });
      await run.onEvent({ type: "tool.completed", toolKey: "web_fetch", output });
      await run.onEvent({ type: "assistant.delta", text: "done" });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
  });

  it("is redacted in the frames sent to the screen", async () => {
    const { frames, raw } = await postTurn();
    for (const secret of [KEY, BEARER, "opaque-no-prefix"]) {
      expect(raw, secret).not.toContain(secret);
    }
    const started = frames.find((frame) => frame.event === "tool.started");
    const completed = frames.find((frame) => frame.event === "tool.completed");
    expect(started?.data.input).toEqual({
      url: "https://example.test/a",
      headers: { Authorization: "[REDACTED]", Accept: "text/html" },
      note: "my key is [REDACTED]",
    });
    expect(completed?.data.output).toEqual({
      success: true,
      body: "the page echoed [REDACTED]",
      sha256: SHA,
      api_key: "[REDACTED]",
    });
  });

  it("is redacted in the tool_invocations rows, where the full output is kept", async () => {
    const { frames } = await postTurn();
    const runId = String(frames.find((frame) => frame.event === "run.started")?.data.runId);
    const rows = await toolRows(runId);
    expect(rows).toHaveLength(2);
    const text = JSON.stringify(rows);
    for (const secret of [KEY, BEARER, "opaque-no-prefix"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(rows[0]?.input).toMatchObject({ note: "my key is [REDACTED]" });
    expect(rows[1]?.output).toMatchObject({ body: "the page echoed [REDACTED]", sha256: SHA });
  });

  it("is redacted in the tool call saved with the assistant message", async () => {
    await postTurn();
    const parts = await lastAssistantParts();
    const call = parts.find((part) => part.type === "tool_call");
    expect(call).toBeDefined();
    const text = JSON.stringify(call);
    for (const secret of [KEY, BEARER, "opaque-no-prefix"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain("[REDACTED]");
    expect(text).toContain(SHA);
  });

  it("leaves the tool's own event untouched: what the runtime holds is not rewritten", async () => {
    await postTurn();
    expect(input.note).toContain(KEY);
    expect(output.body).toContain(KEY);
  });
});

describe("a run that ends at its step limit", () => {
  beforeEach(() => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true, items: [] } });
      await run.onEvent({ type: "run.step_limit", steps: 12 });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
  });

  it("tells the person the steps ran out, names the tool that finished, and marks the turn", async () => {
    const { frames } = await postTurn();
    const sentence = stepLimitNote("en", ["list_files"]);
    expect(sentence).toMatch(/list_files finished/i);
    expect(sentence).toMatch(/answer didn't/i);
    const deltas = frames.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.text);
    expect(deltas.join("")).toContain(sentence);
    const parts = await lastAssistantParts();
    expect(parts.map((part) => part.type)).toEqual(["tool_call", "text", "step_limit"]);
    expect(parts.find((part) => part.type === "text")).toMatchObject({ type: "text", text: sentence });
    expect(parts.find((part) => part.type === "step_limit")).toEqual({ type: "step_limit", tools: ["list_files"] });
    expect(frames.some((frame) => frame.event === "run.step_limit")).toBe(false);
    expect(frames.some((frame) => frame.event === "run.completed")).toBe(true);
  });

  it("says it in Bahasa Indonesia when the desk's language is Indonesian, and still marks the turn", async () => {
    const { saveUserLocale } = await import("./settings-store");
    saveUserLocale(tenant, "id");
    try {
      const { frames } = await postTurn();
      const deltas = frames.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.text);
      const sentence = stepLimitNote("id", ["list_files"]);
      expect(deltas.join("")).toContain(sentence);
      expect(deltas.join("")).toMatch(/list_files sudah selesai/);
      expect(deltas.join("")).toMatch(/jawabannya belum/);
      expect(deltas.join("")).not.toContain(stepLimitNote("en", ["list_files"]));
      const parts = await lastAssistantParts();
      expect(parts.find((part) => part.type === "step_limit")).toEqual({ type: "step_limit", tools: ["list_files"] });
    } finally {
      saveUserLocale(tenant, "en");
    }
  });

  it("adds nothing to a turn that answered, and does not mark it", async () => {
    script = async (run) => {
      await run.onEvent({ type: "assistant.delta", text: "All done." });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    const { raw } = await postTurn();
    expect(raw).not.toContain(stepLimitNote("en", []));
    expect(raw).not.toContain("step_limit");
    const parts = await lastAssistantParts();
    expect(parts.some((part) => part.type === "step_limit")).toBe(false);
  });
});

describe("a run whose model call failed after a tool completed", () => {
  const reason = "The gateway is unavailable right now. Send again in a moment.";
  beforeEach(() => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true, items: [] } });
      await run.onEvent({ type: "run.interrupted", message: reason });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
  });

  it("tells the person the tools ran and why the answer did not come, streams it and saves it with the turn", async () => {
    const { frames } = await postTurn();
    const sentence = chatTurnCopy("en").interrupted.replaceAll("{reason}", reason);
    const deltas = frames.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.text);
    expect(deltas.join("")).toBe(sentence);
    expect(deltas.join("")).toMatch(/tool steps above ran/i);
    expect(deltas.join("")).toMatch(/continue/i);
    // After the tool frames, before the run completes, and not as a failure: the tool turn is kept.
    const order = frames.map((frame) => frame.event);
    expect(order.lastIndexOf("tool.completed")).toBeLessThan(order.indexOf("assistant.delta"));
    expect(order.indexOf("assistant.delta")).toBeLessThan(order.indexOf("run.completed"));
    expect(order).not.toContain("run.failed");
    expect(order).not.toContain("run.interrupted");
    // Survives a reload: the saved message holds the tool row and the sentence, in that order.
    const parts = await lastAssistantParts();
    expect(parts.map((part) => part.type)).toEqual(["tool_call", "text"]);
    expect(parts.find((part) => part.type === "text")).toMatchObject({ type: "text", text: sentence });
  });

  it("says it in Bahasa Indonesia when the desk's language is Indonesian", async () => {
    const { saveUserLocale } = await import("./settings-store");
    saveUserLocale(tenant, "id");
    try {
      const { frames } = await postTurn();
      const deltas = frames.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.text);
      expect(deltas.join("")).toContain(chatTurnCopy("id").interrupted.split("{reason}")[0]);
      expect(deltas.join("")).toContain(reason);
      expect(deltas.join("")).not.toMatch(/tool steps above/i);
      const text = (await lastAssistantParts()).find((part) => part.type === "text");
      expect(text).toMatchObject({ type: "text", text: expect.stringMatching(/lanjutkan/) });
    } finally {
      saveUserLocale(tenant, "en");
    }
  });

  it("keeps the words the model streamed before the failure and adds the sentence after them", async () => {
    script = async (run) => {
      await run.onEvent({ type: "assistant.delta", text: "Let me read it." });
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true, items: [] } });
      await run.onEvent({ type: "run.interrupted", message: reason });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    await postTurn();
    const text = (await lastAssistantParts()).find((part) => part.type === "text");
    expect(text).toMatchObject({
      type: "text",
      text: `Let me read it.\n\n${chatTurnCopy("en").interrupted.replaceAll("{reason}", reason)}`,
    });
  });

  it("masks a secret that the failure's own text carries", async () => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true } });
      await run.onEvent({ type: "run.interrupted", message: `upstream refused ${KEY}` });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    const { raw } = await postTurn();
    expect(raw).not.toContain(KEY);
    expect(JSON.stringify(await lastAssistantParts())).not.toContain(KEY);
    expect(raw).toContain("[REDACTED]");
  });

  it("adds nothing to a turn that answered", async () => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true } });
      await run.onEvent({ type: "assistant.delta", text: "All done." });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    const { raw } = await postTurn();
    expect(raw).not.toMatch(/tool steps above/i);
  });
});

describe("the Chat prompt and a tool the run does not offer", () => {
  it("names run_code and self_check on a desk where code runs are on", async () => {
    process.env.AGENTFORGE_CODE_RUNS = "on";
    await postTurn();
    expect(executed[0]?.version.systemPrompt).toMatch(/run_code runs a short Python/);
    expect(executed[0]?.version.systemPrompt).toMatch(/self_check reports/);
  });

  it("does not tell the model about run_code when code runs are off", async () => {
    process.env.AGENTFORGE_CODE_RUNS = "off";
    await postTurn();
    const prompt = executed[0]?.version.systemPrompt ?? "";
    expect(prompt).not.toMatch(/run_code/);
    expect(prompt).not.toMatch(/\/workspace/);
    expect(prompt).toMatch(/calculator for one arithmetic expression/);
    expect(prompt).toMatch(/self_check reports/);
  });

  it("still binds run_code, so a call to it is refused and not a failed run", async () => {
    process.env.AGENTFORGE_CODE_RUNS = "off";
    await postTurn();
    const keys = (executed[0]?.bindings ?? []).map((binding) => binding.toolKey);
    expect(keys).toContain("run_code");
    expect(keys).toContain("self_check");
  });
});

describe("the Knowledge Base card of a Chat turn", () => {
  const reason = "The gateway is unavailable right now. Send again in a moment.";

  async function cardsWritten(): Promise<Array<{ assistantText: string }>> {
    const { chatWorkCard } = await import("./work-cards");
    return vi.mocked(chatWorkCard).mock.calls.map(([card]) => card);
  }

  beforeEach(async () => {
    const { chatWorkCard } = await import("./work-cards");
    vi.mocked(chatWorkCard).mockClear();
  });

  it("indexes the model's own words when the run was interrupted, not the sentence the host added", async () => {
    script = async (run) => {
      await run.onEvent({ type: "assistant.delta", text: "Let me read it." });
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true, items: [] } });
      await run.onEvent({ type: "run.interrupted", message: reason });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    await postTurn();
    const cards = await cardsWritten();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.assistantText).toBe("Let me read it.");
  });

  it("indexes the model's own words when the run ended at its step limit", async () => {
    script = async (run) => {
      await run.onEvent({ type: "assistant.delta", text: "Let me read it." });
      await run.onEvent({ type: "run.step_limit", steps: 12 });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    await postTurn();
    const cards = await cardsWritten();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.assistantText).toBe("Let me read it.");
  });

  it("writes no card from the host's sentence alone, when the model wrote no words", async () => {
    script = async (run) => {
      await run.onEvent({ type: "tool.started", toolKey: "list_files", input: {} });
      await run.onEvent({ type: "tool.completed", toolKey: "list_files", output: { ok: true, items: [] } });
      await run.onEvent({ type: "run.interrupted", message: reason });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    };
    await postTurn();
    expect(await cardsWritten()).toEqual([]);
  });
});
