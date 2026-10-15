import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { virtualAgentFor, type PortalRole, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const gate = vi.hoisted(() => ({ open: true }));
const model = vi.hoisted(() => ({ reply: "" as string | Error, asked: [] as Array<Record<string, unknown>> }));

vi.mock("./gateway-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-gate")>();
  return {
    ...actual,
    requireGatewayAllowed: (...args: Parameters<typeof actual.requireGatewayAllowed>) =>
      gate.open ? undefined : actual.requireGatewayAllowed(...args),
  };
});

vi.mock("./job-regen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./job-regen")>();
  return {
    ...actual,
    collectJobAssistantText: async (options: Record<string, unknown>) => {
      model.asked.push(options);
      if (model.reply instanceof Error) {
        throw model.reply;
      }
      return model.reply;
    },
  };
});

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const WRAP_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

type Person = "owner" | "admin" | "alice" | "bob";
type Company = { readonly tenants: Record<Person, TenantContext> };

function hosted(on: boolean): void {
  vi.stubEnv("AGENTFORGE_SERVER", on ? "1" : "0");
  vi.stubEnv("AGENTFORGE_SECRETS_KEY", WRAP_KEY);
}

afterEach(() => {
  vi.unstubAllEnvs();
  gate.open = true;
  model.reply = "";
  model.asked.length = 0;
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

let sessions: ReturnType<typeof import("./auth/session-store").createMemorySessionStore> | undefined;
let company: Promise<Company> | undefined;

function theCompany(): Promise<Company> {
  company ??= seed();
  return company;
}

async function seed(): Promise<Company> {
  hosted(false);
  const dbm = await import("@agentforge/db");
  const roles: Array<[Person, PortalRole]> = [
    ["owner", "owner"],
    ["admin", "admin"],
    ["alice", "member"],
    ["bob", "member"],
  ];
  const tenants = {} as Record<Person, TenantContext>;
  for (const [person, role] of roles) {
    tenants[person] = await dbm.ensurePortalOwner(dbm.db, {
      tenantId: "tenant-pma",
      orgId: "org-pma",
      userId: `usr-pma-${person}`,
      role,
    });
  }
  return { tenants };
}

type Answer = { status: number; body: any };

async function call(person: Person, method: string, path: string, body?: unknown): Promise<Answer> {
  const c = await theCompany();
  const { dispatch } = await import("./router");
  const { createSession, sessionCookieName } = await import("./auth/session");
  const { createMemorySessionStore } = await import("./auth/session-store");
  const tenant = c.tenants[person];
  sessions ??= createMemorySessionStore();
  const session = createSession({
    tenantId: tenant.tenantId,
    orgId: tenant.organizationId,
    userId: tenant.userId,
    now: T0,
  });
  await sessions.create(session);
  hosted(true);
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${sessionCookieName({ secure: true })}=${session.id}` },
    body,
  };
  const result: HostResult = await dispatch(request, { serverMode: true, sessionStore: sessions, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result as HostJsonResult).body };
}

const BUDGET = ROUTER_IMPORT_BUDGET_MS;

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Contract reader",
    description: "Reads contracts",
    instructions: "You read contracts and list the risks.",
    baseMode: "chat",
    tools: ["calculator"],
    ...overrides,
  };
}

async function makeAgent(person: Person, overrides: Record<string, unknown> = {}): Promise<{ id: string; versionId: string }> {
  const answer = await call(person, "POST", "/api/v1/agents", draftBody(overrides));
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return { id: answer.body.agent.id, versionId: answer.body.version.id };
}

async function workspaceId(person: Person): Promise<string> {
  return (await theCompany()).tenants[person].workspaceId;
}

async function agentIdsFor(person: Person): Promise<string[]> {
  const list = await call(person, "GET", `/api/v1/workspaces/${await workspaceId(person)}/agents`);
  expect(list.status).toBe(200);
  return list.body.agents.map((agent: { id: string }) => agent.id);
}

describe("POST /api/v1/agents/draft", () => {
  it("answers 400 invalid_request when the prompt is missing, not a string, empty or only spaces", async () => {
    for (const body of [undefined, {}, { prompt: 7 }, { prompt: "" }, { prompt: "   \n " }]) {
      const answer = await call("alice", "POST", "/api/v1/agents/draft", body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.code).toBe("invalid_request");
    }
    expect(model.asked).toHaveLength(0);
  }, BUDGET);

  it("answers 400 for a 2001-character prompt and accepts exactly 2000", async () => {
    const tooLong = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "a".repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("invalid_request");

    model.reply = JSON.stringify(draftBody());
    const exact = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "a".repeat(2000) });
    expect(exact.status).toBe(200);
  }, BUDGET);

  it("answers the flat 403 gateway_blocked body on a hosted company with no key", async () => {
    gate.open = false;
    const answer = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "an agent that reads contracts" });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({
      error: "gateway_blocked",
      status: "needs_key",
      message: expect.any(String),
    });
    expect(model.asked).toHaveLength(0);
  }, BUDGET);

  it("answers 502 model_output_invalid for a reply that is not JSON, fails the schema, or names no mode", async () => {
    const replies = [
      "Sure, here is an agent for you.",
      JSON.stringify({ name: "", description: "", instructions: "x", baseMode: "chat" }),
      JSON.stringify(draftBody({ baseMode: "no-such-mode" })),
      JSON.stringify(draftBody({ instructions: "" })),
    ];
    for (const reply of replies) {
      model.reply = reply;
      const answer = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "an agent that reads contracts" });
      expect(answer.status, reply).toBe(502);
      expect(answer.body.error.code).toBe("model_output_invalid");
    }
  }, BUDGET);

  it("returns the draft from a fenced reply, keeps only tools of the chosen mode, and stores nothing", async () => {
    const before = await agentIdsFor("alice");
    model.reply = [
      "```json",
      JSON.stringify(draftBody({ tools: ["calculator", "run_sql", "no_such_tool", "calculator", "datetime"] })),
      "```",
    ].join("\n");
    const answer = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "  an agent that reads contracts  " });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      draft: {
        name: "Contract reader",
        description: "Reads contracts",
        instructions: "You read contracts and list the risks.",
        baseMode: "chat",
        tools: ["calculator", "datetime"],
      },
      source: "live",
    });
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]?.prompt).toBe("an agent that reads contracts");
    expect(await agentIdsFor("alice")).toEqual(before);
  }, BUDGET);

  it("keeps a Data tool when the draft's mode is data", async () => {
    model.reply = JSON.stringify(draftBody({ baseMode: "data", tools: ["run_sql", "calculator", "web_search"] }));
    const answer = await call("bob", "POST", "/api/v1/agents/draft", { prompt: "an agent that queries my tables" });
    expect(answer.status).toBe(200);
    expect(answer.body.draft.tools).toEqual(["run_sql", "calculator"]);
  }, BUDGET);

  it("answers 502 when the model call itself fails", async () => {
    const { ApiError } = await import("@agentforge/core");
    model.reply = new ApiError("generation_failed", "The model call failed.", 502);
    const answer = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "an agent that reads contracts" });
    expect(answer.status).toBe(502);
    expect(answer.body.error.code).toBe("generation_failed");
  }, BUDGET);
});

describe("POST /api/v1/agents", () => {
  it("lets a member make a private, published agent with exactly the tools sent", async () => {
    const answer = await call("alice", "POST", "/api/v1/agents", draftBody({ tools: ["datetime", "calculator"] }));
    expect(answer.status).toBe(201);
    const c = await theCompany();
    expect(answer.body.agent).toMatchObject({
      name: "Contract reader",
      description: "Reads contracts",
      visibility: "private",
      createdByUserId: c.tenants.alice.userId,
      workspaceId: c.tenants.alice.workspaceId,
    });
    expect(answer.body.agent.currentVersionId).toBe(answer.body.version.id);
    expect(answer.body.version).toMatchObject({
      version: 1,
      systemPrompt: "You read contracts and list the risks.",
      productModes: ["chat"],
      inputModalities: ["text", "image", "video"],
      config: { baseMode: "chat", madeFromPrompt: true },
    });
    expect(answer.body.tools).toEqual(["datetime", "calculator"]);

    const read = await call("alice", "GET", `/api/v1/agents/${answer.body.agent.id}`);
    expect(read.status).toBe(200);
    expect(read.body.publishedBindings.map((binding: { toolKey: string }) => binding.toolKey)).toEqual([
      "datetime",
      "calculator",
    ]);
  }, BUDGET);

  it("makes an agent with no tools", async () => {
    const answer = await call("bob", "POST", "/api/v1/agents", draftBody({ tools: [], description: undefined }));
    expect(answer.status).toBe(201);
    expect(answer.body.tools).toEqual([]);
    expect(answer.body.agent.description).toBe("");
  }, BUDGET);

  it("reads no visibility, model, productModes or config from the body", async () => {
    const answer = await call(
      "alice",
      "POST",
      "/api/v1/agents",
      draftBody({
        visibility: "workspace",
        model: "not-a-model",
        productModes: ["research"],
        config: { madeFromPrompt: false, baseMode: "legal" },
      }),
    );
    expect(answer.status).toBe(201);
    expect(answer.body.agent.visibility).toBe("private");
    expect(answer.body.version.productModes).toEqual(["chat"]);
    expect(answer.body.version.config).toEqual({ baseMode: "chat", madeFromPrompt: true });
    const visible = await call("bob", "GET", `/api/v1/agents/${answer.body.agent.id}`);
    expect(visible.status).toBe(404);
  }, BUDGET);

  it("answers 400 for a tool outside the mode, an unregistered tool, and out-of-range fields", async () => {
    const bad: Array<Record<string, unknown>> = [
      draftBody({ tools: ["run_sql"] }),
      draftBody({ tools: ["calculator", "no_such_tool"] }),
      draftBody({ name: "" }),
      draftBody({ name: "n".repeat(81) }),
      draftBody({ description: "d".repeat(201) }),
      draftBody({ instructions: "   " }),
      draftBody({ instructions: "i".repeat(6001) }),
      draftBody({ baseMode: "no-such-mode" }),
      draftBody({ tools: "calculator" }),
    ];
    const before = await agentIdsFor("alice");
    for (const body of bad) {
      const answer = await call("alice", "POST", "/api/v1/agents", body);
      expect(answer.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(answer.body.error.code).toBe("invalid_request");
    }
    expect(await agentIdsFor("alice")).toEqual(before);
  }, BUDGET);

  it("prefixes the slug with agent- when the name collides with Chat or a mode agent", async () => {
    const chat = await call("alice", "POST", "/api/v1/agents", draftBody({ name: "Quick Chat" }));
    const mode = await call("alice", "POST", "/api/v1/agents", draftBody({ name: "va-research" }));
    const plain = await call("alice", "POST", "/api/v1/agents", draftBody({ name: "Zebra helper" }));
    expect(chat.body.agent.slug).toBe("agent-quick-chat");
    expect(chat.body.agent.name).toBe("Quick Chat");
    expect(mode.body.agent.slug).toBe("agent-va-research");
    expect(plain.body.agent.slug).toBe("zebra-helper");
  }, BUDGET);
});

describe("who can open or change a private agent (server mode)", () => {
  it("answers 404 to everyone but the maker, the company owner and admin included", async () => {
    const mine = await makeAgent("alice", { name: "Private to Alice" });
    const base = `/api/v1/agents/${mine.id}`;
    const probes: Array<[string, string, unknown]> = [
      ["GET", base, undefined],
      ["GET", `${base}/capabilities`, undefined],
      ["GET", `${base}/threads`, undefined],
      ["POST", `${base}/tools`, { toolKey: "calculator" }],
      ["POST", `${base}/soul`, { systemPrompt: "changed" }],
      ["POST", `${base}/publish`, { versionId: mine.versionId }],
      ["POST", `${base}/product-modes`, { productModes: ["chat"] }],
      ["POST", `${base}/generate-defaults`, {}],
      ["POST", "/api/v1/threads", { agentId: mine.id }],
    ];
    for (const person of ["owner", "admin", "bob"] as const) {
      for (const [method, path, body] of probes) {
        const answer = await call(person, method, path, body);
        expect(answer.status, `${person} ${method} ${path}`).toBe(404);
        expect(JSON.stringify(answer.body), `${person} ${method} ${path}`).not.toContain("Private to Alice");
      }
    }
    for (const [method, path, body] of probes.slice(0, 3)) {
      expect((await call("alice", method, path, body)).status, `alice ${method} ${path}`).toBe(200);
    }
    expect((await call("alice", "POST", "/api/v1/threads", { agentId: mine.id })).status).toBe(201);
  }, BUDGET);

  it("keeps share to owner, admin or builder: a member gets 403, and a colleague's private agent is still 404 to the owner", async () => {
    const mine = await makeAgent("alice", { name: "Alice share probe" });
    const share = `/api/v1/agents/${mine.id}/share`;
    expect((await call("alice", "POST", share, { visibility: "workspace" })).status).toBe(403);
    expect((await call("bob", "POST", share, { visibility: "workspace" })).status).toBe(403);
    expect((await call("owner", "POST", share, { visibility: "workspace" })).status).toBe(404);
    const own = await makeAgent("owner", { name: "Owner share probe" });
    const shared = await call("owner", "POST", `/api/v1/agents/${own.id}/share`, { visibility: "workspace" });
    expect(shared.status).toBe(200);
    expect(shared.body.agent.visibility).toBe("workspace");
  }, BUDGET);

  it("lists only the caller's own private agents plus workspace ones, in both lists", async () => {
    const aliceOwn = await makeAgent("alice", { name: "Alice list probe" });
    const bobOwn = await makeAgent("bob", { name: "Bob list probe" });
    const open = await makeAgent("owner", { name: "Open list probe" });
    await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });

    const expectations: Array<[Person, string[], string[]]> = [
      ["alice", [aliceOwn.id, open.id], [bobOwn.id]],
      ["bob", [bobOwn.id, open.id], [aliceOwn.id]],
      ["owner", [open.id], [aliceOwn.id, bobOwn.id]],
      ["admin", [open.id], [aliceOwn.id, bobOwn.id]],
    ];
    for (const [person, sees, hidden] of expectations) {
      const ids = await agentIdsFor(person);
      for (const id of sees) {
        expect(ids, `${person} workspace list`).toContain(id);
      }
      for (const id of hidden) {
        expect(ids, `${person} workspace list`).not.toContain(id);
      }
      const chat = await call(person, "GET", "/api/v1/chat");
      expect(chat.status).toBe(200);
      const specialistIds = chat.body.specialists.map((agent: { id: string }) => agent.id);
      for (const id of sees) {
        expect(specialistIds, `${person} specialists`).toContain(id);
      }
      for (const id of hidden) {
        expect(specialistIds, `${person} specialists`).not.toContain(id);
      }
    }
  }, BUDGET);
});

describe("madeFromPrompt and deletable on both lists", () => {
  it("computes both flags on the host for each person", async () => {
    const aliceOwn = await makeAgent("alice", { name: "Alice flag probe" });
    const open = await makeAgent("owner", { name: "Open flag probe" });
    await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });

    const legacy = await call("owner", "POST", `/api/v1/workspaces/${await workspaceId("owner")}/agents`, {
      name: "Legacy flag probe",
      systemPrompt: "Help",
      model: (await call("owner", "GET", "/api/v1/chat")).body.defaultModel,
    });
    expect(legacy.status).toBe(201);
    await call("owner", "POST", `/api/v1/agents/${legacy.body.agent.id}/publish`, { versionId: legacy.body.version.id });
    await call("owner", "POST", `/api/v1/agents/${legacy.body.agent.id}/share`, { visibility: "workspace" });

    const expected: Record<Person, Record<string, { madeFromPrompt: boolean; deletable: boolean }>> = {
      alice: {
        [aliceOwn.id]: { madeFromPrompt: true, deletable: true },
        [open.id]: { madeFromPrompt: true, deletable: false },
        [legacy.body.agent.id]: { madeFromPrompt: false, deletable: false },
      },
      bob: {
        [open.id]: { madeFromPrompt: true, deletable: false },
        [legacy.body.agent.id]: { madeFromPrompt: false, deletable: false },
      },
      owner: {
        [open.id]: { madeFromPrompt: true, deletable: true },
        [legacy.body.agent.id]: { madeFromPrompt: false, deletable: true },
      },
      admin: {
        [open.id]: { madeFromPrompt: true, deletable: true },
        [legacy.body.agent.id]: { madeFromPrompt: false, deletable: true },
      },
    };
    for (const person of Object.keys(expected) as Person[]) {
      const list = await call(person, "GET", `/api/v1/workspaces/${await workspaceId(person)}/agents`);
      const chat = await call(person, "GET", "/api/v1/chat");
      for (const [id, flags] of Object.entries(expected[person])) {
        const row = list.body.agents.find((agent: { id: string }) => agent.id === id);
        expect(row, `${person} list ${id}`).toMatchObject(flags);
        const specialist = chat.body.specialists.find((agent: { id: string }) => agent.id === id);
        expect(specialist, `${person} specialists ${id}`).toMatchObject(flags);
      }
    }
  }, BUDGET);

  it("never marks Chat or a mode agent deletable", async () => {
    const c = await theCompany();
    const { ensureVirtualAgentRow } = await import("./virtual-agents");
    const modeRow = await ensureVirtualAgentRow(c.tenants.owner, virtualAgentFor("research"));
    const list = await call("owner", "GET", `/api/v1/workspaces/${c.tenants.owner.workspaceId}/agents`);
    const chatRow = list.body.agents.find((agent: { slug: string }) => agent.slug === "quick-chat");
    const modeListed = list.body.agents.find((agent: { id: string }) => agent.id === modeRow.id);
    expect(chatRow).toMatchObject({ madeFromPrompt: false, deletable: false });
    expect(modeListed).toMatchObject({ madeFromPrompt: false, deletable: false });
  }, BUDGET);
});

describe("DELETE /api/v1/agents/:agentId", () => {
  async function seedChats(person: Person, agentId: string): Promise<{ threadId: string; messageId: string; runId: string }> {
    const { db, messages, runs, threads, agentVersions } = await import("@agentforge/db");
    const { eq } = await import("drizzle-orm");
    const c = await theCompany();
    const tenant = c.tenants[person];
    const { createThread } = await import("./threads");
    const thread = await createThread(tenant, agentId, "Chat with the doomed agent");
    const [message] = await db
      .insert(messages)
      .values({ organizationId: tenant.organizationId, threadId: thread.id, role: "user", content: [{ type: "text", text: "hi" }] })
      .returning();
    const [version] = await db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId));
    const [run] = await db
      .insert(runs)
      .values({
        organizationId: tenant.organizationId,
        threadId: thread.id,
        agentVersionId: version!.id,
        modality: "text",
        status: "completed",
      })
      .returning();
    expect(await db.select().from(threads).where(eq(threads.id, thread.id))).toHaveLength(1);
    return { threadId: thread.id, messageId: message!.id, runId: run!.id };
  }

  async function rowsOf(table: "agents" | "agent_versions" | "agent_tool_bindings" | "threads" | "messages" | "runs", id: string): Promise<number> {
    const { sql } = await import("@agentforge/db");
    const column: Record<string, string> = {
      agents: "id",
      agent_versions: "agent_id",
      agent_tool_bindings: "agent_version_id",
      threads: "id",
      messages: "id",
      runs: "id",
    };
    const row = sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column[table]} = ?`).get(id) as { n: number };
    return row.n;
  }

  it("lets the maker delete: 200 with counts, and their chats, messages and runs are gone", async () => {
    const doomed = await makeAgent("alice", { name: "Doomed by maker", tools: ["calculator", "datetime"] });
    const mine = await seedChats("alice", doomed.id);
    const defaultChat = (await call("alice", "GET", "/api/v1/chat")).body.agent.id as string;
    const keptByAlice = await seedChats("alice", defaultChat);
    const keptByBob = await seedChats("bob", defaultChat);

    const answer = await call("alice", "DELETE", `/api/v1/agents/${doomed.id}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, agentId: doomed.id, chatsDeleted: 1, workspacesRemoved: 0 });

    expect(await rowsOf("agents", doomed.id)).toBe(0);
    expect(await rowsOf("agent_versions", doomed.id)).toBe(0);
    expect(await rowsOf("agent_tool_bindings", doomed.versionId)).toBe(0);
    expect(await rowsOf("threads", mine.threadId)).toBe(0);
    expect(await rowsOf("messages", mine.messageId)).toBe(0);
    expect(await rowsOf("runs", mine.runId)).toBe(0);
    for (const kept of [keptByAlice, keptByBob]) {
      expect(await rowsOf("threads", kept.threadId)).toBe(1);
      expect(await rowsOf("messages", kept.messageId)).toBe(1);
      expect(await rowsOf("runs", kept.runId)).toBe(1);
    }
    expect((await call("alice", "GET", `/api/v1/agents/${doomed.id}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `/api/v1/agents/${doomed.id}`)).status).toBe(404);
  }, BUDGET);

  it("lets the company owner and an admin delete a colleague's private agent without opening it", async () => {
    for (const person of ["owner", "admin"] as const) {
      const theirs = await makeAgent("bob", { name: `Bob's, deleted by ${person}` });
      const chats = await seedChats("bob", theirs.id);
      expect((await call(person, "GET", `/api/v1/agents/${theirs.id}`)).status).toBe(404);
      const answer = await call(person, "DELETE", `/api/v1/agents/${theirs.id}`);
      expect(answer.status, person).toBe(200);
      expect(answer.body).toEqual({ ok: true, agentId: theirs.id, chatsDeleted: 1, workspacesRemoved: 0 });
      expect(await rowsOf("agents", theirs.id)).toBe(0);
      expect(await rowsOf("threads", chats.threadId)).toBe(0);
    }
  }, BUDGET);

  it("answers a member 404 for a colleague's private agent and deletes nothing", async () => {
    const theirs = await makeAgent("alice", { name: "Alice keeps this" });
    const answer = await call("bob", "DELETE", `/api/v1/agents/${theirs.id}`);
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe("not_found");
    expect(await rowsOf("agents", theirs.id)).toBe(1);
    const ghost = await call("bob", "DELETE", "/api/v1/agents/no-such-agent");
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual(answer.body);
  }, BUDGET);

  it("answers a member 403 for a workspace agent made by someone else", async () => {
    const open = await makeAgent("owner", { name: "Open for all" });
    await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });
    const answer = await call("bob", "DELETE", `/api/v1/agents/${open.id}`);
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe("forbidden");
    expect(await rowsOf("agents", open.id)).toBe(1);
  }, BUDGET);

  it("answers 409 agent_in_use when another person has a chat with a workspace agent, and removes nothing", async () => {
    const open = await makeAgent("owner", { name: "In use by Bob" });
    await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });
    const bobs = await seedChats("bob", open.id);
    const ownersOwn = await seedChats("owner", open.id);

    const answer = await call("owner", "DELETE", `/api/v1/agents/${open.id}`);
    expect(answer.status).toBe(409);
    expect(answer.body.error.code).toBe("agent_in_use");
    expect(await rowsOf("agents", open.id)).toBe(1);
    expect(await rowsOf("threads", bobs.threadId)).toBe(1);
    expect(await rowsOf("threads", ownersOwn.threadId)).toBe(1);
  }, BUDGET);

  it("deletes a workspace agent that only its maker has chatted with", async () => {
    const open = await makeAgent("owner", { name: "Only the owner used it" });
    await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });
    const mine = await seedChats("owner", open.id);
    const answer = await call("admin", "DELETE", `/api/v1/agents/${open.id}`);
    expect(answer.status).toBe(200);
    expect(answer.body.chatsDeleted).toBe(1);
    expect(await rowsOf("threads", mine.threadId)).toBe(0);
  }, BUDGET);

  it("answers 409 not_deletable for the default chat and for a mode agent", async () => {
    const c = await theCompany();
    const { ensureVirtualAgentRow } = await import("./virtual-agents");
    const chatId = (await call("alice", "GET", "/api/v1/chat")).body.agent.id as string;
    const modeRow = await ensureVirtualAgentRow(c.tenants.alice, virtualAgentFor("research"));
    expect(modeRow.slug).toBe("va-research");

    for (const [person, id] of [
      ["alice", chatId],
      ["owner", chatId],
      ["alice", modeRow.id],
      ["owner", modeRow.id],
    ] as const) {
      const answer = await call(person, "DELETE", `/api/v1/agents/${id}`);
      expect(answer.status, `${person} ${id}`).toBe(409);
      expect(answer.body.error.code).toBe("not_deletable");
    }
    expect(await rowsOf("agents", chatId)).toBe(1);
    expect(await rowsOf("agents", modeRow.id)).toBe(1);
  }, BUDGET);

  it("takes the agent out of every Workspace it was brought into and counts them", async () => {
    const { sql } = await import("@agentforge/db");
    const doomed = await makeAgent("alice", { name: "Brought into two workspaces" });
    const c = await theCompany();
    const now = Date.now();
    const projectIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const projectId of projectIds) {
      sql
        .prepare(
          `INSERT INTO projects (id, organization_id, workspace_id, name, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'Probe', ?, ?, ?)`,
        )
        .run(projectId, c.tenants.alice.organizationId, c.tenants.alice.workspaceId, c.tenants.alice.userId, now, now);
      sql
        .prepare(`INSERT INTO project_agents (project_id, agent_id, brought_by, added_at) VALUES (?, ?, ?, ?)`)
        .run(projectId, doomed.id, c.tenants.alice.userId, now);
    }
    const answer = await call("alice", "DELETE", `/api/v1/agents/${doomed.id}`);
    expect(answer.status).toBe(200);
    expect(answer.body.workspacesRemoved).toBe(2);
    const left = sql.prepare("SELECT count(*) AS n FROM project_agents WHERE agent_id = ?").get(doomed.id) as { n: number };
    expect(left.n).toBe(0);
  }, BUDGET);
});

describe("what a member can do to their own prompt-made agent (SR-182)", () => {
  it("refuses a member the older tool, soul, publish, product-modes and generate-defaults routes", async () => {
    const mine = await makeAgent("alice", { name: "Member locked", tools: ["calculator"] });
    const refused: Array<[string, string, unknown]> = [
      ["POST", `/api/v1/agents/${mine.id}/tools`, { toolKey: "music_generate" }],
      ["POST", `/api/v1/agents/${mine.id}/tools`, { toolKey: "calculator" }],
      ["POST", `/api/v1/agents/${mine.id}/soul`, { toolKeys: ["music_generate", "no_such_tool"] }],
      ["POST", `/api/v1/agents/${mine.id}/soul`, { systemPrompt: "new" }],
      ["POST", `/api/v1/agents/${mine.id}/product-modes`, { productModes: ["chat", "music"] }],
      ["POST", `/api/v1/agents/${mine.id}/generate-defaults`, { imageGenModel: "x" }],
    ];
    for (const [method, path, body] of refused) {
      const answer = await call("alice", method, path, body);
      expect(answer.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(403);
    }
    const read = await call("alice", "GET", `/api/v1/agents/${mine.id}`);
    expect(read.body.publishedBindings.map((binding: { toolKey: string }) => binding.toolKey)).toEqual(["calculator"]);
  }, BUDGET);

  it("answers a member 403 on the older workspace create, for any body, and stores nothing", async () => {
    const before = await agentIdsFor("alice");
    const wid = await workspaceId("alice");
    for (const body of [
      { name: "Sneaky", systemPrompt: "x", productModes: ["music"], config: { madeFromPrompt: false } },
      { name: 7, systemPrompt: "x" },
      {},
    ]) {
      const answer = await call("alice", "POST", `/api/v1/workspaces/${wid}/agents`, body);
      expect(answer.status, JSON.stringify(body)).toBe(403);
    }
    expect(await agentIdsFor("alice")).toEqual(before);
  }, BUDGET);

  it("answers an owner 400, not 500, for a non-string name on the older create", async () => {
    const wid = await workspaceId("owner");
    const answer = await call("owner", "POST", `/api/v1/workspaces/${wid}/agents`, { name: 7, systemPrompt: "x" });
    expect(answer.status).toBe(400);
  }, BUDGET);

  it("keeps the older routes for an owner: bind on an agent they built, and refuses a tool outside the mode on a prompt-made one", async () => {
    const wid = await workspaceId("owner");
    const built = await call("owner", "POST", `/api/v1/workspaces/${wid}/agents`, {
      name: "Owner built",
      systemPrompt: "x",
    });
    expect(built.status).toBe(201);
    const bind = await call("owner", "POST", `/api/v1/agents/${built.body.agent.id}/tools`, { toolKey: "music_generate" });
    expect(bind.status).toBe(201);
    const published = await call("owner", "POST", `/api/v1/agents/${built.body.agent.id}/publish`, {
      versionId: built.body.version.id,
    });
    expect(published.status).toBe(200);
    const revise = await call("owner", "POST", `/api/v1/agents/${built.body.agent.id}/soul`, { systemPrompt: "y" });
    expect(revise.status).toBe(200);

    const promptMade = await makeAgent("owner", { name: "Owner prompt-made", tools: ["calculator"] });
    const outside = await call("owner", "POST", `/api/v1/agents/${promptMade.id}/tools`, { toolKey: "music_generate" });
    expect(outside.status).toBe(400);
    const outsideSoul = await call("owner", "POST", `/api/v1/agents/${promptMade.id}/soul`, {
      toolKeys: ["calculator", "music_generate"],
    });
    expect(outsideSoul.status).toBe(400);
    const inside = await call("owner", "POST", `/api/v1/agents/${promptMade.id}/tools`, { toolKey: "datetime" });
    expect(inside.status).toBe(201);
  }, BUDGET);

  it("still lets a member make an agent and open a chat with it", async () => {
    const mine = await makeAgent("alice", { name: "Member chat", tools: ["calculator"] });
    const thread = await call("alice", "POST", "/api/v1/threads", { agentId: mine.id });
    expect(thread.status).toBe(201);
  }, BUDGET);

  it("answers the busy error on the draft when the company is at its run cap, and calls no model", async () => {
    const { admitRun } = await import("./run-limits");
    const c = await theCompany();
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    vi.stubEnv("AGENTFORGE_MAX_RUNS_PER_TENANT", "1");
    const held = admitRun(c.tenants.alice);
    try {
      model.reply = JSON.stringify(draftBody());
      const answer = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "an agent" });
      expect(answer.status).toBe(429);
      expect(answer.body.error.code).toBe("too_many_runs");
      expect(model.asked).toHaveLength(0);
    } finally {
      held();
    }
    const after = await call("alice", "POST", "/api/v1/agents/draft", { prompt: "an agent" });
    expect(after.status).toBe(200);
    expect(model.asked).toHaveLength(1);
  }, BUDGET);

  it("rolls the agent back when publishing fails: 500, and no row is left in the count or the list", async () => {
    const { sql } = await import("@agentforge/db");
    const { agentService } = await import("./tenant");
    const count = () => (sql.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }).n;
    const listBefore = await agentIdsFor("alice");
    const countBefore = count();
    const spy = vi.spyOn(agentService, "publish").mockRejectedValueOnce(new Error("boom"));
    try {
      const answer = await call("alice", "POST", "/api/v1/agents", draftBody({ name: "Rolled back" }));
      expect(answer.status).toBe(500);
      expect(answer.body.error).toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(count()).toBe(countBefore);
    expect(await agentIdsFor("alice")).toEqual(listBefore);
  }, BUDGET);
});

describe("DELETE of a private agent with a colleague's older thread (SR-182)", () => {
  it("deletes a private agent whose thread is by an admin, with that thread, and still refuses a workspace agent in use", async () => {
    const { sql } = await import("@agentforge/db");
    const { createThread } = await import("./threads");
    const c = await theCompany();
    const mine = await makeAgent("alice", { name: "Private with stray thread" });
    const stray = await createThread(c.tenants.admin, mine.id, "Stray");
    const own = await createThread(c.tenants.alice, mine.id, "Own");
    const threadRows = (id: string) =>
      (sql.prepare("SELECT count(*) AS n FROM threads WHERE id = ?").get(id) as { n: number }).n;
    expect(threadRows(stray.id)).toBe(1);

    const answer = await call("alice", "DELETE", `/api/v1/agents/${mine.id}`);
    expect(answer.status).toBe(200);
    expect(answer.body.chatsDeleted).toBe(2);
    expect(threadRows(stray.id)).toBe(0);
    expect(threadRows(own.id)).toBe(0);

    const open = await makeAgent("owner", { name: "Workspace in use" });
    const shared = await call("owner", "POST", `/api/v1/agents/${open.id}/share`, { visibility: "workspace" });
    expect(shared.status).toBe(200);
    const bobs = await createThread(c.tenants.bob, open.id, "Bob's");
    const refused = await call("owner", "DELETE", `/api/v1/agents/${open.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("agent_in_use");
    expect(threadRows(bobs.id)).toBe(1);
  }, BUDGET);
});
