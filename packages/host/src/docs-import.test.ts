import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-docs-import-"));
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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../core/src/docx/fixtures");
const PARTNER = "docs-import-partner";
const ORG = "docs-import-org";
const MISSING = "00000000-0000-4000-8000-000000000000";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF = "application/pdf";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const OK = { status: 200 };
const CREATED = { status: 201 };
const NOT_EDITABLE = { status: 409, code: "not_editable" };
const INVALID = { status: 400, code: "invalid_request" };

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

type DocBody = {
  artifactId: string;
  title: string;
  kind: string;
  headVersion: number;
  spec: Record<string, unknown>;
  sectionAuthors: Record<string, unknown>;
  proposals: unknown[];
};

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ben: Person;
let cara: Person;
let dan: Person;
let fetched: string[] = [];

async function provision(userId: string, role: "owner" | "admin" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId: ORG, userId, role, name: null });
  const session = createSession({ tenantId: PARTNER, orgId: ORG, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function call(
  person: Person,
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  query: Record<string, string> = {},
): Promise<HostResult> {
  const concrete = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? "");
  const request: HostRequest = {
    method,
    path: concrete,
    query,
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

function importAs(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "POST", "/api/v1/docs/import", {}, { artifactId });
}

function readDoc(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/docs/:artifactId", { artifactId });
}

function readFile(person: Person, artifactId: string, n: string, format: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/docs/:artifactId/versions/:n/file", { artifactId, n }, undefined, { format });
}

function addToProject(person: Person, projectId: string, artifactId: string): Promise<HostResult> {
  return call(person, "POST", "/api/v1/projects/:id/files", { id: projectId }, { artifactId });
}

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return jsonBody<{ project: { id: string } }>(result).project.id;
}

async function expectSameAsUnknown(person: Person, real: HostResult, unknown: HostResult): Promise<void> {
  expect(real.status, person.tenant.userId).toBe(404);
  expect(jsonBody(real), person.tenant.userId).toEqual(jsonBody(unknown));
}

describe("POST /api/v1/docs/import: a stored Word or Excel file becomes an editable document with no model call", () => {
  let project: string;
  let docId: string;
  let bookId: string;
  let copyId: string;

  beforeAll(async () => {
    const { artifactStore } = await import("./artifacts");
    const { renderXlsx } = await import("./doc-model/render-xlsx");
    const { sampleBook } = await import("./doc-model/fixtures");
    sessionStore = createMemorySessionStore();
    alice = await provision("alice", "owner");
    ben = await provision("ben", "member");
    cara = await provision("cara", "admin");
    dan = await provision("dan", "member");
    vi.stubGlobal("fetch", async (url: unknown) => {
      fetched.push(String(url));
      return new Response("{}", { status: 500 });
    });

    project = await makeProject(alice, "Forecast room");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "ben" })),
    ).toEqual(CREATED);
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "dan" })),
    ).toEqual(CREATED);

    const word = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "Account control agreement",
      mime: DOCX,
      body: readFileSync(join(FIXTURES, "lender-initial-aca-draft.docx")).toString("base64"),
    });
    docId = word.id;
    expect(await outcome(await addToProject(alice, project, docId))).toEqual(OK);

    const sheet = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "Sales workbook",
      mime: XLSX,
      body: Buffer.from(await renderXlsx(sampleBook("modern"))).toString("base64"),
    });
    bookId = sheet.id;
    expect(await outcome(await addToProject(alice, project, bookId))).toEqual(OK);
  }, ROUTER_IMPORT_BUDGET_MS);

  it("the gateway is closed in this setup, so a route that calls it refuses", async () => {
    const blocked = await call(ben, "POST", "/api/v1/projects/:id/uploads", { id: project }, {});
    expect(blocked.status).toBe(403);
    expect(jsonBody<{ error: string }>(blocked).error).toBe("gateway_blocked");
  });

  it("B imports A's Word file in the Workspace with no key saved: 201, no network call, and the copy opens for B", async () => {
    fetched = [];
    const imported = await importAs(ben, docId);
    expect(imported.status).toBe(201);
    const body = jsonBody<{ artifactId: string }>(imported);
    expect(Object.keys(body)).toEqual(["artifactId"]);
    copyId = body.artifactId;
    expect(copyId).not.toBe(docId);
    expect(fetched).toEqual([]);

    const doc = await readDoc(ben, copyId);
    expect(doc.status).toBe(200);
    expect(jsonBody<DocBody>(doc)).toMatchObject({ artifactId: copyId, kind: "document", headVersion: 1 });
    expect((await readFile(ben, copyId, "1", "docx")).status).toBe(200);
  });

  it("the copy is B's own file, in the same Workspace, and is listed there", async () => {
    const { sql } = await import("@agentforge/db");
    expect(sql.prepare("SELECT owner_user_id, project_id, mime FROM artifacts WHERE id = ?").get(copyId)).toEqual({
      owner_user_id: "ben",
      project_id: project,
      mime: DOCX,
    });
    const listed = jsonBody<{ items: Array<{ id: string }> }>(
      await call(ben, "GET", "/api/v1/projects/:id/files", { id: project }),
    );
    expect(listed.items.map((item) => item.id)).toContain(copyId);
  });

  it("imports A's Excel file as a workbook, with the same route", async () => {
    const imported = await importAs(ben, bookId);
    expect(imported.status).toBe(201);
    const id = jsonBody<{ artifactId: string }>(imported).artifactId;
    expect(jsonBody<DocBody>(await readDoc(ben, id))).toMatchObject({ artifactId: id, kind: "workbook" });
  });

  it("C, a company admin who is not a member, gets the same 404 as an unknown id, on the import and on the copy", async () => {
    await expectSameAsUnknown(cara, await importAs(cara, docId), await importAs(cara, MISSING));
    await expectSameAsUnknown(cara, await readDoc(cara, copyId), await readDoc(cara, MISSING));
  });

  it("D, taken out of the Workspace after the import, gets the same 404 on the source and on the copy", async () => {
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/members/:userId", { id: project, userId: "dan" }),
      ),
    ).toEqual(OK);
    await expectSameAsUnknown(dan, await importAs(dan, docId), await importAs(dan, MISSING));
    await expectSameAsUnknown(dan, await readDoc(dan, copyId), await readDoc(dan, MISSING));
  });

  it("the Workspace owner reads the copy as a member, and does not see a leaked body in a refusal", async () => {
    expect((await readDoc(alice, copyId)).status).toBe(200);
    const refused = await importAs(cara, docId);
    expect(JSON.stringify((refused as HostJsonResult).body)).not.toContain("Account control");
  });

  it("refuses a file that is neither Word, Excel nor PDF with 409 not_editable", async () => {
    const { artifactStore } = await import("./artifacts");
    const notes = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "Notes",
      mime: "text/markdown",
      body: "# Notes",
    });
    const deck = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "Deck",
      mime: PPTX,
      body: Buffer.from("not really a deck").toString("base64"),
    });
    for (const id of [notes.id, deck.id]) {
      expect(await outcome(await importAs(alice, id)), id).toEqual(NOT_EDITABLE);
    }
  });

  it("imports a PDF as a PDF again, as import_document does, so it is not refused", async () => {
    const { artifactStore } = await import("./artifacts");
    const { renderPdf } = await import("./doc-model/render-pdf");
    const { sampleDoc } = await import("./doc-model/fixtures");
    const pdf = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "Plain review",
      mime: PDF,
      body: Buffer.from(await renderPdf(sampleDoc("plain"))).toString("base64"),
    });
    const imported = await importAs(alice, pdf.id);
    expect(imported.status).toBe(201);
    const id = jsonBody<{ artifactId: string }>(imported).artifactId;
    expect((await readFile(alice, id, "1", "pdf")).status).toBe(200);
  });

  it("answers 400 invalid_request for a body with no artifactId", async () => {
    for (const body of [{}, { artifactId: "" }, { artifactId: 5 }, "docx", []]) {
      expect(await outcome(await call(alice, "POST", "/api/v1/docs/import", {}, body)), JSON.stringify(body)).toEqual(
        INVALID,
      );
    }
  });

  it("answers 403 storage_quota_exceeded at the storage ceiling, and writes no copy", async () => {
    const { sql } = await import("@agentforge/db");
    const count = () => (sql.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number }).n;
    const before = count();
    const previous = process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "1";
    try {
      expect(await outcome(await importAs(alice, docId))).toEqual({
        status: 403,
        code: "storage_quota_exceeded",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
      } else {
        process.env.AGENTFORGE_TENANT_STORAGE_BYTES = previous;
      }
    }
    expect(count()).toBe(before);
  });

  it("once B is taken out, the copy stays with the Workspace: B gets 404, and the owner still reads it", async () => {
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/members/:userId", { id: project, userId: "ben" }),
      ),
    ).toEqual(OK);
    await expectSameAsUnknown(ben, await readDoc(ben, copyId), await readDoc(ben, MISSING));
    expect((await readDoc(alice, copyId)).status).toBe(200);
  });
});

describe("POST /api/v1/docs/import: Personal, one person and no server mode", () => {
  it("imports a Word file on the desk with no owner and no Workspace, and the copy opens", async () => {
    const previous = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    try {
      const { getTenant } = await import("./tenant");
      const { createDocumentForTenant } = await import("./doc-tools/create-document");
      const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
      const { sql } = await import("@agentforge/db");
      const owner = await getTenant();
      const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
      if (!made.ok) {
        throw new Error(made.message);
      }
      const imported = await dispatch(
        {
          method: "POST",
          path: "/api/v1/docs/import",
          query: {},
          params: {},
          headers: {},
          body: { artifactId: made.artifactId },
        },
        { serverMode: false },
      );
      expect(imported.status).toBe(201);
      const id = jsonBody<{ artifactId: string }>(imported).artifactId;
      const opened = await dispatch(
        { method: "GET", path: `/api/v1/docs/${id}`, query: {}, params: { artifactId: id }, headers: {} },
        { serverMode: false },
      );
      expect(opened.status).toBe(200);
      expect(sql.prepare("SELECT owner_user_id, project_id FROM artifacts WHERE id = ?").get(id)).toEqual({
        owner_user_id: null,
        project_id: null,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTFORGE_SERVER;
      } else {
        process.env.AGENTFORGE_SERVER = previous;
      }
    }
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
