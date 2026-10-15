/**
 * A Workspace is shared with its members, never the whole company (team-board-spec.md section 2b, K-D22, K-D23;
 * SR-178). Real router, real sessions, real database, server mode on.
 *
 * Four people. Company 1: Alice (A, company owner, makes the Workspace), Ben (B, a member she invites) and Cara
 * (C, a company admin who is never invited). Company 2: Dan (D, its owner). B reads everything A put in; C and D
 * get the same 404 an unknown id gets, on every route. Each refusal is paired with a success at the same call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-projects-members-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "projects-members-partner";
const MISSING = "00000000-0000-4000-8000-000000000000";
const PHRASE = "heron quarterly forecast 7723";
const PNG = Buffer.from("fake-png-bytes-for-a-members-test");

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ben: Person;
let cara: Person;
let dan: Person;

async function provision(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member",
  name: string | null = null,
): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role, name });
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
): Promise<HostResult> {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query: {},
    params,
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...(body === undefined ? {} : { body }),
  };
  return dispatch(request, { serverMode: true, sessionStore });
}

async function outcome(result: HostResult): Promise<{ status: number; code?: string }> {
  if (result.type === "json") {
    const body = (result as HostJsonResult).body as { error?: { code?: string } };
    return { status: result.status, code: body.error?.code };
  }
  return { status: result.status };
}

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

const OK = { status: 200 };
const CREATED = { status: 201 };
const NOT_FOUND = { status: 404, code: "not_found" };
const FORBIDDEN = { status: 403, code: "not_allowed" };

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return jsonBody<{ project: { id: string } }>(result).project.id;
}

function invite(person: Person, projectId: string, userId: string): Promise<HostResult> {
  return call(person, "POST", "/api/v1/projects/:id/members", { id: projectId }, { userId });
}

function removeMember(person: Person, projectId: string, userId: string): Promise<HostResult> {
  return call(person, "DELETE", "/api/v1/projects/:id/members/:userId", { id: projectId, userId });
}

function setRole(person: Person, projectId: string, userId: string, role: string): Promise<HostResult> {
  return call(person, "PATCH", "/api/v1/projects/:id/members/:userId", { id: projectId, userId }, { role });
}

async function members(person: Person, projectId: string): Promise<Array<{ userId: string; role: string }>> {
  const body = jsonBody<{ members: Array<{ userId: string; role: string }> }>(
    await call(person, "GET", "/api/v1/projects/:id/members", { id: projectId }),
  );
  return body.members.map(({ userId, role }) => ({ userId, role }));
}

async function agentsIn(person: Person, projectId: string): Promise<Array<{ agentId: string; broughtBy: string }>> {
  const body = jsonBody<{ agents: Array<{ agentId: string; broughtBy: string }> }>(
    await call(person, "GET", "/api/v1/projects/:id/members", { id: projectId }),
  );
  return body.agents.map(({ agentId, broughtBy }) => ({ agentId, broughtBy }));
}

function projectIds(result: HostResult): string[] {
  return jsonBody<{ items: Array<{ id: string }> }>(result).items.map((item) => item.id);
}

/** The row id that owns this person's conversations with an agent: the default chat, or a mode agent. */
async function agentRowId(person: Person, mode: string | null): Promise<string> {
  if (mode === null) {
    return jsonBody<{ agent: { id: string } }>(await call(person, "GET", "/api/v1/chat")).agent.id;
  }
  const catalog = jsonBody<{ agents: Array<{ id: string; agentId: string | null }> }>(
    await call(person, "GET", "/api/v1/virtual-agents"),
  );
  const found = catalog.agents.find((agent) => agent.id === mode);
  expect(found?.agentId, `agent ${mode} on the desk`).toBeTruthy();
  return found?.agentId as string;
}

async function startChat(person: Person, projectId: string, mode: string | null = null): Promise<HostResult> {
  return call(person, "POST", "/api/v1/threads", {}, { agentId: await agentRowId(person, mode), projectId });
}

/** What a Workspace chat's run is given from knowledge, through the same call a run makes. */
async function injectedFor(person: Person, projectId: string): Promise<string> {
  const { knowledgeInjection } = await import("./knowledge");
  return (await knowledgeInjection(person.tenant, PHRASE, { projectId })).prompt;
}

/** What `knowledge_search` returns inside a run of a thread in `projectId`. */
async function searchFor(person: Person, projectId: string, threadId: string): Promise<string[]> {
  const { withRunContext } = await import("./run-context");
  const { searchKnowledge } = await import("./knowledge-search-tool");
  const output = await withRunContext({ threadId, agentId: "agent", locale: "en", projectId }, () =>
    searchKnowledge(person.tenant, PHRASE, 4),
  );
  return "results" in output ? output.results.map((hit) => hit.title) : [];
}

describe("a Workspace is shared with its members only: four people, two companies", () => {
  let project: string;
  let fileId: string;
  let imageId: string;

  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("org-1", "alice", "owner");
    ben = await provision("org-1", "ben", "member");
    cara = await provision("org-1", "cara", "admin");
    dan = await provision("org-2", "dan", "owner");
    // Indexing a Workspace file reaches the gateway, so each company saves a key; the models answer is stubbed.
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
    for (const owner of [alice, dan]) {
      const saved = await call(
        owner,
        "POST",
        "/api/v1/settings",
        {},
        { openaiApiKey: "sk-members-test-aaaaaaaaaaaaaa" },
      );
      expect(saved.status).toBe(200);
    }

    project = await makeProject(alice, "Forecast room");
    expect(await outcome(await invite(alice, project, "ben"))).toEqual(CREATED);

    const { artifactStore } = await import("./artifacts");
    fileId = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "heron-forecast",
      mime: "text/markdown",
      body: `# Forecast\n\n${PHRASE} for the board.`,
      meta: {},
    }).id;
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { artifactId: fileId })),
    ).toEqual(OK);

    const { saveMedia } = await import("./media");
    imageId = (await saveMedia(alice.tenant, new File([PNG], "forecast.png", { type: "image/png" }))).id;
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/files", { id: project }, { mediaId: imageId })),
    ).toEqual(OK);
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    vi.unstubAllGlobals();
    const { sql } = await import("@agentforge/db");
    sql.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("B, a member, lists the Workspace and reads, downloads and searches what A put in", async () => {
    const listed = jsonBody<{ items: Array<{ id: string; role: string; memberCount: number }> }>(
      await call(ben, "GET", "/api/v1/projects"),
    ).items.find((item) => item.id === project);
    expect(listed).toMatchObject({ role: "member", memberCount: 2 });

    const files = jsonBody<{ items: Array<{ id: string }> }>(
      await call(ben, "GET", "/api/v1/projects/:id/files", { id: project }),
    ).items.map((item) => item.id);
    expect(files.sort()).toEqual([fileId, imageId].sort());
    expect((await call(ben, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: fileId })).status).toBe(200);
    expect((await call(ben, "GET", "/api/v1/media/:mediaId/file", { mediaId: imageId })).status).toBe(200);

    const knowledge = jsonBody<{ items: Array<{ name: string }> }>(
      await call(ben, "GET", "/api/v1/projects/:id/knowledge", { id: project }),
    ).items.map((item) => item.name);
    expect(knowledge).toEqual(["heron-forecast"]);

    const chat = await startChat(ben, project);
    expect(chat.status).toBe(201);
    const threadId = jsonBody<{ thread: { id: string } }>(chat).thread.id;
    expect(await searchFor(ben, project, threadId)).toEqual(["heron-forecast"]);
    expect(await injectedFor(ben, project)).toContain(PHRASE);
    expect(await members(ben, project)).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "ben", role: "member" },
    ]);
  });

  it("C (same company, a company admin, not a member) and D (another company) get 404 everywhere, like an unknown id", async () => {
    for (const stranger of [cara, dan]) {
      const who = stranger.tenant.userId;
      expect(projectIds(await call(stranger, "GET", "/api/v1/projects")), who).not.toContain(project);
      for (const path of [
        "/api/v1/projects/:id/files",
        "/api/v1/projects/:id/knowledge",
        "/api/v1/projects/:id/threads",
        "/api/v1/projects/:id/members",
      ]) {
        const real = await outcome(await call(stranger, "GET", path, { id: project }));
        const ghost = await outcome(await call(stranger, "GET", path, { id: MISSING }));
        expect(real, `${who} GET ${path}`).toEqual(NOT_FOUND);
        expect(ghost, `${who} GET ${path}`).toEqual(real);
      }
      expect(
        await outcome(await call(stranger, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: fileId })),
      ).toEqual(
        await outcome(await call(stranger, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: MISSING })),
      );
      expect((await call(stranger, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: fileId })).status).toBe(
        404,
      );
      expect(await outcome(await startChat(stranger, project)), who).toEqual(NOT_FOUND);
      expect(await injectedFor(stranger, project), who).not.toContain(PHRASE);
      expect(await searchFor(stranger, project, MISSING), who).toEqual([]);
      expect(await outcome(await invite(stranger, project, who)), who).toEqual(NOT_FOUND);
      expect(
        await outcome(await call(stranger, "PATCH", "/api/v1/projects/:id", { id: project }, { name: "x" })),
        who,
      ).toEqual(NOT_FOUND);
      expect(await outcome(await call(stranger, "POST", "/api/v1/projects/:id/archive", { id: project })), who).toEqual(
        NOT_FOUND,
      );
    }
  });

  it("an invite names a person of the same company: another company's id and an unknown id are the same 404", async () => {
    expect(await outcome(await invite(alice, project, "dan"))).toEqual(NOT_FOUND);
    expect(await outcome(await invite(alice, project, "nobody-at-all"))).toEqual(NOT_FOUND);
    expect(await members(alice, project)).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "ben", role: "member" },
    ]);
  });

  it("the people picker lists colleagues not in yet, never another company's; a member gets 403, a stranger 404", async () => {
    const room = await makeProject(alice, "Picker room");
    const invitable = (person: Person, id: string) => call(person, "GET", "/api/v1/projects/:id/invitable", { id });
    const listed = async (person: Person) =>
      jsonBody<{ items: Array<{ userId: string; name: string }> }>(await invitable(person, room)).items;

    expect(await listed(alice)).toEqual([
      { userId: "ben", name: null },
      { userId: "cara", name: null },
    ]);
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
    expect(await listed(alice)).toEqual([{ userId: "cara", name: null }]);

    expect(await outcome(await invitable(ben, room))).toEqual(FORBIDDEN);
    for (const stranger of [cara, dan]) {
      const who = stranger.tenant.userId;
      expect(await outcome(await invitable(stranger, room)), who).toEqual(NOT_FOUND);
      expect(await outcome(await invitable(stranger, MISSING)), who).toEqual(NOT_FOUND);
    }

    expect(await outcome(await setRole(alice, room, "ben", "admin"))).toEqual(OK);
    expect(await listed(ben)).toEqual([{ userId: "cara", name: null }]);
    expect(await outcome(await invite(ben, room, "cara"))).toEqual(CREATED);
    expect(await listed(alice)).toEqual([]);

    await provision("org-1", "eva", "member", "Eva Lestari");
    expect(await listed(alice)).toEqual([{ userId: "eva", name: "Eva Lestari" }]);
  });

  it("roles: a member cannot invite until made admin; an admin removes members, never the owner or another admin", async () => {
    const room = await makeProject(alice, "Roles room");
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);

    expect(await outcome(await invite(ben, room, "cara"))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(ben, room, "ben", "admin"))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(alice, room, "ben", "admin"))).toEqual(OK);
    expect(await outcome(await invite(ben, room, "cara"))).toEqual(CREATED);
    expect((await call(cara, "GET", "/api/v1/projects/:id/files", { id: room })).status).toBe(200);

    expect(await outcome(await removeMember(ben, room, "alice"))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(alice, room, "cara", "admin"))).toEqual(OK);
    expect(await outcome(await removeMember(ben, room, "cara"))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(alice, room, "cara", "member"))).toEqual(OK);
    expect(await outcome(await removeMember(ben, room, "cara"))).toEqual(OK);
    expect(await outcome(await call(cara, "GET", "/api/v1/projects/:id/files", { id: room }))).toEqual(NOT_FOUND);

    // An admin renames; only the owner deletes (archives).
    expect(await outcome(await call(ben, "PATCH", "/api/v1/projects/:id", { id: room }, { name: "Renamed" }))).toEqual(
      OK,
    );
    expect(await outcome(await call(ben, "POST", "/api/v1/projects/:id/archive", { id: room }))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(alice, room, "alice", "member"))).toEqual(FORBIDDEN);
    expect(await outcome(await setRole(alice, room, "ben", "owner"))).toEqual({ status: 400, code: "invalid_project" });
  });

  it("the owner hands ownership to a member and stays on as an admin; the new owner alone archives", async () => {
    const room = await makeProject(alice, "Handover room");
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
    expect(
      await outcome(await call(ben, "POST", "/api/v1/projects/:id/owner", { id: room }, { userId: "ben" })),
    ).toEqual(FORBIDDEN);
    // A non-member (C), another company's person (D) and an unknown id: 404, and nothing changes.
    for (const userId of ["cara", "dan", "nobody"]) {
      expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/owner", { id: room }, { userId }))).toEqual(
        NOT_FOUND,
      );
      expect(await outcome(await setRole(alice, room, userId, "admin"))).toEqual(NOT_FOUND);
    }
    expect(await members(alice, room)).toEqual([
      { userId: "alice", role: "owner" },
      { userId: "ben", role: "member" },
    ]);
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/owner", { id: room }, { userId: "ben" })),
    ).toEqual(OK);
    expect(await members(alice, room)).toEqual([
      { userId: "ben", role: "owner" },
      { userId: "alice", role: "admin" },
    ]);

    expect(await outcome(await removeMember(alice, room, "ben"))).toEqual(FORBIDDEN);
    expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/archive", { id: room }))).toEqual(FORBIDDEN);
    expect(await outcome(await call(ben, "POST", "/api/v1/projects/:id/archive", { id: room }))).toEqual(OK);
    expect(await outcome(await call(alice, "GET", "/api/v1/projects/:id/files", { id: room }))).toEqual(NOT_FOUND);
    expect(await outcome(await call(ben, "GET", "/api/v1/projects/:id/files", { id: room }))).toEqual(NOT_FOUND);
  });

  it("a member leaves on her own; the owner cannot leave", async () => {
    const room = await makeProject(alice, "Leaving room");
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
    expect(await outcome(await removeMember(alice, room, "alice"))).toEqual(FORBIDDEN);
    expect(await outcome(await removeMember(ben, room, "ben"))).toEqual(OK);
    expect(projectIds(await call(ben, "GET", "/api/v1/projects"))).not.toContain(room);
  });

  it("agents: a member brings one from her desk; a chat starts only with the default agent or one brought in", async () => {
    const room = await makeProject(alice, "Agents room");
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);

    expect(await outcome(await startChat(ben, room, "research"))).toEqual(FORBIDDEN);
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/agents", { id: room }, { agentId: "research" })),
    ).toEqual(CREATED);
    expect(
      await outcome(await call(ben, "POST", "/api/v1/projects/:id/agents", { id: room }, { agentId: "documents" })),
    ).toEqual(CREATED);
    expect(
      await outcome(await call(ben, "POST", "/api/v1/projects/:id/agents", { id: room }, { agentId: "no-such-agent" })),
    ).toEqual(NOT_FOUND);
    expect(await agentsIn(ben, room)).toEqual([
      { agentId: "research", broughtBy: "alice" },
      { agentId: "documents", broughtBy: "ben" },
    ]);

    const chat = await startChat(ben, room, "research");
    expect(chat.status).toBe(201);
    expect((await startChat(ben, room)).status).toBe(201);

    const { workspaceForRun } = await import("./projects/service");
    expect(workspaceForRun(ben.tenant, room, "va-research")).toBe(room);

    expect(
      await outcome(
        await call(ben, "DELETE", "/api/v1/projects/:id/agents/:agentId", { id: room, agentId: "research" }),
      ),
    ).toEqual(FORBIDDEN);
    expect(
      await outcome(
        await call(ben, "DELETE", "/api/v1/projects/:id/agents/:agentId", { id: room, agentId: "documents" }),
      ),
    ).toEqual(OK);
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/agents/:agentId", { id: room, agentId: "research" }),
      ),
    ).toEqual(OK);
    expect(await agentsIn(alice, room)).toEqual([]);
    // Taken out, the agent's existing chat runs as an ordinary chat: the Workspace is not read any more.
    expect(workspaceForRun(ben.tenant, room, "va-research")).toBeNull();
    expect(workspaceForRun(ben.tenant, room, "quick-chat")).toBe(room);
    expect(await outcome(await startChat(ben, room, "research"))).toEqual(FORBIDDEN);
    expect(
      await outcome(await call(cara, "POST", "/api/v1/projects/:id/agents", { id: room }, { agentId: "research" })),
    ).toEqual(NOT_FOUND);
  });

  describe("a file in a Workspace belongs to the Workspace: its maker reads and deletes it only while a member (SR-179)", () => {
    async function bensFiles(room: string): Promise<{ docId: string; picId: string }> {
      const { artifactStore } = await import("./artifacts");
      const docId = artifactStore().create(ben.tenant, {
        mode: "documents",
        kind: "draft",
        title: "ben-plan",
        mime: "text/markdown",
        body: "# Ben's plan\n\nThree steps.",
        meta: {},
      }).id;
      const { saveMedia } = await import("./media");
      const picId = (await saveMedia(ben.tenant, new File([PNG], "ben.png", { type: "image/png" }))).id;
      for (const body of [{ artifactId: docId }, { mediaId: picId }]) {
        expect(await outcome(await call(ben, "POST", "/api/v1/projects/:id/files", { id: room }, body))).toEqual(OK);
      }
      return { docId, picId };
    }

    async function reads(person: Person, docId: string) {
      const listed = jsonBody<{ items: Array<{ id: string }> }>(await call(person, "GET", "/api/v1/artifacts")).items;
      return {
        doc: (await call(person, "GET", "/api/v1/artifacts/:artifactId", { artifactId: docId })).status,
        docFile: (await call(person, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: docId })).status,
        docListed: listed.some((item) => item.id === docId),
      };
    }

    const READS = { doc: 200, docFile: 200, docListed: true };
    const HIDDEN = { doc: 404, docFile: 404, docListed: false };

    it("a removed maker reads, lists and deletes none of it; the owner still reads all of it", async () => {
      const room = await makeProject(alice, "Removal room");
      expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
      const { docId, picId } = await bensFiles(room);
      expect(await reads(ben, docId)).toEqual(READS);

      expect(await outcome(await removeMember(alice, room, "ben"))).toEqual(OK);
      expect(await reads(ben, docId)).toEqual(HIDDEN);
      expect(await outcome(await call(ben, "DELETE", "/api/v1/artifacts/:artifactId", { artifactId: docId }))).toEqual(
        NOT_FOUND,
      );

      expect(await reads(alice, docId)).toEqual(READS);
      const files = jsonBody<{ items: Array<{ id: string }> }>(
        await call(alice, "GET", "/api/v1/projects/:id/files", { id: room }),
      ).items.map((item) => item.id);
      expect(files.sort()).toEqual([docId, picId].sort());
    });

    it("a maker still in the Workspace takes a file out and it is theirs alone again", async () => {
      const room = await makeProject(alice, "Take-out room");
      expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
      const { docId, picId } = await bensFiles(room);
      expect(await reads(alice, docId)).toEqual(READS);

      expect(
        await outcome(
          await call(ben, "DELETE", "/api/v1/projects/:id/files/:artifactId", { id: room, artifactId: docId }),
        ),
      ).toEqual(OK);
      expect(
        await outcome(await call(ben, "DELETE", "/api/v1/projects/:id/media/:mediaId", { id: room, mediaId: picId })),
      ).toEqual(OK);
      expect(await outcome(await removeMember(alice, room, "ben"))).toEqual(OK);

      expect(await reads(ben, docId)).toEqual(READS);
      expect(await reads(alice, docId)).toEqual(HIDDEN);
    });

    it("default: archiving a Workspace hands each file back to its maker", async () => {
      const room = await makeProject(alice, "Archive room");
      expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
      const { docId, picId } = await bensFiles(room);
      expect(await outcome(await removeMember(alice, room, "ben"))).toEqual(OK);
      expect(await reads(ben, docId)).toEqual(HIDDEN);

      expect(await outcome(await call(alice, "POST", "/api/v1/projects/:id/archive", { id: room }))).toEqual(OK);
      expect(await reads(ben, docId)).toEqual(READS);
      expect(await reads(alice, docId)).toEqual(HIDDEN);
      expect(
        jsonBody<{ deleted: boolean }>(await call(ben, "DELETE", "/api/v1/media/:mediaId", { mediaId: picId })).deleted,
      ).toBe(true);
      expect(await outcome(await call(ben, "DELETE", "/api/v1/artifacts/:artifactId", { artifactId: docId }))).toEqual(
        OK,
      );
    });
  });

  it("a removed member's run stops reading the Workspace at once", async () => {
    const { workspaceForRun } = await import("./projects/service");
    const room = await makeProject(alice, "Run room");
    expect(await outcome(await invite(alice, room, "ben"))).toEqual(CREATED);
    expect(workspaceForRun(ben.tenant, room, "quick-chat")).toBe(room);
    expect(await outcome(await removeMember(alice, room, "ben"))).toEqual(OK);
    expect(workspaceForRun(ben.tenant, room, "quick-chat")).toBeNull();
    expect(workspaceForRun(alice.tenant, room, "quick-chat")).toBe(room);
  });
});
