import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELEGATED_RUN_RULES, type AgentRuntime, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

/**
 * Team bots end to end on a fresh data dir: the team routes hire and release them, `delegate`
 * resolves a `tb-` slug or a bot's name to the bot's own published prompt, and the roster line a
 * chat run's prompt gains names who may be asked. The runtime is the same recording stub the
 * delegation suite uses.
 */

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-team-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "e".repeat(64);
delete process.env.AGENTFORGE_SERVER;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

type ExecuteInput = Parameters<AgentRuntime["execute"]>[0];

const swap = vi.hoisted(() => ({ runtime: null as null | { execute: (input: unknown) => Promise<void> } }));

vi.mock("@agentforge/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentforge/core")>();
  return {
    ...actual,
    createRuntime: (...args: Parameters<typeof actual.createRuntime>) =>
      (swap.runtime as AgentRuntime | null) ?? actual.createRuntime(...args),
  };
});

let dispatch: (request: HostRequest) => Promise<HostResult>;
let tenant: TenantContext;
let chatAgentId = "";
let parentThreadId = "";

function request(method: string, path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method, path, query: {}, params: {}, headers: {}, ...extra };
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const result = await dispatch(request(method, path, { body, query }));
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result.body ?? {}) as T };
}

type Roster = { modes: string[]; bots: Array<{ id: string; slug: string; name: string; role: string }> };

async function newThread(agentId: string, title?: string): Promise<string> {
  const created = await call<{ thread: { id: string } }>("POST", "/api/v1/threads", { agentId, title });
  expect(created.status).toBe(201);
  return created.body.thread.id;
}

/** Runs a delegation the way a tool call inside a chat run would: in a run context, on a worker channel. */
async function delegateFrom(
  args: { agent: string; task: string; context?: string },
): Promise<Awaited<ReturnType<typeof import("./delegation/run-delegation").runDelegation>>> {
  const { runDelegation } = await import("./delegation/run-delegation");
  const { withRunContext } = await import("./run-context");
  const { withWorkerChannel } = await import("./workers/worker-channel");
  return withRunContext({ threadId: parentThreadId, agentId: chatAgentId, locale: "en" }, () =>
    withWorkerChannel({ emit: () => undefined }, () => runDelegation(args, tenant)),
  );
}

/** An asked run that works, answers and ends the way a model run does. Records what it was handed. */
function answeringRuntime(seen: ExecuteInput[], answer = "High tide is at 06:10."): void {
  swap.runtime = {
    async execute(input) {
      const run = input as ExecuteInput;
      seen.push(run);
      await run.onEvent({ type: "assistant.delta", text: answer });
      await run.onEvent({ type: "run.completed", runId: run.runId });
    },
  };
}

beforeAll(async () => {
  ({ dispatch } = await import("./router"));
  const { getTenant } = await import("./tenant");
  tenant = await getTenant();
  const desks = await call<{ currentWorkspaceId: string }>("GET", "/api/v1/workspaces");
  await call("PATCH", `/api/v1/workspaces/${desks.body.currentWorkspaceId}`, {
    productModes: ["chat", "research", "documents"],
  });
  const agents = await call<{ agents: Array<{ id: string; agentId: string | null }> }>("GET", "/api/v1/virtual-agents");
  chatAgentId = agents.body.agents.find((agent) => agent.id === "chat")?.agentId ?? "";
  expect(chatAgentId).not.toBe("");
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(async () => {
  swap.runtime = null;
  parentThreadId = await newThread(chatAgentId, "Parent");
  const { insertMessage } = await import("./threads");
  await insertMessage(tenant, parentThreadId, "user", [
    { type: "text", text: "When is high tide on Friday? See https://tides.example.org" },
  ]);
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the team routes", () => {
  it("hires bots and modes, answers the roster, and re-hiring the same set changes nothing", async () => {
    const hire = await call<Roster>("POST", "/api/v1/team/hire", {
      modes: ["legal"],
      bots: [
        { name: "Tide Analyst", role: "Reads tide tables", prompt: "You answer tide questions for the owner." },
        { name: "Chart Maker", role: "Draws simple charts", prompt: "You describe charts the owner can draw." },
      ],
    });
    expect(hire.status).toBe(200);
    // The roster lists delegatable modes only: the generalist (chat) is never one of them.
    expect(hire.body.modes).toEqual(expect.arrayContaining(["research", "documents", "legal"]));
    expect(hire.body.modes).not.toContain("chat");
    expect(hire.body.bots.map((bot) => bot.slug)).toEqual(["tb-tide-analyst", "tb-chart-maker"]);

    const again = await call<Roster>("POST", "/api/v1/team/hire", {
      bots: [{ name: "Tide Analyst", role: "Reads tide tables", prompt: "You answer tide questions for the owner." }],
    });
    expect(again.body.bots).toHaveLength(2);
    expect(again.body.bots.map((bot) => bot.slug)).toEqual(["tb-tide-analyst", "tb-chart-maker"]);
  });

  it("proposes deterministically when no model answers", async () => {
    const { body } = await call<{ brief: string; modes: string[]; bots: unknown[] }>(
      "POST",
      "/api/v1/team/propose",
      { brief: "research tide tables and write a report" },
    );
    expect(body.brief).toBe("research tide tables and write a report");
    expect(body.modes.length).toBeGreaterThan(0);
    expect(body.modes.length).toBeLessThanOrEqual(5);
    expect(body.bots.length).toBeGreaterThan(0);
    expect(body.bots.length).toBeLessThanOrEqual(3);
  });

  it("rejects a missing brief and an unknown release target", async () => {
    const bad = await call("POST", "/api/v1/team/propose", {});
    expect(bad.status).toBe(400);
    const missing = await call("POST", "/api/v1/team/release", { bot: "tb-nobody" });
    expect(missing.status).toBe(404);
    const chat = await call("POST", "/api/v1/team/release", { mode: "chat" });
    expect(chat.status).toBe(400);
  });
});

describe("resolveDelegatable", () => {
  it("resolves a mode id, a tb- slug and a bot name, and misses on the rest", async () => {
    const { resolveDelegatable } = await import("./team-bots");
    const mode = await resolveDelegatable(tenant, "research");
    expect(mode?.kind).toBe("mode");

    const bySlug = await resolveDelegatable(tenant, "tb-tide-analyst");
    expect(bySlug?.kind).toBe("bot");
    expect(bySlug?.kind === "bot" && bySlug.bot.name).toBe("Tide Analyst");

    const byName = await resolveDelegatable(tenant, "tide analyst");
    expect(byName?.kind).toBe("bot");

    expect(await resolveDelegatable(tenant, "tb-nobody")).toBeNull();
    expect(await resolveDelegatable(tenant, "finance")).toBeNull();
  });
});

describe("release", () => {
  it("tombstones a bot: it leaves the roster and stops resolving, and its row stays", async () => {
    const { listTeamBots } = await import("./team-bots");
    expect((await listTeamBots(tenant)).map((bot) => bot.slug)).toContain("tb-tide-analyst");

    const released = await call<Roster>("POST", "/api/v1/team/release", { bot: "tb-tide-analyst" });
    expect(released.status).toBe(200);
    expect(released.body.bots.map((bot) => bot.slug)).toEqual(["tb-chart-maker"]);

    const { resolveDelegatable } = await import("./team-bots");
    expect(await resolveDelegatable(tenant, "tb-tide-analyst")).toBeNull();
    // The row is still there for its conversations; only the live marker is gone.
    const { db } = await import("@agentforge/db");
    const { agents } = await import("@agentforge/db");
    const rows = await db.select().from(agents);
    expect(rows.some((row) => row.slug === "tb-tide-analyst")).toBe(true);
  });

  it("removes a hired mode from the desk", async () => {
    const released = await call<Roster>("POST", "/api/v1/team/release", { mode: "legal" });
    expect(released.status).toBe(200);
    expect(released.body.modes).not.toContain("legal");
    expect(released.body.modes).toEqual(expect.arrayContaining(["research", "documents"]));
  });
});

describe("delegating to a bot", () => {
  it("runs the bot's own prompt and tool set and returns its name", async () => {
    // Re-hire the released bot under a fresh slug; the tombstone keeps tb-tide-analyst.
    await call("POST", "/api/v1/team/hire", {
      bots: [{ name: "Tide Analyst", role: "Reads tide tables", prompt: "You answer tide questions for the owner." }],
    });
    const { listTeamBots } = await import("./team-bots");
    const bots = await listTeamBots(tenant);
    const slug = bots.find((bot) => bot.name === "Tide Analyst")?.slug ?? "";
    expect(slug).not.toBe("");

    const seen: ExecuteInput[] = [];
    answeringRuntime(seen);
    const result = await delegateFrom({ agent: slug, task: "When is high tide on Friday?" });

    expect(result).toMatchObject({ ok: true, agent: slug, agentName: "Tide Analyst", summary: "High tide is at 06:10." });
    expect(seen).toHaveLength(1);
    const run = seen[0] as ExecuteInput;
    expect(run.version.systemPrompt).toContain("You answer tide questions for the owner.");
    expect(run.version.systemPrompt).toContain(DELEGATED_RUN_RULES);
    const keys = run.bindings.map((binding) => binding.toolKey);
    for (const dropped of ["delegate", "image_generate", "video_generate"]) {
      expect(keys, dropped).not.toContain(dropped);
    }
    expect(keys).toContain("web_search");
    expect(run.egress?.tainted).toBe(true);
  });

  it("refuses an unknown agent and names who can be asked, bots included", async () => {
    const seen: ExecuteInput[] = [];
    answeringRuntime(seen);
    const result = await delegateFrom({ agent: "tb-ghost", task: "Do the thing please." });
    expect(result).toMatchObject({ ok: false, reason: "not_hired", agent: "tb-ghost" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("Tide Analyst");
    expect(message).toContain("Chart Maker");
    expect(seen).toHaveLength(0);
  });
});

describe("delegationTargetsLine", () => {
  it("is empty for an empty roster and names modes and bots otherwise", async () => {
    const { delegationTargetsLine } = await import("./team-bots");
    expect(delegationTargetsLine({ modes: [], bots: [] })).toBe("");
    const line = delegationTargetsLine({
      modes: ["research", "documents"],
      bots: [{ id: "b1", slug: "tb-x", name: "Analyst", role: "Reads briefs", description: "" }],
    });
    expect(line).toContain("Research");
    expect(line).toContain("Documents");
    expect(line).toContain("Analyst (Reads briefs)");
  });
});
