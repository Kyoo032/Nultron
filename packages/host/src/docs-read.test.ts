import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-docs-read-"));
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
import type { HostBytesResult, HostJsonResult, HostRequest, HostResult } from "./types";

const { dispatch } = await import("./router");

const PARTNER = "docs-read-partner";
const ORG = "docs-read-org";
const MISSING = "00000000-0000-4000-8000-000000000000";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = "application/pdf";
const OK = { status: 200 };
const CREATED = { status: 201 };
const NOT_FOUND = { status: 404, code: "not_found" };
const BAD_FORMAT = { status: 400, code: "bad_format" };
const NOT_EDITABLE = { status: 409, code: "not_editable" };

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

type DocBody = {
  artifactId: string;
  title: string;
  kind: string;
  headVersion: number;
  spec: Record<string, unknown>;
  sectionAuthors: Record<string, { version: number; author: { kind: string; userId?: string } }>;
  proposals: unknown[];
};

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ben: Person;
let cara: Person;
let dan: Person;

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

function bytesOf(result: HostResult): HostBytesResult {
  expect(result.type).toBe("bytes");
  return result as HostBytesResult;
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  return Buffer.from(bytes).subarray(0, prefix.length).toString("latin1") === prefix;
}

function readDoc(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/docs/:artifactId", { artifactId });
}

function readVersions(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/docs/:artifactId/versions", { artifactId });
}

function readFile(person: Person, artifactId: string, n: string, format?: string): Promise<HostResult> {
  return call(
    person,
    "GET",
    "/api/v1/docs/:artifactId/versions/:n/file",
    { artifactId, n },
    undefined,
    format === undefined ? {} : { format },
  );
}

async function everyRoute(person: Person, artifactId: string) {
  const doc = await readDoc(person, artifactId);
  const versions = await readVersions(person, artifactId);
  const file = await readFile(person, artifactId, "1", "docx");
  return {
    doc: { status: doc.status, body: (doc as HostJsonResult).body ?? null },
    versions: { status: versions.status, body: (versions as HostJsonResult).body ?? null },
    file: { status: file.status, body: (file as HostJsonResult).body ?? null },
  };
}

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return jsonBody<{ project: { id: string } }>(result).project.id;
}

function addToProject(person: Person, projectId: string, artifactId: string): Promise<HostResult> {
  return call(person, "POST", "/api/v1/projects/:id/files", { id: projectId }, { artifactId });
}

describe("the document routes: a Workspace shares its files with its members only", () => {
  let project: string;
  let docId: string;
  let bookId: string;
  let loneId: string;
  let plainId: string;

  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("alice", "owner");
    ben = await provision("ben", "member");
    cara = await provision("cara", "admin");
    dan = await provision("dan", "member");
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
    const saved = await call(
      alice,
      "POST",
      "/api/v1/settings",
      {},
      { openaiApiKey: "sk-docs-read-test-aaaaaaaaaaaaaa" },
    );
    expect(saved.status).toBe(200);

    const { createDocumentForTenant, createWorkbookForTenant } = await import("./doc-tools/create-document");
    const { sampleDocInput, sampleWorkbookInput } = await import("./doc-tools/doc-tools-fixtures");
    const { artifactStore } = await import("./artifacts");

    project = await makeProject(alice, "Forecast room");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "ben" })),
    ).toEqual(CREATED);
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "dan" })),
    ).toEqual(CREATED);

    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice.tenant);
    if (!made.ok) {
      throw new Error(made.message);
    }
    docId = made.artifactId;
    expect(await outcome(await addToProject(alice, project, docId))).toEqual(OK);

    const book = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, alice.tenant);
    if (!book.ok) {
      throw new Error(book.message);
    }
    bookId = book.artifactId;
    expect(await outcome(await addToProject(alice, project, bookId))).toEqual(OK);

    const lone = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, ben.tenant);
    if (!lone.ok) {
      throw new Error(lone.message);
    }
    loneId = lone.artifactId;

    plainId = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "plain notes",
      mime: "text/markdown",
      body: "# Plain notes",
      meta: {},
    }).id;
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("A, the maker, and B, a member, read the Workspace document on all three routes", async () => {
    for (const person of [alice, ben]) {
      const who = person.tenant.userId;
      const doc = await readDoc(person, docId);
      expect(doc.status, who).toBe(200);
      const body = jsonBody<DocBody>(doc);
      expect(body, who).toMatchObject({
        artifactId: docId,
        title: "Quarterly review",
        kind: "document",
        headVersion: 1,
        proposals: [],
      });
      expect(Object.keys(body.sectionAuthors).sort(), who).toEqual(["close", "intro", "numbers"]);
      expect(body.sectionAuthors.intro, who).toEqual({ version: 1, author: { kind: "person", userId: "alice" } });

      const versions = await readVersions(person, docId);
      expect(versions.status, who).toBe(200);
      const items = jsonBody<{ items: Array<Record<string, unknown>> }>(versions).items;
      expect(
        items.map((item) => item.version),
        who,
      ).toEqual([1]);
      expect(items[0], who).not.toHaveProperty("spec");

      const docx = bytesOf(await readFile(person, docId, "1", "docx"));
      expect(docx.status, who).toBe(200);
      expect(startsWith(docx.bytes, "PK"), who).toBe(true);
      const pdf = bytesOf(await readFile(person, docId, "1", "pdf"));
      expect(pdf.status, who).toBe(200);
      expect(startsWith(pdf.bytes, "%PDF"), who).toBe(true);
    }
  });

  it("A and B read the Workspace workbook as a workbook, and download it as xlsx", async () => {
    for (const person of [alice, ben]) {
      const who = person.tenant.userId;
      const body = jsonBody<DocBody>(await readDoc(person, bookId));
      expect(body, who).toMatchObject({ artifactId: bookId, kind: "workbook", headVersion: 1 });
      const file = bytesOf(await readFile(person, bookId, "1", "xlsx"));
      expect(file.status, who).toBe(200);
      expect(startsWith(file.bytes, "PK"), who).toBe(true);
    }
  });

  it("D reads the Workspace while a member; once removed, D and C get 404 on every route, as an unknown id does", async () => {
    expect((await readDoc(dan, docId)).status).toBe(200);
    expect((await readVersions(dan, docId)).status).toBe(200);
    expect((await readFile(dan, docId, "1", "docx")).status).toBe(200);

    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/members/:userId", { id: project, userId: "dan" }),
      ),
    ).toEqual(OK);

    for (const stranger of [cara, dan]) {
      const who = stranger.tenant.userId;
      const real = await everyRoute(stranger, docId);
      expect(real.doc.status, who).toBe(404);
      expect(await everyRoute(stranger, MISSING), who).toEqual(real);
      expect((await readFile(stranger, bookId, "1", "xlsx")).status, who).toBe(404);
      expect(await readFile(stranger, bookId, "1", "xlsx"), who).toEqual(
        await readFile(stranger, MISSING, "1", "xlsx"),
      );
    }
    expect((await readDoc(ben, docId)).status).toBe(200);
  });

  it("a file with no Workspace is readable only by its maker: a company owner gets 404 for it", async () => {
    expect((await readDoc(ben, loneId)).status).toBe(200);
    expect((await readVersions(ben, loneId)).status).toBe(200);
    expect((await readFile(ben, loneId, "1", "docx")).status).toBe(200);

    for (const stranger of [alice, cara, dan]) {
      const who = stranger.tenant.userId;
      const real = await everyRoute(stranger, loneId);
      expect(real.doc.status, who).toBe(404);
      expect(await everyRoute(stranger, MISSING), who).toEqual(real);
    }
  });

  it("a file with no editable spec answers 409 to its maker and 404 to anyone else", async () => {
    expect(await outcome(await readDoc(alice, plainId))).toEqual(NOT_EDITABLE);
    expect(await outcome(await readVersions(alice, plainId))).toEqual(NOT_EDITABLE);
    expect(await outcome(await readFile(alice, plainId, "1", "docx"))).toEqual(NOT_EDITABLE);

    for (const stranger of [ben, cara]) {
      expect(await outcome(await readDoc(stranger, plainId)), stranger.tenant.userId).toEqual(NOT_FOUND);
    }
  });

  it("refuses a format the file does not allow with 400, and an unknown version with 404", async () => {
    expect(await outcome(await readFile(ben, docId, "1", "xlsx"))).toEqual(BAD_FORMAT);
    expect(await outcome(await readFile(ben, docId, "1", "pptx"))).toEqual(BAD_FORMAT);
    expect(await outcome(await readFile(ben, docId, "1"))).toEqual(BAD_FORMAT);
    expect(await outcome(await readFile(ben, bookId, "1", "docx"))).toEqual(BAD_FORMAT);
    expect(await outcome(await readFile(ben, bookId, "1", "pdf"))).toEqual(BAD_FORMAT);

    for (const n of ["99", "0", "abc", "1.5"]) {
      expect(await outcome(await readFile(ben, docId, n, "docx")), `version ${n}`).toEqual(NOT_FOUND);
    }
  });

  it("serves the file with the artifact download's headers", async () => {
    const pdf = bytesOf(await readFile(ben, docId, "1", "pdf"));
    expect(pdf.contentType).toBe(PDF);
    expect(pdf.filename).toBe("quarterly-review-v1.pdf");
    expect(pdf.headers?.["X-Content-Type-Options"]).toBe("nosniff");
    expect(pdf.headers?.["Content-Security-Policy"]).toBe("sandbox");
    expect(pdf.headers?.["Content-Disposition"]).toBe('attachment; filename="quarterly-review-v1.pdf"');

    const docx = bytesOf(await readFile(ben, docId, "1", "docx"));
    expect(docx.contentType).toBe(DOCX);
    expect(docx.headers?.["Content-Disposition"]).toBe('attachment; filename="quarterly-review-v1.docx"');
  });

  it("the versions list has no spec bodies, and version N renders version N's own spec", async () => {
    const { docVersionStore } = await import("./doc-versions");
    const { replaceSection } = await import("./doc-model");
    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const appended = await docVersionStore().appendVersion(alice.tenant, docId, {
      baseVersion: 1,
      author: { kind: "person" },
      edit: (head) =>
        head.kind === "document"
          ? {
              kind: "document",
              spec: replaceSection(head.spec, "close", {
                id: "close",
                heading: "Close",
                blocks: [{ type: "paragraph", text: "Revised close." }],
              }),
            }
          : head,
    });
    expect(appended).toMatchObject({ ok: true, head: { version: 2 } });

    const body = jsonBody<DocBody>(await readDoc(ben, docId));
    expect(body.headVersion).toBe(2);
    const listed = jsonBody<{ items: Array<Record<string, unknown>> }>(await readVersions(ben, docId)).items;
    expect(listed.map((item) => item.version)).toEqual([2, 1]);
    for (const item of listed) {
      expect(item).not.toHaveProperty("spec");
    }

    const first = bytesOf(await readFile(ben, docId, "1", "docx"));
    const second = bytesOf(await readFile(ben, docId, "2", "docx"));
    expect(startsWith(first.bytes, "PK")).toBe(true);
    expect(startsWith(second.bytes, "PK")).toBe(true);
    expect(await docxBodyText(first.bytes)).toContain("Next quarter we expand.");
    expect(await docxBodyText(first.bytes)).not.toContain("Revised close.");
    expect(await docxBodyText(second.bytes)).toContain("Revised close.");
    expect(await docxBodyText(second.bytes)).not.toContain("Next quarter we expand.");
  });
});

const LIMIT_ENV = "AGENTFORGE_TENANT_STORAGE_BYTES";

async function withCeiling<T>(bytes: number, run: () => Promise<T>): Promise<T> {
  const before = process.env[LIMIT_ENV];
  process.env[LIMIT_ENV] = String(bytes);
  try {
    return await run();
  } finally {
    if (before === undefined) {
      delete process.env[LIMIT_ENV];
    } else {
      process.env[LIMIT_ENV] = before;
    }
  }
}

describe("a document nobody has opened, at the storage ceiling", () => {
  it("reads as version 1 from its spec on all three routes, writes nothing, and a write still answers 403", async () => {
    const { createDocumentForTenant } = await import("./doc-tools/create-document");
    const { sampleDocInput, docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const { sql } = await import("@agentforge/db");
    const { STORAGE_BLOCK } = await import("@agentforge/core");
    const { tenantStorageReport } = await import("./tenant-storage");
    await import("./tenant-storage-db");
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice.tenant);
    if (!made.ok) {
      throw new Error(made.message);
    }
    const docId = made.artifactId;
    const rowOf = () => sql.prepare("SELECT body, meta, updated_at FROM artifacts WHERE id = ?").get(docId);
    const versionCount = (): number =>
      (sql.prepare("SELECT COUNT(*) AS n FROM doc_versions WHERE artifact_id = ?").get(docId) as { n: number }).n;
    const rowBefore = rowOf();
    const used = (await tenantStorageReport(PARTNER)).usedBytes;

    const atCeiling = await withCeiling(used + 1, async () => {
      const doc = await readDoc(alice, docId);
      expect(doc.status).toBe(200);
      const body = jsonBody<DocBody>(doc);
      expect(body.headVersion).toBe(1);
      const authors = Object.values(body.sectionAuthors);
      expect(authors.length).toBeGreaterThan(0);
      expect(authors.every((entry) => entry.version === 1 && entry.author.userId === "alice")).toBe(true);

      const versions = jsonBody<{ items: Array<Record<string, unknown>> }>(await readVersions(alice, docId));
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0]).toMatchObject({
        version: 1,
        baseVersion: null,
        note: null,
        author: { kind: "person", userId: "alice" },
      });

      expect(await outcome(await readFile(alice, docId, "2", "docx"))).toEqual(NOT_FOUND);
      const file = bytesOf(await readFile(alice, docId, "1", "docx"));
      expect(file.status).toBe(200);

      const write = await call(
        alice,
        "PUT",
        "/api/v1/docs/:artifactId/sections/:sectionId",
        { artifactId: docId, sectionId: "intro" },
        { baseVersion: 1, section: { blocks: [{ type: "paragraph", text: "Over the ceiling." }] } },
      );
      expect(await outcome(write)).toEqual({ status: 403, code: STORAGE_BLOCK });

      expect(versionCount()).toBe(0);
      expect(rowOf()).toEqual(rowBefore);
      return file;
    });

    const reread = jsonBody<DocBody>(await readDoc(alice, docId));
    expect(reread.headVersion).toBe(1);
    expect(versionCount()).toBe(1);
    const real = bytesOf(await readFile(alice, docId, "1", "docx"));
    expect(await docxBodyText(real.bytes)).toBe(await docxBodyText(atCeiling.bytes));
  });
});

describe("Personal: one person, no server mode, the same routes", () => {
  let docId: string;

  beforeAll(async () => {
    delete process.env.AGENTFORGE_SERVER;
    const { getTenant } = await import("./tenant");
    const { createDocumentForTenant } = await import("./doc-tools/create-document");
    const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
    const owner = await getTenant();
    const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, owner);
    if (!made.ok) {
      throw new Error(made.message);
    }
    docId = made.artifactId;
  });

  afterAll(() => {
    process.env.AGENTFORGE_SERVER = "1";
  });

  const personal = (method: string, path: string, params: Record<string, string>, query: Record<string, string> = {}) =>
    dispatch(
      {
        method,
        path: path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? ""),
        query,
        params,
        headers: {},
      },
      { serverMode: false },
    );

  it("reads the document, its versions and its downloads with no sign-in", async () => {
    const doc = await personal("GET", "/api/v1/docs/:artifactId", { artifactId: docId });
    expect(doc.status).toBe(200);
    expect(jsonBody<DocBody>(doc)).toMatchObject({
      artifactId: docId,
      kind: "document",
      headVersion: 1,
      proposals: [],
    });

    const versions = await personal("GET", "/api/v1/docs/:artifactId/versions", { artifactId: docId });
    expect(jsonBody<{ items: Array<{ version: number }> }>(versions).items.map((item) => item.version)).toEqual([1]);

    const file = bytesOf(
      await personal(
        "GET",
        "/api/v1/docs/:artifactId/versions/:n/file",
        { artifactId: docId, n: "1" },
        { format: "docx" },
      ),
    );
    expect(file.status).toBe(200);
    expect(startsWith(file.bytes, "PK")).toBe(true);
    expect(file.filename).toBe("quarterly-review-v1.docx");

    expect(
      await outcome(
        await personal(
          "GET",
          "/api/v1/docs/:artifactId/versions/:n/file",
          { artifactId: docId, n: "2" },
          { format: "docx" },
        ),
      ),
    ).toEqual(NOT_FOUND);
    expect(
      await outcome(
        await personal(
          "GET",
          "/api/v1/docs/:artifactId/versions/:n/file",
          { artifactId: docId, n: "1" },
          { format: "xlsx" },
        ),
      ),
    ).toEqual(BAD_FORMAT);
  });

  it("an unknown id is the same 404 on every route", async () => {
    for (const path of ["/api/v1/docs/:artifactId", "/api/v1/docs/:artifactId/versions"]) {
      expect(await outcome(await personal("GET", path, { artifactId: MISSING })), path).toEqual(NOT_FOUND);
    }
  });
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
