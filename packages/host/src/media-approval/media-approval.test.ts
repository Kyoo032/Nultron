import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { SESSION_COOKIE_SECURE } from "../auth/session";
import type { HostJsonResult, HostRequest, HostResult } from "../types";
import { PENDING_DESCRIPTION_SENTENCE } from "./constants";
import { withAttendedRun } from "./presence";

const gateState = vi.hoisted(() => ({ hostedOpen: true }));

vi.mock("../gateway-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway-gate")>();
  return {
    ...actual,
    requireGatewayAllowedFor: (...args: Parameters<typeof actual.requireGatewayAllowedFor>) =>
      gateState.hostedOpen
        ? ({
            status: "ok",
            allowed: true,
            grace: false,
            endpoint: "",
            endpointLocked: true,
            checkedAt: 0,
            lastOkAt: 0,
          } as never)
        : actual.requireGatewayAllowedFor(...args),
  };
});

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-media-approval-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;
process.env.AGENTFORGE_RUNTIME = "stub";

const PARTNER = "media-approval-partner";
const ORG_A = "media-approval-org-a";
const ORG_B = "media-approval-org-b";
const ALICE = "media-approval-alice";
const ANN = "media-approval-ann";
const BOB = "media-approval-bob";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

type Mods = typeof import("./gated-tools");
type Routes = typeof import("../router");

let gatedTools: Mods;
let router: Routes;
let sessionStore: import("../auth/session-store").SessionStore;
let alice: Person;
let ann: Person;
let bob: Person;
let threadId: string;
let agentId: string;
let sql: typeof import("@agentforge/db").sql;

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const { createSession } = await import("../auth/session");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(person: Person | null, method: string, path: string, body?: unknown): Promise<HostResult> {
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: person ? { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` } : {},
    ...(body === undefined ? {} : { body }),
  };
  return router.dispatch(request, { serverMode: true, sessionStore });
}

function callPersonal(method: string, path: string, body?: unknown): Promise<HostResult> {
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    headers: {},
    ...(body === undefined ? {} : { body }),
  };
  return router.dispatch(request, {});
}

function jsonOf(result: HostResult): { status: number; body: Record<string, unknown> } {
  expect(result.type).toBe("json");
  const json = result as HostJsonResult;
  return { status: json.status, body: json.body as Record<string, unknown> };
}

function codeOf(body: Record<string, unknown>): string | undefined {
  return (body.error as { code?: string } | undefined)?.code;
}

async function inChat<T>(fn: () => Promise<T>): Promise<T> {
  const { withRunContext } = await import("../run-context");
  const { withToolRun } = await import("../tool-run-context");
  return withAttendedRun(() =>
    withToolRun({ runId: "media-approval-run", mode: "chat" }, () =>
      withRunContext({ threadId, agentId, locale: "en" }, fn),
    ),
  );
}

async function pendingFor(prompt: string): Promise<{ proposalId: string; output: Record<string, unknown> }> {
  const output = (await inChat(() =>
    gatedTools.gatedImageGenerateTool().execute({ prompt } as never, alice.tenant),
  )) as Record<string, unknown>;
  expect(output.status).toBe("pending_approval");
  return { proposalId: String(output.proposalId), output };
}

function openGate(): void {
  process.env.AGENTFORGE_SERVER = "1";
  process.env.AGENTFORGE_SHELL = "enterprise";
}

function shutGate(): void {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_SHELL;
}

async function settle(run: () => Promise<unknown>): Promise<{ keys: string[] } | { error: string }> {
  try {
    const value = await run();
    return { keys: Object.keys((value ?? {}) as Record<string, unknown>).sort() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

beforeAll(async () => {
  gatedTools = await import("./gated-tools");
  router = await import("../router");
  const sessions = await import("../auth/session-store");
  sessionStore = sessions.createMemorySessionStore();
  const db = await import("@agentforge/db");
  sql = db.sql;
  openGate();
  alice = await provision(ORG_A, ALICE, "owner");
  ann = await provision(ORG_A, ANN, "member");
  bob = await provision(ORG_B, BOB, "owner");
  const { agentService } = await import("../tenant");
  const { createThread } = await import("../threads");
  const { listChatModels } = await import("@agentforge/core");
  const models = listChatModels();
  const agent = await agentService.create(
    alice.tenant,
    { name: "chat", systemPrompt: "chat", model: models[0].id },
    models,
  );
  agentId = agent.agent.id;
  const thread = await createThread(alice.tenant, agentId, "media");
  threadId = thread.id;
}, ROUTER_IMPORT_BUDGET_MS);

beforeEach(() => {
  process.env.AGENTFORGE_RUNTIME = "stub";
});

afterEach(() => {
  vi.restoreAllMocks();
  gateState.hostedOpen = true;
  openGate();
});

afterAll(async () => {
  const { sql: handle } = await import("@agentforge/db");
  handle.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("a paid picture asked for from a hosted chat", () => {
  it("returns pending_approval and makes no network call before Generate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const output = (await inChat(() =>
      gatedTools.gatedImageGenerateTool().execute({ prompt: "a red kite" } as never, alice.tenant),
    )) as Record<string, unknown>;
    expect(output).toMatchObject({
      ok: true,
      status: "pending_approval",
      kind: "image",
      prompt: "a red kite",
      estimate: { currency: "USD" },
    });
    expect(typeof output.proposalId).toBe("string");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is read back by its owner, and answers 404 to a member and to another company", async () => {
    const { proposalId } = await pendingFor("a blue boat");
    const own = jsonOf(await call(alice, "GET", `/api/v1/media/proposals/${proposalId}`));
    expect(own.status).toBe(200);
    expect(own.body.proposal).toMatchObject({ id: proposalId, kind: "image", status: "pending", threadId });
    expect(JSON.stringify(own.body)).not.toContain(ALICE);

    for (const stranger of [ann, bob]) {
      const refused = jsonOf(await call(stranger, "GET", `/api/v1/media/proposals/${proposalId}`));
      expect(refused.status).toBe(404);
      expect(codeOf(refused.body)).toBe("not_found");
      expect(JSON.stringify(refused.body)).not.toContain(proposalId);
    }
    const ghost = jsonOf(await call(alice, "GET", "/api/v1/media/proposals/00000000-0000-4000-8000-000000000000"));
    expect(ghost.status).toBe(404);
    expect(ghost.body).toEqual(jsonOf(await call(ann, "GET", `/api/v1/media/proposals/${proposalId}`)).body);
  });

  it("generates through the studio path only for its owner, and writes the picture into the thread", async () => {
    const { proposalId, output } = await pendingFor("a green tram");
    const { insertMessage, listMessages } = await import("../threads");
    await insertMessage(alice.tenant, threadId, "assistant", [
      { type: "tool_call", toolKey: "image_generate", status: "started", input: { prompt: "a green tram" }, output },
    ] as never);

    for (const stranger of [ann, bob]) {
      const refused = jsonOf(await call(stranger, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
      expect(refused.status).toBe(404);
    }

    const made = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(made.status).toBe(200);
    expect(made.body.proposal).toMatchObject({ id: proposalId, status: "generated" });
    expect(made.body.result).toMatchObject({ success: true, model: expect.any(String), prompt: "a green tram" });
    const image = String((made.body.result as { image?: string }).image ?? "");
    expect(image).toMatch(/^\/api\/v1\/media\/[^/]+\/file$/);

    const rows = await listMessages(alice.tenant, threadId);
    const holders = rows.filter((row) => JSON.stringify(row.content).includes(image));
    expect(holders).toHaveLength(1);
    const parts = holders[0].content as Array<{
      type: string;
      output?: { success?: boolean };
      image_url?: { url: string };
    }>;
    expect(parts.some((part) => part.type === "tool_call" && part.output?.success === true)).toBe(true);
    expect(parts.some((part) => part.type === "image_url" && part.image_url?.url === image)).toBe(true);
  });

  it("refuses a second Generate as not_pending", async () => {
    const { proposalId } = await pendingFor("a yellow bus");
    expect(jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {})).status).toBe(200);
    const again = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe("not_pending");
  });

  it("records a skip once, and a skipped card can no longer be generated", async () => {
    const { proposalId } = await pendingFor("a grey whale");
    const skipped = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/skip`));
    expect(skipped.status).toBe(200);
    expect(skipped.body.proposal).toMatchObject({ id: proposalId, status: "skipped" });

    const twice = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/skip`));
    expect(twice.status).toBe(409);
    expect(codeOf(twice.body)).toBe("not_pending");
    const late = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(late.status).toBe(409);
    expect(codeOf(late.body)).toBe("not_pending");
  });

  it("expires after 24 hours, for reading, generating and skipping", async () => {
    const { proposalId } = await pendingFor("a silver lamp");
    sql
      .prepare("UPDATE media_proposals SET created_at = created_at - ? WHERE id = ?")
      .run(25 * 60 * 60 * 1000, proposalId);

    const read = jsonOf(await call(alice, "GET", `/api/v1/media/proposals/${proposalId}`));
    expect(read.status).toBe(200);
    expect(read.body.proposal).toMatchObject({ status: "expired" });

    const generate = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(generate.status).toBe(409);
    expect(codeOf(generate.body)).toBe("expired");
    const skip = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/skip`));
    expect(skip.status).toBe(409);
    expect(codeOf(skip.body)).toBe("expired");
  });

  it("passes a closed gateway gate through as gateway_blocked and keeps the card pending", async () => {
    const { proposalId } = await pendingFor("a paper crane");
    gateState.hostedOpen = false;
    const blocked = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("gateway_blocked");
    const still = jsonOf(await call(alice, "GET", `/api/v1/media/proposals/${proposalId}`));
    expect(still.body.proposal).toMatchObject({ status: "pending" });
  });

  it("marks a video generation that the studio refuses as failed", async () => {
    const video = (await inChat(() =>
      gatedTools.gatedVideoGenerateTool().execute({ prompt: "a fox runs" } as never, alice.tenant),
    )) as Record<string, unknown>;
    expect(video.status).toBe("pending_approval");
    const proposalId = String(video.proposalId);
    const failed = jsonOf(await call(alice, "POST", `/api/v1/media/proposals/${proposalId}/generate`, {}));
    expect(failed.status).toBe(400);
    const read = jsonOf(await call(alice, "GET", `/api/v1/media/proposals/${proposalId}`));
    expect(read.body.proposal).toMatchObject({ kind: "video", status: "failed" });
  });
});

describe("always allow, per person and per kind", () => {
  it("stores the choice for each person and kind, and another company never reads it", async () => {
    const set = jsonOf(await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "image", allow: true }));
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ image: true, video: false });
    expect(jsonOf(await call(alice, "GET", "/api/v1/media/always-allow")).body).toEqual({ image: true, video: false });
    expect(jsonOf(await call(ann, "GET", "/api/v1/media/always-allow")).body).toEqual({ image: false, video: false });
    expect(jsonOf(await call(bob, "GET", "/api/v1/media/always-allow")).body).toEqual({ image: false, video: false });
    await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "image", allow: false });
  });

  it("rejects a body that is not a kind and a flag", async () => {
    const bad = jsonOf(await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "audio", allow: true }));
    expect(bad.status).toBe(400);
  });

  it("runs the tool at once when allowed, as today, and marks the result autoAllowed", async () => {
    await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "image", allow: true });
    try {
      const { imageGenerateTool } = await import("@agentforge/core");
      const direct = (await imageGenerateTool.execute({ prompt: "a row of pines" } as never, alice.tenant)) as Record<
        string,
        unknown
      >;
      const via = (await inChat(() =>
        gatedTools.gatedImageGenerateTool().execute({ prompt: "a row of pines" } as never, alice.tenant),
      )) as Record<string, unknown>;
      expect(via.autoAllowed).toBe(true);
      expect(via.status).toBeUndefined();
      expect(Object.keys(via).sort()).toEqual([...Object.keys(direct), "autoAllowed"].sort());
      expect(via.success).toBe(direct.success);
      expect(via.prompt).toBe(direct.prompt);
    } finally {
      await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "image", allow: false });
    }
  });

  it("denies paid media with nobody to ask unless always allow is on for that kind", async () => {
    const denied = (await gatedTools
      .gatedImageGenerateTool()
      .execute({ prompt: "a night sky" } as never, alice.tenant)) as Record<string, unknown>;
    expect(denied).toEqual({ ok: false, status: "denied", reason: "needs_person" });

    await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "video", allow: true });
    try {
      const imageStillDenied = (await gatedTools
        .gatedImageGenerateTool()
        .execute({ prompt: "a night sky" } as never, alice.tenant)) as Record<string, unknown>;
      expect(imageStillDenied).toEqual({ ok: false, status: "denied", reason: "needs_person" });
    } finally {
      await call(alice, "PUT", "/api/v1/media/always-allow", { kind: "video", allow: false });
    }
  });

  it("keeps the per-turn cap on paid pictures, pending or not", async () => {
    const { invokeToolGuarded, createToolBudget, virtualAgentFor } = await import("@agentforge/core");
    const budget = createToolBudget(virtualAgentFor("chat").budget);
    const tool = gatedTools.gatedImageGenerateTool();
    const results: Array<Record<string, unknown>> = [];
    await inChat(async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        results.push(
          (await invokeToolGuarded(tool, { prompt: `picture ${turn}` }, alice.tenant, budget)) as Record<
            string,
            unknown
          >,
        );
      }
    });
    expect(results.slice(0, 4).every((result) => result.status === "pending_approval")).toBe(true);
    const fifth = results[4];
    expect(fifth.status).not.toBe("pending_approval");
    expect(JSON.stringify(fifth)).toMatch(/Tool budget spent/);
  });

  it("keeps the proposal id and the estimate through the thinning and redaction a persisted tool call goes through", async () => {
    const { invokeToolGuarded } = await import("@agentforge/core");
    const { redactToolEvent } = await import("../chat-tool-events");
    const pending = (await inChat(() =>
      invokeToolGuarded(gatedTools.gatedImageGenerateTool(), { prompt: "a persisted kite" }, alice.tenant),
    )) as Record<string, unknown>;
    expect(pending).toMatchObject({ status: "pending_approval", estimate: { currency: "USD" } });
    expect(typeof pending.proposalId).toBe("string");
    const persisted = redactToolEvent({ type: "tool.completed", toolKey: "image_generate", output: pending } as never);
    expect(persisted).toMatchObject({
      output: { proposalId: pending.proposalId, status: "pending_approval", estimate: { currency: "USD" } },
    });
  });
});

describe("the default shell", () => {
  beforeEach(() => {
    shutGate();
  });

  it("gives the core tools' own name, description and schema, and the same outcome, with no proposal written", async () => {
    const { imageGenerateTool, videoGenerateTool } = await import("@agentforge/core");
    const { sql: handle } = await import("@agentforge/db");
    const before = handle.prepare("SELECT COUNT(*) AS n FROM media_proposals").get() as { n: number };

    const image = gatedTools.gatedImageGenerateTool();
    expect(image.name).toBe(imageGenerateTool.name);
    expect(image.description).toBe(imageGenerateTool.description);
    expect(image.schema).toBe(imageGenerateTool.schema);
    expect(await settle(() => image.execute({ prompt: "a plain bench" } as never, alice.tenant))).toEqual(
      await settle(() => imageGenerateTool.execute({ prompt: "a plain bench" } as never, alice.tenant)),
    );

    const video = gatedTools.gatedVideoGenerateTool();
    expect(video.description).toBe(videoGenerateTool.description);
    expect(await settle(() => video.execute({ prompt: "a plain bench" } as never, alice.tenant))).toEqual(
      await settle(() => videoGenerateTool.execute({ prompt: "a plain bench" } as never, alice.tenant)),
    );

    const after = handle.prepare("SELECT COUNT(*) AS n FROM media_proposals").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("answers the media routes with 404 not_found on a desk that is not the hosted shell", async () => {
    const probes = [
      jsonOf(await callPersonal("GET", "/api/v1/media/proposals/abc")),
      jsonOf(await callPersonal("POST", "/api/v1/media/proposals/abc/generate", {})),
      jsonOf(await callPersonal("POST", "/api/v1/media/proposals/abc/skip", {})),
      jsonOf(await callPersonal("GET", "/api/v1/media/always-allow")),
      jsonOf(await callPersonal("PUT", "/api/v1/media/always-allow", { kind: "image", allow: true })),
    ];
    for (const probe of probes) {
      expect(probe.status).toBe(404);
      expect(codeOf(probe.body)).toBe("not_found");
    }
  });

  it("stays off when the enterprise shell is set on a desk that is not the hosted server", async () => {
    process.env.AGENTFORGE_SHELL = "enterprise";
    const { imageGenerateTool } = await import("@agentforge/core");
    expect(gatedTools.gatedImageGenerateTool().description).toBe(imageGenerateTool.description);
  });

  it("leaves the registry entry for image_generate with core's description", async () => {
    const { getTool, imageGenerateTool } = await import("@agentforge/core");
    const { ensureToolsRegistered } = await import("../register-tools");
    ensureToolsRegistered();
    expect(getTool("image_generate")?.description).toBe(imageGenerateTool.description);
  });
});

describe("the tool chat reaches through the registry", () => {
  it("is the gated tool, and a chat call through the registry comes back as a pending card", async () => {
    const { getTool } = await import("@agentforge/core");
    const { ensureToolsRegistered } = await import("../register-tools");
    ensureToolsRegistered();
    const registered = getTool("image_generate");
    if (!registered) {
      throw new Error("image_generate is not in the registry");
    }
    expect(registered.description).toContain(PENDING_DESCRIPTION_SENTENCE);
    const output = (await inChat(() =>
      registered.execute({ prompt: "a registry kite" } as never, alice.tenant),
    )) as Record<string, unknown>;
    expect(output.status).toBe("pending_approval");
  });
});
