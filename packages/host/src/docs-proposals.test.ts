import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { JobAssistantOptions, JobAssistantRun } from "./job-regen";

const model = vi.hoisted(() => ({ calls: [] as Array<{ systemPrompt: string; prompt: string; jobMode?: string }> }));

vi.mock("./job-regen", async (importOriginal) => {
  const original = await importOriginal<typeof import("./job-regen")>();
  return {
    ...original,
    collectJobAssistantRun: async (options: JobAssistantOptions): Promise<JobAssistantRun> => {
      model.calls.push({ systemPrompt: options.systemPrompt, prompt: options.prompt, jobMode: options.jobMode });
      const instruction = /The member's instruction:\n([\s\S]*)$/.exec(options.prompt)?.[1] ?? "";
      if (instruction.startsWith("garbage")) {
        return { text: "no section here", model: "fake-model" };
      }
      return {
        text: JSON.stringify({ blocks: [{ type: "paragraph", text: `[model] ${instruction}` }] }),
        model: "fake-model",
      };
    },
  };
});

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-docs-proposals-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "7c2e4a6b8d0f1a3c5e7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e0b1d3";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

type Company = { readonly tenantId: string; readonly orgId: string };

const COMPANY: Company = { tenantId: "docs-proposals-partner", orgId: "docs-proposals-org" };
const OTHER_COMPANY: Company = { tenantId: "docs-proposals-other-partner", orgId: "docs-proposals-other-org" };
const CLOSED_COMPANY: Company = { tenantId: "docs-proposals-closed-partner", orgId: "docs-proposals-closed-org" };
const MISSING = "00000000-0000-4000-8000-000000000000";
const KEY = "sk-docs-proposals-test-aaaaaaaaaaaa";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

type Block = { type: string; text?: string };

type Proposal = {
  id: string;
  artifactId: string;
  sectionId: string;
  section: { id: string; heading?: string; blocks: Block[] };
  baseVersion: number;
  agentId: string;
  askedByUserId: string;
  status: string;
  keptVersion: number | null;
};

type DocBody = {
  headVersion: number;
  spec: { sections: Array<{ id: string; blocks: Block[] }> };
  sectionAuthors: Record<
    string,
    { version: number; author: { kind: string; userId?: string; agentId?: string; askedByUserId?: string } }
  >;
  proposals: Proposal[];
};

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ben: Person;
let cara: Person;
let dan: Person;
let erin: Person;
let fay: Person;
let project: string;
let closedProject: string;

async function provision(
  userId: string,
  role: "owner" | "admin" | "member",
  company: Company = COMPANY,
): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { ...company, userId, role, name: null });
  const session = createSession({ ...company, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(person: Person, method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
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

function jsonBody<T>(result: HostResult): T {
  expect(result.type).toBe("json");
  return (result as HostJsonResult).body as T;
}

type Outcome = { status: number; code?: string; sectionIds?: string[] };

function outcomeOf(result: HostResult): Outcome {
  const body = jsonBody<{ error?: { code?: string; sectionIds?: string[] } | string }>(result);
  if (typeof body.error === "string") {
    return { status: result.status, code: body.error };
  }
  return { status: result.status, code: body.error?.code, sectionIds: body.error?.sectionIds };
}

function shape(result: HostResult): string {
  const text = JSON.stringify({ status: result.status, body: (result as HostJsonResult).body ?? null });
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
}

function ask(person: Person, artifactId: string, sectionId: string, over: Record<string, unknown> = {}) {
  return call(
    person,
    "POST",
    "/api/v1/docs/:artifactId/sections/:sectionId/proposals",
    { artifactId, sectionId },
    { agentId: "documents", instruction: "Make it shorter", baseVersion: 1, ...over },
  );
}

const keep = (person: Person, proposalId: string) =>
  call(person, "POST", "/api/v1/docs/proposals/:proposalId/keep", { proposalId }, {});

const discard = (person: Person, proposalId: string) =>
  call(person, "POST", "/api/v1/docs/proposals/:proposalId/discard", { proposalId }, {});

const readDoc = (person: Person, artifactId: string) => call(person, "GET", "/api/v1/docs/:artifactId", { artifactId });

async function proposed(person: Person, artifactId: string, sectionId: string, over: Record<string, unknown> = {}) {
  const result = await ask(person, artifactId, sectionId, over);
  expect(result.status, JSON.stringify((result as HostJsonResult).body)).toBe(201);
  return jsonBody<{ proposal: Proposal }>(result).proposal;
}

async function pendingOf(person: Person, artifactId: string): Promise<Proposal[]> {
  return jsonBody<DocBody>(await readDoc(person, artifactId)).proposals;
}

async function docIn(owner: Person, inProject: string): Promise<string> {
  const { createDocumentForTenant } = await import("./doc-tools/create-document");
  const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner.tenant);
  if (!made.ok) {
    throw new Error(made.message);
  }
  const added = await call(
    owner,
    "POST",
    "/api/v1/projects/:id/files",
    { id: inProject },
    { artifactId: made.artifactId },
  );
  expect(added.status).toBe(200);
  return made.artifactId;
}

const freshDoc = () => docIn(alice, project);

async function editSection(person: Person, artifactId: string, sectionId: string, text: string, baseVersion: number) {
  const { docVersionStore } = await import("./doc-versions");
  const { replaceSection } = await import("./doc-model");
  const appended = docVersionStore().appendVersion(person.tenant, artifactId, {
    baseVersion,
    author: { kind: "person" },
    edit: (head) =>
      head.kind === "document"
        ? {
            kind: "document",
            spec: replaceSection(head.spec, sectionId, {
              id: sectionId,
              heading: "Edited",
              blocks: [{ type: "paragraph", text }],
            }),
          }
        : head,
  });
  expect(appended.ok).toBe(true);
}

async function openWorkspace(owner: Person, name: string): Promise<string> {
  const made = await call(owner, "POST", "/api/v1/projects", {}, { name });
  expect(made.status).toBe(201);
  const id = jsonBody<{ project: { id: string } }>(made).project.id;
  expect((await call(owner, "POST", "/api/v1/projects/:id/agents", { id }, { agentId: "documents" })).status).toBe(201);
  return id;
}

describe("agent proposals over HTTP: a member asks, then keeps, discards or asks again", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("alice", "owner");
    ben = await provision("ben", "member");
    cara = await provision("cara", "admin");
    dan = await provision("dan", "member");
    erin = await provision("erin", "owner", OTHER_COMPANY);
    fay = await provision("fay", "owner", CLOSED_COMPANY);

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
    expect((await call(alice, "POST", "/api/v1/settings", {}, { openaiApiKey: KEY })).status).toBe(200);

    project = await openWorkspace(alice, "Forecast room");
    for (const userId of ["ben", "dan"]) {
      expect((await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId })).status).toBe(201);
    }
    closedProject = await openWorkspace(fay, "Closed room");
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("B asks the Workspace's agent, A keeps it, and the version is credited to the agent, asked for B", async () => {
    const docId = await freshDoc();
    const proposal = await proposed(ben, docId, "close", { instruction: "Say it in one line" });

    expect(proposal).toMatchObject({
      artifactId: docId,
      sectionId: "close",
      baseVersion: 1,
      agentId: "documents",
      askedByUserId: "ben",
      status: "pending",
      keptVersion: null,
      section: { id: "close", heading: "Close", blocks: [{ type: "paragraph", text: "[model] Say it in one line" }] },
    });

    const beforeKeep = jsonBody<DocBody>(await readDoc(alice, docId));
    expect(beforeKeep.headVersion).toBe(1);
    expect(beforeKeep.proposals.map((item) => item.id)).toEqual([proposal.id]);
    expect(beforeKeep.spec.sections.find((part) => part.id === "close")?.blocks).toEqual([
      { type: "paragraph", text: "Next quarter we expand." },
    ]);

    const kept = await keep(alice, proposal.id);
    expect(kept.status).toBe(200);
    expect(jsonBody<{ proposal: Proposal; headVersion: number; bodyRefreshed: boolean }>(kept)).toMatchObject({
      headVersion: 2,
      bodyRefreshed: true,
      proposal: { id: proposal.id, status: "kept", keptVersion: 2 },
    });

    const afterKeep = jsonBody<DocBody>(await readDoc(ben, docId));
    expect(afterKeep.headVersion).toBe(2);
    expect(afterKeep.proposals).toEqual([]);
    expect(afterKeep.spec.sections.find((part) => part.id === "close")?.blocks).toEqual([
      { type: "paragraph", text: "[model] Say it in one line" },
    ]);
    expect(afterKeep.sectionAuthors.close).toEqual({
      version: 2,
      author: { kind: "agent", agentId: "documents", askedByUserId: "ben" },
    });
    expect(afterKeep.sectionAuthors.intro?.author).toEqual({ kind: "person", userId: "alice" });

    const versions = jsonBody<{ items: Array<{ version: number; changedSectionIds: string[]; author: unknown }> }>(
      await call(ben, "GET", "/api/v1/docs/:artifactId/versions", { artifactId: docId }),
    ).items;
    expect(versions[0]).toMatchObject({
      version: 2,
      changedSectionIds: ["close"],
      author: { kind: "agent", agentId: "documents", askedByUserId: "ben" },
    });
  });

  it("makes one model call that carries the whole document, the agent's role and the language rule", async () => {
    const docId = await freshDoc();
    const before = model.calls.length;
    await proposed(ben, docId, "numbers", { instruction: "As a table" });

    expect(model.calls).toHaveLength(before + 1);
    const call = model.calls[before];
    expect(call?.jobMode).toBe("documents");
    expect(call?.systemPrompt).toContain("You are the Documents agent on the owner's desk.");
    expect(call?.systemPrompt).toContain("Return ONLY valid JSON");
    expect(call?.systemPrompt).toContain("Write every user-facing title, heading, and body string in English.");
    expect(call?.prompt).toContain("Document title: Quarterly review");
    expect(call?.prompt).toContain("[intro] Introduction");
    expect(call?.prompt).toContain("[close] Close");
    expect(call?.prompt).toContain('The section to rewrite, id "numbers":');
    expect(call?.prompt).toContain("Revenue up");
    expect(call?.prompt).toContain("The member's instruction:\nAs a table");
  });

  it("keeping renders the new head into the stored file", async () => {
    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const docId = await freshDoc();
    const proposal = await proposed(alice, docId, "intro", { instruction: "Open with the margin" });
    expect((await keep(ben, proposal.id)).status).toBe(200);

    const file = await call(ben, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId: docId });
    expect(file.type).toBe("bytes");
    const bytes = (file as unknown as { bytes: Uint8Array }).bytes;
    expect(await docxBodyText(bytes)).toContain("[model] Open with the margin");
    expect(await docxBodyText(bytes)).toContain("Next quarter we expand.");
  });

  it("ask, then discard: nothing is written, and a discarded proposal cannot be kept", async () => {
    const docId = await freshDoc();
    const proposal = await proposed(ben, docId, "intro");

    const discarded = await discard(alice, proposal.id);
    expect(discarded.status).toBe(200);
    expect(jsonBody<{ proposal: Proposal }>(discarded).proposal).toMatchObject({
      id: proposal.id,
      status: "discarded",
    });

    expect(await pendingOf(alice, docId)).toEqual([]);
    expect(jsonBody<DocBody>(await readDoc(alice, docId)).headVersion).toBe(1);
    expect(outcomeOf(await keep(alice, proposal.id))).toMatchObject({ status: 409, code: "proposal_not_pending" });
    expect(outcomeOf(await discard(alice, proposal.id)).code).toBe("proposal_not_pending");
    expect(jsonBody<DocBody>(await readDoc(alice, docId)).headVersion).toBe(1);
  });

  it("asking again for the same section replaces the pending proposal", async () => {
    const docId = await freshDoc();
    const first = await proposed(ben, docId, "numbers", { instruction: "As a table" });
    const second = await proposed(alice, docId, "numbers", { instruction: "As bullets" });
    expect(second.id).not.toBe(first.id);

    const pending = await pendingOf(ben, docId);
    expect(pending.map((item) => item.id)).toEqual([second.id]);
    expect(pending[0]).toMatchObject({ askedByUserId: "alice", section: { blocks: [{ text: "[model] As bullets" }] } });
    expect(outcomeOf(await keep(ben, first.id)).code).toBe("proposal_not_pending");

    const other = await proposed(ben, docId, "close");
    expect((await pendingOf(ben, docId)).map((item) => item.id).sort()).toEqual([second.id, other.id].sort());
  });

  it("keep after another person changed that section is 409 section_changed, and the proposal stays pending", async () => {
    const docId = await freshDoc();
    const proposal = await proposed(ben, docId, "numbers");
    await editSection(alice, docId, "numbers", "Alice rewrote the numbers", 1);

    expect(outcomeOf(await keep(alice, proposal.id))).toEqual({
      status: 409,
      code: "section_changed",
      sectionIds: ["numbers"],
    });

    const doc = jsonBody<DocBody>(await readDoc(ben, docId));
    expect(doc.headVersion).toBe(2);
    expect(doc.proposals.map((item) => [item.id, item.status])).toEqual([[proposal.id, "pending"]]);
    expect(doc.spec.sections.find((part) => part.id === "numbers")?.blocks).toEqual([
      { type: "paragraph", text: "Alice rewrote the numbers" },
    ]);

    expect((await discard(ben, proposal.id)).status).toBe(200);
  });

  it("keep after another person changed a different section still works, on the newest head", async () => {
    const docId = await freshDoc();
    const proposal = await proposed(ben, docId, "close");
    await editSection(alice, docId, "intro", "A new opening", 1);

    expect((await keep(alice, proposal.id)).status).toBe(200);
    const doc = jsonBody<DocBody>(await readDoc(ben, docId));
    expect(doc.headVersion).toBe(3);
    expect(doc.spec.sections.find((part) => part.id === "intro")?.blocks).toEqual([
      { type: "paragraph", text: "A new opening" },
    ]);
    expect(doc.spec.sections.find((part) => part.id === "close")?.blocks).toEqual([
      { type: "paragraph", text: "[model] Make it shorter" },
    ]);
  });

  it("an ask that started from a version older than the section's last change is 409 before any model call", async () => {
    const docId = await freshDoc();
    await editSection(alice, docId, "close", "Closing, edited", 1);
    const before = model.calls.length;

    expect(outcomeOf(await ask(ben, docId, "close", { baseVersion: 1 }))).toEqual({
      status: 409,
      code: "section_changed",
      sectionIds: ["close"],
    });
    expect(model.calls).toHaveLength(before);
    expect(await pendingOf(ben, docId)).toEqual([]);

    expect((await proposed(ben, docId, "close", { baseVersion: 2 })).baseVersion).toBe(2);
    expect((await proposed(ben, docId, "intro", { baseVersion: 1 })).sectionId).toBe("intro");
  });

  it("a reply that is not a section is 502 invalid_section and stores nothing", async () => {
    const docId = await freshDoc();
    expect(outcomeOf(await ask(ben, docId, "intro", { instruction: "garbage in" }))).toMatchObject({
      status: 502,
      code: "invalid_section",
    });
    expect(await pendingOf(ben, docId)).toEqual([]);
  });

  it("an agent the Workspace does not hold is 403 agent_not_in_workspace, before any model call", async () => {
    const docId = await freshDoc();
    const before = model.calls.length;
    for (const agentId of ["finance", "research", "no-such-agent"]) {
      expect(outcomeOf(await ask(ben, docId, "intro", { agentId })), agentId).toMatchObject({
        status: 403,
        code: "agent_not_in_workspace",
      });
    }
    expect(model.calls).toHaveLength(before);
    expect(await pendingOf(ben, docId)).toEqual([]);
  });

  it("the default agent and an agent a member brings in are allowed; taking it out closes the door again", async () => {
    const docId = await freshDoc();
    expect((await proposed(ben, docId, "intro", { agentId: "chat" })).agentId).toBe("chat");
    expect((await proposed(ben, docId, "close", { agentId: "documents" })).agentId).toBe("documents");

    expect(
      (await call(ben, "POST", "/api/v1/projects/:id/agents", { id: project }, { agentId: "finance" })).status,
    ).toBe(201);
    expect((await proposed(dan, docId, "numbers", { agentId: "finance" })).agentId).toBe("finance");

    const removed = await call(alice, "DELETE", "/api/v1/projects/:id/agents/:agentId", {
      id: project,
      agentId: "finance",
    });
    expect(removed.status).toBe(200);
    expect(outcomeOf(await ask(ben, docId, "intro", { agentId: "finance" })).code).toBe("agent_not_in_workspace");
  });

  it("a file with no Workspace may use only the maker's own virtual agents", async () => {
    const { createDocumentForTenant } = await import("./doc-tools/create-document");
    const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, ben.tenant);
    if (!made.ok) {
      throw new Error(made.message);
    }
    expect(await proposed(ben, made.artifactId, "intro", { agentId: "finance" })).toMatchObject({
      agentId: "finance",
      askedByUserId: "ben",
    });
    expect(outcomeOf(await ask(ben, made.artifactId, "intro", { agentId: "no-such-agent" })).code).toBe(
      "agent_not_in_workspace",
    );
    expect(outcomeOf(await ask(alice, made.artifactId, "intro")).code).toBe("not_found");
  });

  it("answers 403 gateway_blocked when the company's gateway gate is closed, and calls no model", async () => {
    const docId = await docIn(fay, closedProject);
    const before = model.calls.length;

    const blocked = await ask(fay, docId, "intro");
    expect(blocked.status).toBe(403);
    expect(jsonBody<{ error: string }>(blocked).error).toBe("gateway_blocked");
    expect(model.calls).toHaveLength(before);
    expect(await pendingOf(fay, docId)).toEqual([]);
  });

  it("refuses a bad request as a value: 400, 404 and 409, and a workbook has no sections", async () => {
    const docId = await freshDoc();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["no instruction", { instruction: "  " }],
      ["no agent", { agentId: "" }],
      ["a base that is not a number", { baseVersion: "1" }],
      ["a base of zero", { baseVersion: 0 }],
      ["a base with a fraction", { baseVersion: 1.5 }],
      ["an instruction over the cap", { instruction: "x".repeat(2001) }],
    ];
    for (const [label, over] of bad) {
      expect(outcomeOf(await ask(ben, docId, "intro", over)), label).toMatchObject({
        status: 400,
        code: "invalid_request",
      });
    }
    const noBody = await call(ben, "POST", "/api/v1/docs/:artifactId/sections/:sectionId/proposals", {
      artifactId: docId,
      sectionId: "intro",
    });
    expect(outcomeOf(noBody)).toMatchObject({ status: 400, code: "invalid_request" });
    expect(outcomeOf(await ask(ben, docId, "intro", { baseVersion: 9 }))).toMatchObject({
      status: 400,
      code: "bad_base",
    });
    expect(outcomeOf(await ask(ben, docId, "no-such-section"))).toMatchObject({
      status: 404,
      code: "section_not_found",
    });
    expect(await pendingOf(ben, docId)).toEqual([]);

    const { createWorkbookForTenant } = await import("./doc-tools/create-document");
    const { sampleWorkbookInput } = await import("./doc-tools/doc-tools-fixtures");
    const book = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, alice.tenant);
    if (!book.ok) {
      throw new Error(book.message);
    }
    const added = await call(
      alice,
      "POST",
      "/api/v1/projects/:id/files",
      { id: project },
      { artifactId: book.artifactId },
    );
    expect(added.status).toBe(200);
    expect(outcomeOf(await ask(alice, book.artifactId, "sheet1"))).toMatchObject({ status: 409, code: "not_editable" });
  });

  it("a person outside the Workspace, and a member taken out of it, get 404 on every route, as an unknown id does", async () => {
    const docId = await freshDoc();
    const pending = await proposed(ben, docId, "intro");
    const danOwn = await proposed(dan, docId, "close");
    expect(danOwn.askedByUserId).toBe("dan");

    const removed = await call(alice, "DELETE", "/api/v1/projects/:id/members/:userId", { id: project, userId: "dan" });
    expect(removed.status).toBe(200);
    const before = model.calls.length;

    for (const stranger of [cara, dan]) {
      const who = stranger.tenant.userId;
      const realAsk = await ask(stranger, docId, "intro");
      expect(realAsk.status, who).toBe(404);
      expect(shape(realAsk), who).toBe(shape(await ask(stranger, MISSING, "intro")));

      const realKeep = await keep(stranger, pending.id);
      expect(realKeep.status, who).toBe(404);
      expect(shape(realKeep), who).toBe(shape(await keep(stranger, MISSING)));

      const realDiscard = await discard(stranger, pending.id);
      expect(realDiscard.status, who).toBe(404);
      expect(shape(realDiscard), who).toBe(shape(await discard(stranger, MISSING)));

      expect((await readDoc(stranger, docId)).status, who).toBe(404);
      expect((await keep(stranger, danOwn.id)).status, who).toBe(404);
    }
    expect(model.calls).toHaveLength(before);

    expect((await pendingOf(ben, docId)).map((item) => item.status)).toEqual(["pending", "pending"]);
    expect((await keep(ben, pending.id)).status).toBe(200);
  });

  it("a proposal id from another company, or an artifact id from another company, is 404 and changes nothing", async () => {
    const docId = await freshDoc();
    const pending = await proposed(ben, docId, "intro");

    const foreignKeep = await keep(erin, pending.id);
    expect(foreignKeep.status).toBe(404);
    expect(shape(foreignKeep)).toBe(shape(await keep(erin, MISSING)));
    const foreignDiscard = await discard(erin, pending.id);
    expect(foreignDiscard.status).toBe(404);
    expect(shape(foreignDiscard)).toBe(shape(await discard(erin, MISSING)));
    const foreignAsk = await ask(erin, docId, "intro");
    expect(foreignAsk.status).toBe(404);
    expect(shape(foreignAsk)).toBe(shape(await ask(erin, MISSING, "intro")));

    expect((await pendingOf(alice, docId)).map((item) => [item.id, item.status])).toEqual([[pending.id, "pending"]]);
  });
});

describe("Personal: one person, no server mode, the same routes, with the stub runtime", () => {
  let docId: string;

  const personal = (method: string, path: string, params: Record<string, string>, body?: unknown) =>
    dispatch(
      {
        method,
        path: path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? ""),
        query: {},
        params,
        headers: {},
        ...(body === undefined ? {} : { body }),
      },
      { serverMode: false },
    );

  const personalAsk = (agentId: string, over: Record<string, unknown> = {}) =>
    personal(
      "POST",
      "/api/v1/docs/:artifactId/sections/:sectionId/proposals",
      { artifactId: docId, sectionId: "close" },
      { agentId, instruction: "Shorter", baseVersion: 1, ...over },
    );

  beforeAll(async () => {
    delete process.env.AGENTFORGE_SERVER;
    process.env.AGENTFORGE_RUNTIME = "stub";
    const { getTenant } = await import("./tenant");
    const { createDocumentForTenant } = await import("./doc-tools/create-document");
    const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, await getTenant());
    if (!made.ok) {
      throw new Error(made.message);
    }
    docId = made.artifactId;
  });

  afterAll(() => {
    process.env.AGENTFORGE_SERVER = "1";
    delete process.env.AGENTFORGE_RUNTIME;
  });

  it("asks an agent of the desk, shows the proposal, keeps it, and credits the agent to the one person", async () => {
    const before = model.calls.length;
    const asked = await personalAsk("research");
    expect(asked.status).toBe(201);
    const proposal = jsonBody<{ proposal: Proposal }>(asked).proposal;
    expect(proposal).toMatchObject({ agentId: "research", status: "pending", sectionId: "close" });
    expect(model.calls).toHaveLength(before);

    const open = jsonBody<DocBody>(await personal("GET", "/api/v1/docs/:artifactId", { artifactId: docId }));
    expect(open.proposals.map((item) => item.id)).toEqual([proposal.id]);

    const kept = await personal("POST", "/api/v1/docs/proposals/:proposalId/keep", { proposalId: proposal.id }, {});
    expect(kept.status).toBe(200);
    expect(jsonBody<{ headVersion: number }>(kept).headVersion).toBe(2);

    const after = jsonBody<DocBody>(await personal("GET", "/api/v1/docs/:artifactId", { artifactId: docId }));
    expect(after.proposals).toEqual([]);
    expect(after.sectionAuthors.close?.author).toMatchObject({ kind: "agent", agentId: "research" });
    expect(after.spec.sections.find((part) => part.id === "close")?.blocks).toEqual([
      { type: "paragraph", text: "[stub research] Shorter" },
    ]);
  });

  it("discards, and refuses an agent that is not on the desk and a stale ask, with the hosted app's codes", async () => {
    const asked = await personalAsk("chat", { baseVersion: 2, instruction: "Again" });
    expect(asked.status).toBe(201);
    const proposal = jsonBody<{ proposal: Proposal }>(asked).proposal;
    const discarded = await personal(
      "POST",
      "/api/v1/docs/proposals/:proposalId/discard",
      { proposalId: proposal.id },
      {},
    );
    expect(discarded.status).toBe(200);
    expect(jsonBody<{ proposal: Proposal }>(discarded).proposal.status).toBe("discarded");

    expect(outcomeOf(await personalAsk("finance", { baseVersion: 2 }))).toMatchObject({
      status: 403,
      code: "agent_not_in_workspace",
    });
    expect(outcomeOf(await personalAsk("chat", { baseVersion: 1 }))).toEqual({
      status: 409,
      code: "section_changed",
      sectionIds: ["close"],
    });
    const missingKeep = await personal("POST", "/api/v1/docs/proposals/:proposalId/keep", { proposalId: MISSING }, {});
    expect(outcomeOf(missingKeep)).toMatchObject({ status: 404, code: "not_found" });
    const missingAsk = await personal(
      "POST",
      "/api/v1/docs/:artifactId/sections/:sectionId/proposals",
      { artifactId: MISSING, sectionId: "close" },
      { agentId: "chat", instruction: "x", baseVersion: 1 },
    );
    expect(outcomeOf(missingAsk)).toMatchObject({ status: 404, code: "not_found" });
  });
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
