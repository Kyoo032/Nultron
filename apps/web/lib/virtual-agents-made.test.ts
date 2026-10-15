import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api-client";
import { activeAgentId } from "./virtual-agents";
import {
  type AgentDraftFields,
  createMadeAgent,
  deleteMadeAgent,
  draftMadeAgent,
  fetchMadeAgents,
  madeAgentHref,
  madeAgentIdFromSearch,
  readCreateResult,
  readDeleteResult,
  readDraftResult,
  readMadeAgents,
} from "./virtual-agents-made";

vi.mock("./api-client", () => ({ apiFetch: vi.fn() }));

const mockedFetch = vi.mocked(apiFetch);

const DRAFT: AgentDraftFields = {
  name: "Invoice checker",
  description: "Checks invoices",
  instructions: "Compare each invoice with its order.",
  baseMode: "finance",
  tools: ["calculator", "web_search"],
};

function fail(key: string) {
  return { ok: false, failure: { kind: "message", key } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("readMadeAgents", () => {
  it("keeps only the prompt-made rows and reads a missing deletable as false", () => {
    expect(
      readMadeAgents({
        specialists: [
          { id: "a1", name: "Invoices", description: "Checks", madeFromPrompt: true, deletable: true },
          { id: "a2", name: "Old", madeFromPrompt: true },
          { id: "q1", name: "Office", madeFromPrompt: false, deletable: true },
          { id: "x1", name: "Unflagged" },
        ],
      }),
    ).toEqual([
      { id: "a1", name: "Invoices", description: "Checks", deletable: true },
      { id: "a2", name: "Old", description: "", deletable: false },
    ]);
  });

  it("is empty for an answer with no list", () => {
    expect(readMadeAgents(null)).toEqual([]);
    expect(readMadeAgents({ error: { code: "internal", message: "x" } })).toEqual([]);
  });
});

describe("readDraftResult", () => {
  it("parses a 200 draft and keeps its source", () => {
    expect(readDraftResult(200, { draft: DRAFT, source: "live" })).toEqual({
      ok: true,
      answer: { draft: DRAFT, source: "live" },
    });
  });

  it("reads a stub draft as stub", () => {
    const result = readDraftResult(200, { draft: { ...DRAFT, baseMode: "chat", tools: [] }, source: "stub" });
    expect(result.ok && result.answer.source).toBe("stub");
  });

  it("refuses a draft whose mode is not a product mode as model_output_invalid", () => {
    expect(readDraftResult(200, { draft: { ...DRAFT, baseMode: "nope" } })).toEqual(
      fail("agents.made.error.draftInvalid"),
    );
  });

  it("refuses a draft with no instructions", () => {
    expect(readDraftResult(200, { draft: { ...DRAFT, instructions: "   " } })).toEqual(
      fail("agents.made.error.draftInvalid"),
    );
  });

  it("maps each refusal code to catalog copy", () => {
    expect(readDraftResult(400, { error: { code: "invalid_request", message: "x" } })).toEqual(
      fail("agents.made.error.invalidPrompt"),
    );
    expect(readDraftResult(502, { error: { code: "model_output_invalid", message: "x" } })).toEqual(
      fail("agents.made.error.draftInvalid"),
    );
    expect(readDraftResult(502, { error: { code: "generation_failed", message: "x" } })).toEqual(
      fail("agents.made.error.draft"),
    );
  });

  it("answers the gateway gate as its own failure, not as a message", () => {
    expect(
      readDraftResult(403, { error: "gateway_blocked", status: "needs_key", message: "Add a key in Settings." }),
    ).toEqual({ ok: false, failure: { kind: "gateway" } });
  });
});

describe("readCreateResult", () => {
  it("parses a 201 into the new agent's id and name", () => {
    expect(
      readCreateResult(201, {
        agent: { id: "ag_1", name: "Invoice checker", visibility: "private" },
        version: { id: "v_1", version: 1 },
        tools: ["calculator"],
      }),
    ).toEqual({ ok: true, agent: { id: "ag_1", name: "Invoice checker" } });
  });

  it("maps 400 and 403 and falls back to one message for anything else", () => {
    expect(readCreateResult(400, { error: { code: "invalid_request", message: "x" } })).toEqual(
      fail("agents.made.error.invalidAgent"),
    );
    expect(readCreateResult(403, { error: { code: "forbidden", message: "x" } })).toEqual(
      fail("agents.made.error.forbidden"),
    );
    expect(readCreateResult(500, { error: { code: "internal", message: "x" } })).toEqual(
      fail("agents.made.error.create"),
    );
  });

  it("refuses a success with no agent in it", () => {
    expect(readCreateResult(201, {})).toEqual(fail("agents.made.error.create"));
  });
});

describe("readDeleteResult", () => {
  it("parses a 200 into the deleted agent's id", () => {
    expect(readDeleteResult(200, { ok: true, agentId: "ag_1", chatsDeleted: 2, workspacesRemoved: 0 }, "ag_1")).toEqual(
      { ok: true, agentId: "ag_1" },
    );
  });

  it("maps each refusal to its own catalog copy", () => {
    expect(readDeleteResult(404, { error: { code: "not_found", message: "x" } }, "ag_1")).toEqual(
      fail("agents.made.error.notFound"),
    );
    expect(readDeleteResult(403, { error: { code: "forbidden", message: "x" } }, "ag_1")).toEqual(
      fail("agents.made.error.forbidden"),
    );
    expect(readDeleteResult(409, { error: { code: "not_deletable", message: "x" } }, "ag_1")).toEqual(
      fail("agents.made.error.notDeletable"),
    );
    expect(readDeleteResult(409, { error: { code: "agent_in_use", message: "x" } }, "ag_1")).toEqual(
      fail("agents.made.error.inUse"),
    );
    expect(readDeleteResult(500, { error: { code: "internal", message: "x" } }, "ag_1")).toEqual(
      fail("agents.made.error.delete"),
    );
  });
});

describe("made agent addresses", () => {
  it("builds the chat address that names the agent, with its thread when there is one", () => {
    expect(madeAgentHref("ag_1")).toBe("/chat?made=ag_1");
    expect(madeAgentHref("ag_1", "th_9")).toBe("/chat?made=ag_1&thread=th_9");
  });

  it("reads the agent id back, and null when the address names none", () => {
    expect(madeAgentIdFromSearch(new URLSearchParams("made=ag_1&thread=th_9"))).toBe("ag_1");
    expect(madeAgentIdFromSearch(new URLSearchParams("agent=research"))).toBeNull();
  });

  it("leaves the default agent unhighlighted on a made agent's chat, and highlights it otherwise", () => {
    expect(activeAgentId("/chat", new URLSearchParams("made=ag_1"))).toBeNull();
    expect(activeAgentId("/chat", new URLSearchParams(""))).toBe("chat");
  });
});

describe("the client's requests", () => {
  it("sends the prompt to the draft route and reads the draft back", async () => {
    mockedFetch.mockResolvedValue(json(200, { draft: DRAFT, source: "live" }));
    const result = await draftMadeAgent("Check invoices");
    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/v1/agents/draft",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "Check invoices" }) }),
    );
    expect(result).toEqual({ ok: true, answer: { draft: DRAFT, source: "live" } });
  });

  it("creates the agent from the draft fields the person kept", async () => {
    mockedFetch.mockResolvedValue(json(201, { agent: { id: "ag_1", name: "Invoice checker" } }));
    const result = await createMadeAgent({ ...DRAFT, tools: ["calculator"] });
    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/v1/agents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Invoice checker",
          description: "Checks invoices",
          instructions: "Compare each invoice with its order.",
          baseMode: "finance",
          tools: ["calculator"],
        }),
      }),
    );
    expect(result).toEqual({ ok: true, agent: { id: "ag_1", name: "Invoice checker" } });
  });

  it("deletes exactly one agent by its id, encoded in the path", async () => {
    mockedFetch.mockResolvedValue(json(200, { ok: true, agentId: "a/b", chatsDeleted: 0, workspacesRemoved: 0 }));
    const result = await deleteMadeAgent("a/b");
    expect(mockedFetch).toHaveBeenCalledWith("/api/v1/agents/a%2Fb", { method: "DELETE" });
    expect(result).toEqual({ ok: true, agentId: "a/b" });
  });

  it("reads the made agents from the chat list", async () => {
    mockedFetch.mockResolvedValue(
      json(200, {
        specialists: [{ id: "ag_1", name: "Invoices", description: "", madeFromPrompt: true, deletable: true }],
      }),
    );
    expect(await fetchMadeAgents()).toEqual([{ id: "ag_1", name: "Invoices", description: "", deletable: true }]);
    expect(mockedFetch).toHaveBeenCalledWith("/api/v1/chat");
  });

  it("answers a dropped connection with the draft copy, never a throw", async () => {
    mockedFetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await draftMadeAgent("Check invoices")).toEqual(fail("agents.made.error.draft"));
  });

  it("answers a dropped connection on delete with the delete copy", async () => {
    mockedFetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await deleteMadeAgent("ag_1")).toEqual(fail("agents.made.error.delete"));
  });
});
