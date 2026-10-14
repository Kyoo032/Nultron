/**
 * A Workspace works like a Claude project (team-board-spec.md section 2b, W1; K-D19, K-D20). Its files
 * are knowledge, its instructions go into the chat's system prompt, and a chat started in it searches
 * its knowledge and the person's own, never another Workspace's. Real router, real sessions, real
 * database, server mode on.
 *
 * Company A: Alice (owner, the maker, A1) and Ann (member, A2). Company B: Bob (owner, B1). Every refusal
 * is paired with the maker's or a member's success at the same call, so a server that refused everyone
 * would fail.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-workspace-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
// Hosted, like production: the gate reads the saved key and the verdict, and the verdict needs the gateway's
// models answer, which `beforeAll` stubs below. No stub runtime, so a closed gate is a real closed gate.
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "projects-workspace-partner";
const PHRASE = "zebra ledger reconciliation 4411";
const INSTRUCTIONS = "Answer in short sentences and cite the ledger file.";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ann: Person;
let bob: Person;

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(
  person: Person,
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  files?: HostRequest["files"],
): Promise<HostResult> {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query: {},
    params,
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...(body === undefined ? {} : { body }),
    ...(files === undefined ? {} : { files }),
  };
  return dispatch(request, { serverMode: true, sessionStore });
}

function statusOf(result: HostResult): number {
  return result.status;
}

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

const NOT_FOUND = 404;

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return jsonBody<{ project: { id: string } }>(result).project.id;
}

function markdownUpload(text: string, filename = "ledger.md"): HostRequest["files"] {
  return [{ field: "file", filename, mime: "text/markdown", bytes: new TextEncoder().encode(text) }];
}

async function chatAgentId(person: Person): Promise<string> {
  const chat = await call(person, "GET", "/api/v1/chat");
  return jsonBody<{ agent: { id: string } }>(chat).agent.id;
}

async function makeThread(person: Person, projectId?: string): Promise<{ id: string; projectId: string | null }> {
  const agentId = await chatAgentId(person);
  const result = await call(person, "POST", "/api/v1/threads", {}, projectId ? { agentId, projectId } : { agentId });
  expect(result.status).toBe(201);
  const thread = jsonBody<{ thread: { id: string; projectId: string | null } }>(result).thread;
  return { id: thread.id, projectId: thread.projectId };
}

type KnowledgeItem = { id: string; name: string; addedBy: string | null; status: string };

async function knowledgeNames(person: Person, projectId: string): Promise<string[]> {
  const result = await call(person, "GET", "/api/v1/projects/:id/knowledge", { id: projectId });
  return jsonBody<{ items: KnowledgeItem[] }>(result).items.map((item) => item.name);
}

/** The Workspace chat's prompt context: its knowledge block, through the same call a run makes. */
async function injectedFor(person: Person, projectId: string | null): Promise<string> {
  const { knowledgeInjection } = await import("./knowledge");
  const injected = await knowledgeInjection(person.tenant, PHRASE, { projectId });
  return injected.prompt;
}

/** What `knowledge_search` returns inside a run whose thread belongs to `projectId`. */
async function searchFor(person: Person, projectId: string | null, threadId: string): Promise<string[]> {
  const { withRunContext } = await import("./run-context");
  const { searchKnowledge } = await import("./knowledge-search-tool");
  const output = await withRunContext({ threadId, agentId: "agent", locale: "en", projectId }, () =>
    searchKnowledge(person.tenant, PHRASE, 4),
  );
  return "results" in output ? output.results.map((hit) => hit.title) : [];
}

describe("a Workspace: files, knowledge, instructions and chats, two companies", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-a", "alice", "owner");
    ann = await provision("org-a", "ann", "member");
    bob = await provision("org-b", "bob", "owner");
    // Uploads and knowledge search reach the gateway, so a closed gate would refuse them. Saving a key runs a
    // live check; the gateway's models answer is stubbed to accept it, as the hosted locale test does. Settings
    // are the owner's to write (a member gets 403), and the desk's gate is shared by its members.
    vi.stubGlobal("fetch", async (url: unknown) => {
      const text = String(url);
      if (/\/models(\?|$)/.test(text) && !text.includes("models.dev")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 500 });
    });
    for (const person of [alice, bob]) {
      const saved = await call(
        person,
        "POST",
        "/api/v1/settings",
        {},
        { openaiApiKey: "sk-workspace-test-aaaaaaaaaaaaaaaa" },
      );
      expect(statusOf(saved)).toBe(200);
    }
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a private Workspace is its maker's: no file, knowledge, chat or instruction reaches a colleague", async () => {
    const project = await makeProject(alice, "Ledger desk");
    const set = await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { instructions: INSTRUCTIONS });
    expect(statusOf(set)).toBe(200);
    expect(jsonBody<{ project: { instructions: string } }>(set).project.instructions).toBe(INSTRUCTIONS);

    const upload = await call(
      alice,
      "POST",
      "/api/v1/projects/:id/uploads",
      { id: project },
      undefined,
      markdownUpload(`${PHRASE} for the quarter.`),
    );
    expect(statusOf(upload)).toBe(201);

    // The maker's own knowledge answer, the positive control for everything below.
    expect(await knowledgeNames(alice, project)).toEqual(["ledger.md"]);
    expect(await injectedFor(alice, project)).toContain(PHRASE);

    expect(statusOf(await call(ann, "GET", "/api/v1/projects/:id/knowledge", { id: project }))).toBe(NOT_FOUND);
    expect(statusOf(await call(ann, "GET", "/api/v1/projects/:id/threads", { id: project }))).toBe(NOT_FOUND);
    expect(statusOf(await call(ann, "PATCH", "/api/v1/projects/:id", { id: project }, { instructions: "x" }))).toBe(
      NOT_FOUND,
    );
    expect(await injectedFor(ann, project)).not.toContain(PHRASE);
    // A chat cannot be started in a Workspace the caller cannot see: the same 404 as an unknown id.
    expect(
      statusOf(await call(ann, "POST", "/api/v1/threads", {}, { agentId: await chatAgentId(ann), projectId: project })),
    ).toBe(NOT_FOUND);
  });

  it("flipped to workspace, a colleague's Workspace chat gets the file and the instructions; outside chats do not", async () => {
    const project = await makeProject(alice, "Shared ledger desk");
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { instructions: INSTRUCTIONS });
    expect(
      statusOf(
        await call(
          alice,
          "POST",
          "/api/v1/projects/:id/uploads",
          { id: project },
          undefined,
          markdownUpload(`${PHRASE} shared.`, "shared.md"),
        ),
      ),
    ).toBe(201);
    expect(
      statusOf(await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" })),
    ).toBe(200);

    expect(await knowledgeNames(ann, project)).toEqual(["shared.md"]);
    const annKnowledge = await call(ann, "GET", "/api/v1/projects/:id/knowledge", { id: project });
    expect(jsonBody<{ items: KnowledgeItem[] }>(annKnowledge).items[0]?.addedBy).toBe("alice");

    const annChat = await makeThread(ann, project);
    expect(annChat.projectId).toBe(project);
    expect(await searchFor(ann, project, annChat.id)).toContain("shared.md");
    expect(await injectedFor(ann, project)).toContain(PHRASE);

    // The same colleague, a chat outside the Workspace: no Workspace file, no Workspace instruction.
    const outside = await makeThread(ann);
    expect(outside.projectId).toBeNull();
    expect(await searchFor(ann, null, outside.id)).not.toContain("shared.md");
    expect(await injectedFor(ann, null)).not.toContain(PHRASE);

    // Another Workspace's chat does not search this one's files either.
    const other = await makeProject(ann, "Ann's own desk");
    expect(await injectedFor(ann, other)).not.toContain(PHRASE);

    // Bob, of another company, still sees nothing.
    expect(statusOf(await call(bob, "GET", "/api/v1/projects/:id/knowledge", { id: project }))).toBe(NOT_FOUND);
    expect(await injectedFor(bob, project)).not.toContain(PHRASE);
  });

  it("flipped back to private, the colleague's Workspace chat loses the file again", async () => {
    const project = await makeProject(alice, "Flip ledger desk");
    await call(
      alice,
      "POST",
      "/api/v1/projects/:id/uploads",
      { id: project },
      undefined,
      markdownUpload(`${PHRASE} flip.`, "flip.md"),
    );
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });
    const annChat = await makeThread(ann, project);
    expect(await searchFor(ann, project, annChat.id)).toContain("flip.md");

    expect(
      statusOf(await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "private" })),
    ).toBe(200);
    expect(statusOf(await call(ann, "GET", "/api/v1/projects/:id/knowledge", { id: project }))).toBe(NOT_FOUND);
    expect(await searchFor(ann, project, annChat.id)).not.toContain("flip.md");
    expect(await injectedFor(ann, project)).not.toContain(PHRASE);
    // The maker keeps her own file and her own chat.
    expect(await knowledgeNames(alice, project)).toEqual(["flip.md"]);
  });

  it("a chat file added to the Workspace is indexed, and detached again when removed", async () => {
    const { artifactStore } = await import("./artifacts");
    const project = await makeProject(alice, "Chat file desk");
    const artifact = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "chat-ledger-note",
      mime: "text/markdown",
      body: `# Note\n\n${PHRASE} from chat.`,
      meta: {},
    });
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });

    expect(
      statusOf(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: artifact.id })),
    ).toBe(200);
    expect(await knowledgeNames(ann, project)).toContain("chat-ledger-note");
    expect(await injectedFor(ann, project)).toContain(PHRASE);

    expect(
      statusOf(
        await call(alice, "DELETE", "/api/v1/projects/:id/files/:artifactId", { id: project, artifactId: artifact.id }),
      ),
    ).toBe(200);
    expect(await knowledgeNames(ann, project)).not.toContain("chat-ledger-note");
    expect(await injectedFor(ann, project)).not.toContain(PHRASE);
  });

  it("a chat belongs to its person: the Workspace lists each person's own threads only", async () => {
    const project = await makeProject(alice, "Threads desk");
    await call(alice, "PATCH", "/api/v1/projects/:id", { id: project }, { visibility: "workspace" });
    const annThread = await makeThread(ann, project);
    const aliceThread = await makeThread(alice, project);

    const annList = jsonBody<{ items: Array<{ id: string }> }>(
      await call(ann, "GET", "/api/v1/projects/:id/threads", { id: project }),
    );
    expect(annList.items.map((item) => item.id)).toEqual([annThread.id]);
    const aliceList = jsonBody<{ items: Array<{ id: string }> }>(
      await call(alice, "GET", "/api/v1/projects/:id/threads", { id: project }),
    );
    expect(aliceList.items.map((item) => item.id)).toEqual([aliceThread.id]);
  });
});
