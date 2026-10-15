import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-docs-write-"));
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

const PARTNER = "docs-write-partner";
const ORG = "docs-write-org";
const MISSING = "00000000-0000-4000-8000-000000000000";
const OK = { status: 200 };
const CREATED = { status: 201 };
const NOT_FOUND = { status: 404, code: "not_found" };
const NOT_EDITABLE = { status: 409, code: "not_editable" };
const QUOTA = { status: 403, code: "storage_quota_exceeded" };
const SECTION_ID_SHAPE = /^s-[0-9a-f]{10}$/;

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

type SectionView = { id: string; heading?: string; blocks: Array<Record<string, unknown>> };

type DocSpecView = { sections: SectionView[] };

type DocBody = {
  artifactId: string;
  title: string;
  kind: string;
  headVersion: number;
  spec: DocSpecView;
  sectionAuthors: Record<string, { version: number; author: { kind: string; userId?: string } }>;
  proposals: unknown[];
};

type VersionItem = {
  version: number;
  note: string | null;
  changedSectionIds: string[];
  author: { kind: string; userId?: string };
};

type WriteAnswer = {
  headVersion: number;
  version: { version: number; note: string | null } | null;
  sectionAuthors: DocBody["sectionAuthors"];
  bodyRefreshed: boolean;
};

const WRITE_KEYS = ["bodyRefreshed", "headVersion", "sectionAuthors", "version"];
const VERSION_KEYS = ["author", "baseVersion", "changedSectionIds", "createdAt", "kind", "note", "version"];
const SECTION_CHANGED = (sectionIds: string[]) => ({
  error: { code: "section_changed", message: expect.any(String), sectionIds },
});
const INVALID_REQUEST = { error: { code: "invalid_request", message: expect.any(String) } };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ben: Person;
let cara: Person;
let dan: Person;
let project: string;

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

function readFile(person: Person, artifactId: string, n: string, format: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/docs/:artifactId/versions/:n/file", { artifactId, n }, undefined, { format });
}

function readArtifactFile(person: Person, artifactId: string): Promise<HostResult> {
  return call(person, "GET", "/api/v1/artifacts/:artifactId/file", { artifactId });
}

function putSection(
  person: Person,
  artifactId: string,
  sectionId: string,
  baseVersion: number,
  section: Record<string, unknown>,
): Promise<HostResult> {
  return call(
    person,
    "PUT",
    "/api/v1/docs/:artifactId/sections/:sectionId",
    { artifactId, sectionId },
    { baseVersion, section },
  );
}

function addSection(
  person: Person,
  artifactId: string,
  baseVersion: number,
  section: Record<string, unknown>,
  afterSectionId?: string,
): Promise<HostResult> {
  return call(
    person,
    "POST",
    "/api/v1/docs/:artifactId/sections",
    { artifactId },
    { baseVersion, section, ...(afterSectionId === undefined ? {} : { afterSectionId }) },
  );
}

function removeSection(
  person: Person,
  artifactId: string,
  sectionId: string,
  baseVersion: number,
): Promise<HostResult> {
  return call(
    person,
    "DELETE",
    "/api/v1/docs/:artifactId/sections/:sectionId",
    { artifactId, sectionId },
    { baseVersion },
  );
}

function restoreVersion(person: Person, artifactId: string, n: number, baseVersion: number): Promise<HostResult> {
  return call(
    person,
    "POST",
    "/api/v1/docs/:artifactId/versions/:n/restore",
    { artifactId, n: String(n) },
    { baseVersion },
  );
}

function paragraph(text: string): Record<string, unknown> {
  return { blocks: [{ type: "paragraph", text }] };
}

function sectionOf(spec: DocSpecView, id: string): SectionView | undefined {
  return spec.sections.find((section) => section.id === id);
}

async function headSpec(person: Person, artifactId: string): Promise<DocSpecView> {
  return jsonBody<DocBody>(await readDoc(person, artifactId)).spec;
}

async function versionsOf(person: Person, artifactId: string): Promise<VersionItem[]> {
  return jsonBody<{ items: VersionItem[] }>(await readVersions(person, artifactId)).items;
}

async function writeAnswers(person: Person, artifactId: string) {
  const answers = [
    await putSection(person, artifactId, "intro", 1, paragraph("A stranger's edit.")),
    await addSection(person, artifactId, 1, paragraph("A stranger's section.")),
    await removeSection(person, artifactId, "intro", 1),
    await restoreVersion(person, artifactId, 1, 1),
  ];
  return answers.map((answer) => ({
    status: answer.status,
    body: answer.type === "json" ? (answer as HostJsonResult).body : null,
  }));
}

async function makeProject(person: Person, name: string): Promise<string> {
  const result = await call(person, "POST", "/api/v1/projects", {}, { name });
  expect(result.status).toBe(201);
  return jsonBody<{ project: { id: string } }>(result).project.id;
}

function addToProject(person: Person, projectId: string, artifactId: string): Promise<HostResult> {
  return call(person, "POST", "/api/v1/projects/:id/files", { id: projectId }, { artifactId });
}

async function freshDoc(): Promise<string> {
  const { createDocumentForTenant } = await import("./doc-tools/create-document");
  const { sampleDocInput } = await import("./doc-tools/doc-tools-fixtures");
  const made = await createDocumentForTenant({ format: "docx", spec: sampleDocInput() }, alice.tenant);
  if (!made.ok) {
    throw new Error(made.message);
  }
  expect(await outcome(await addToProject(alice, project, made.artifactId))).toEqual(OK);
  return made.artifactId;
}

describe("the document write routes: a Workspace's members edit one section at a time", () => {
  beforeAll(async () => {
    sessionStore = createMemorySessionStore();
    alice = await provision("alice", "owner");
    ben = await provision("ben", "member");
    cara = await provision("cara", "admin");
    dan = await provision("dan", "member");
    project = await makeProject(alice, "Forecast room");
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "ben" })),
    ).toEqual(CREATED);
    expect(
      await outcome(await call(alice, "POST", "/api/v1/projects/:id/members", { id: project }, { userId: "dan" })),
    ).toEqual(CREATED);
  }, ROUTER_IMPORT_BUDGET_MS);

  it("ben edits one section and alice another from the same base; both succeed and neither reverts the other", async () => {
    const id = await freshDoc();
    const benEdit = await putSection(ben, id, "intro", 1, { heading: "Introduction", ...paragraph("Ben's intro.") });
    expect(benEdit.status).toBe(200);
    const benAnswer = jsonBody<WriteAnswer>(benEdit);
    expect(Object.keys(benAnswer).sort()).toEqual(WRITE_KEYS);
    expect(benAnswer.version?.version).toBe(2);
    expect(benAnswer.headVersion).toBe(2);
    expect(benAnswer.bodyRefreshed).toBe(true);
    expect(benAnswer.sectionAuthors.intro).toEqual({ version: 2, author: { kind: "person", userId: "ben" } });

    const aliceEdit = await putSection(alice, id, "numbers", 1, {
      heading: "Numbers",
      ...paragraph("Alice's numbers."),
    });
    expect(aliceEdit.status).toBe(200);
    const aliceAnswer = jsonBody<WriteAnswer>(aliceEdit);
    expect(aliceAnswer.version?.version).toBe(3);
    expect(aliceAnswer.headVersion).toBe(3);
    expect(aliceAnswer.sectionAuthors.numbers).toEqual({ version: 3, author: { kind: "person", userId: "alice" } });
    expect(aliceAnswer.sectionAuthors.intro).toEqual({ version: 2, author: { kind: "person", userId: "ben" } });

    const spec = await headSpec(alice, id);
    expect(sectionOf(spec, "intro")?.blocks).toEqual([{ type: "paragraph", text: "Ben's intro." }]);
    expect(sectionOf(spec, "numbers")?.blocks).toEqual([{ type: "paragraph", text: "Alice's numbers." }]);
    expect(sectionOf(spec, "close")?.blocks).toEqual([{ type: "paragraph", text: "Next quarter we expand." }]);
  });

  it("an edit to a section someone changed after the base is 409 section_changed, and a base the file never had is bad_base", async () => {
    const id = await freshDoc();
    expect(await outcome(await putSection(ben, id, "intro", 1, paragraph("Ben's intro.")))).toEqual(OK);

    const stale = await putSection(alice, id, "intro", 1, paragraph("Alice's intro."));
    expect(stale.status).toBe(409);
    expect(jsonBody(stale)).toEqual(SECTION_CHANGED(["intro"]));
    expect(sectionOf(await headSpec(alice, id), "intro")?.blocks).toEqual([
      { type: "paragraph", text: "Ben's intro." },
    ]);

    expect(await outcome(await putSection(alice, id, "numbers", 9, paragraph("Too new.")))).toEqual({
      status: 409,
      code: "bad_base",
    });
    const tooOld = await putSection(alice, id, "numbers", 0, paragraph("Too old."));
    expect(tooOld.status).toBe(400);
    expect(jsonBody(tooOld)).toEqual(INVALID_REQUEST);
    expect((await versionsOf(alice, id)).map((item) => item.version)).toEqual([2, 1]);
  });

  it("a new section gets an id from the host after the named section, and a client-sent id is ignored", async () => {
    const id = await freshDoc();
    const added = await addSection(
      alice,
      id,
      1,
      { id: "client-picked", heading: "Risks", ...paragraph("New risk.") },
      "intro",
    );
    expect(added.status).toBe(201);
    const answer = jsonBody<WriteAnswer>(added);
    expect(Object.keys(answer).sort()).toEqual(WRITE_KEYS);
    expect(answer.version?.version).toBe(2);
    expect(answer.headVersion).toBe(2);

    const ids = (await headSpec(alice, id)).sections.map((section) => section.id);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe("intro");
    expect(ids[1]).toMatch(SECTION_ID_SHAPE);
    expect(ids.slice(2)).toEqual(["numbers", "close"]);
    expect(ids).not.toContain("client-picked");
    expect(answer.sectionAuthors[ids[1] as string]).toEqual({
      version: 2,
      author: { kind: "person", userId: "alice" },
    });

    const appended = await addSection(alice, id, 2, paragraph("Last note."));
    expect(appended.status).toBe(201);
    const after = (await headSpec(alice, id)).sections.map((section) => section.id);
    expect(after).toHaveLength(5);
    expect(after[4]).toMatch(SECTION_ID_SHAPE);
  });

  it("a deleted section is gone, the last remaining section cannot be deleted, and an unknown one is 404", async () => {
    const id = await freshDoc();
    expect(await outcome(await removeSection(alice, id, "intro", 1))).toEqual(OK);
    expect(await outcome(await removeSection(alice, id, "numbers", 2))).toEqual(OK);
    expect((await headSpec(alice, id)).sections.map((section) => section.id)).toEqual(["close"]);

    expect(await outcome(await removeSection(alice, id, "close", 3))).toEqual({ status: 409, code: "last_section" });
    expect(await outcome(await removeSection(alice, id, "ghost", 3))).toEqual({
      status: 404,
      code: "section_not_found",
    });
    expect((await headSpec(alice, id)).sections.map((section) => section.id)).toEqual(["close"]);
  });

  it("restoring version 1 appends a new version equal to it, noted restored v1, and keeps the history", async () => {
    const id = await freshDoc();
    const original = await headSpec(alice, id);
    expect(
      await outcome(await putSection(alice, id, "close", 1, { heading: "Close", ...paragraph("Revised close.") })),
    ).toEqual(OK);

    const restored = await restoreVersion(alice, id, 1, 2);
    expect(await outcome(restored)).toEqual(CREATED);
    expect(jsonBody<WriteAnswer>(restored).version).toMatchObject({ version: 3, note: "restored v1" });

    expect(await headSpec(alice, id)).toEqual(original);
    const listed = await versionsOf(alice, id);
    expect(listed.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(listed[0]?.note).toBe("restored v1");
    expect(listed[0]?.changedSectionIds).toEqual(["close"]);

    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const first = bytesOf(await readFile(alice, id, "1", "docx"));
    expect(await docxBodyText(first.bytes)).toContain("Next quarter we expand.");
  });

  it("every mutation answers the same five keys, its version carries no spec, and the head moves one step each time", async () => {
    const id = await freshDoc();
    const answers = [
      await putSection(alice, id, "intro", 1, paragraph("Shape intro.")),
      await addSection(alice, id, 2, paragraph("Shape added.")),
      await removeSection(alice, id, "numbers", 3),
      await restoreVersion(alice, id, 1, 4),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 201, 200, 201]);
    const bodies = answers.map((answer) => jsonBody<WriteAnswer>(answer));
    expect(bodies.map((body) => body.headVersion)).toEqual([2, 3, 4, 5]);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(WRITE_KEYS);
      expect(body.bodyRefreshed).toBe(true);
      expect(body.version).not.toBeNull();
      expect(Object.keys(body.version ?? {}).sort()).toEqual(VERSION_KEYS);
    }
    expect(bodies.map((body) => body.version?.version)).toEqual([2, 3, 4, 5]);
  });

  it("a delete from a base before a later change is 409 section_changed with that id, and removes nothing", async () => {
    const id = await freshDoc();
    expect(await outcome(await putSection(ben, id, "intro", 1, paragraph("Ben's intro.")))).toEqual(OK);

    const stale = await removeSection(alice, id, "intro", 1);
    expect(stale.status).toBe(409);
    expect(jsonBody(stale)).toEqual(SECTION_CHANGED(["intro"]));
    expect((await headSpec(alice, id)).sections.map((section) => section.id)).toEqual(["intro", "numbers", "close"]);
    expect((await versionsOf(alice, id)).map((item) => item.version)).toEqual([2, 1]);
  });

  it("DELETE reads baseVersion from the body: a query string alone is invalid_request and removes nothing", async () => {
    const id = await freshDoc();
    const answer = await call(
      alice,
      "DELETE",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: id, sectionId: "intro" },
      undefined,
      { baseVersion: "1" },
    );
    expect(answer.status).toBe(400);
    expect(jsonBody(answer)).toEqual(INVALID_REQUEST);
    expect((await headSpec(alice, id)).sections.map((section) => section.id)).toEqual(["intro", "numbers", "close"]);
    expect((await versionsOf(alice, id)).map((item) => item.version)).toEqual([1]);
  });

  it("a restore that would overwrite a section someone changed after the base is 409 section_changed", async () => {
    const id = await freshDoc();
    expect(await outcome(await putSection(ben, id, "intro", 1, paragraph("Ben's intro.")))).toEqual(OK);

    const refused = await restoreVersion(alice, id, 1, 1);
    expect(refused.status).toBe(409);
    expect(jsonBody(refused)).toEqual(SECTION_CHANGED(["intro"]));
    expect(sectionOf(await headSpec(alice, id), "intro")?.blocks).toEqual([
      { type: "paragraph", text: "Ben's intro." },
    ]);
    expect((await versionsOf(alice, id)).map((item) => item.version)).toEqual([2, 1]);
  });

  it("restoring the version the head already is writes nothing: 200, version null, the head and its authors unchanged", async () => {
    const id = await freshDoc();
    const answer = await restoreVersion(alice, id, 1, 1);
    expect(answer.status).toBe(200);
    expect(jsonBody(answer)).toEqual({
      headVersion: 1,
      version: null,
      sectionAuthors: {
        intro: { version: 1, author: { kind: "person", userId: "alice" } },
        numbers: { version: 1, author: { kind: "person", userId: "alice" } },
        close: { version: 1, author: { kind: "person", userId: "alice" } },
      },
      bodyRefreshed: true,
    });
    expect((await versionsOf(alice, id)).map((item) => item.version)).toEqual([1]);
  });

  it("the file a member downloads after an edit is the new content, not the content it was saved with", async () => {
    const id = await freshDoc();
    expect(
      await outcome(
        await putSection(alice, id, "intro", 1, { heading: "Introduction", ...paragraph("Refreshed intro words.") }),
      ),
    ).toEqual(OK);

    const file = bytesOf(await readArtifactFile(ben, id));
    expect(file.status).toBe(200);
    expect(startsWith(file.bytes, "PK")).toBe(true);
    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const text = await docxBodyText(file.bytes);
    expect(text).toContain("Refreshed intro words.");
    expect(text).not.toContain("Sales grew this quarter.");

    const version = bytesOf(await readFile(ben, id, "2", "docx"));
    expect(await docxBodyText(version.bytes)).toContain("Refreshed intro words.");
  });

  it("a workbook's section route and a file with no spec answer 409 not_editable to their maker, and 404 to anyone else", async () => {
    const { createWorkbookForTenant } = await import("./doc-tools/create-document");
    const { sampleWorkbookInput } = await import("./doc-tools/doc-tools-fixtures");
    const { artifactStore } = await import("./artifacts");
    const book = await createWorkbookForTenant({ spec: sampleWorkbookInput() }, alice.tenant);
    if (!book.ok) {
      throw new Error(book.message);
    }
    expect(
      await outcome(await putSection(alice, book.artifactId, "costs", 1, paragraph("A sheet."))),
      "workbook",
    ).toEqual(NOT_EDITABLE);

    const plainId = artifactStore().create(alice.tenant, {
      mode: "documents",
      kind: "draft",
      title: "plain notes",
      mime: "text/markdown",
      body: "# Plain notes",
      meta: {},
    }).id;
    expect(await outcome(await putSection(alice, plainId, "intro", 1, paragraph("No spec."))), "plain").toEqual(
      NOT_EDITABLE,
    );
    expect(await outcome(await putSection(ben, plainId, "intro", 1, paragraph("No spec."))), "stranger").toEqual(
      NOT_FOUND,
    );
  });

  it("a malformed body is invalid_request, a section that fails the schema is invalid_section, and both save nothing", async () => {
    const id = await freshDoc();
    const before = JSON.stringify(await versionsOf(alice, id));

    const noBase = await call(
      alice,
      "PUT",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: id, sectionId: "intro" },
      { section: paragraph("No base.") },
    );
    expect(noBase.status).toBe(400);
    expect(jsonBody(noBase)).toEqual(INVALID_REQUEST);
    const fractional = await call(
      alice,
      "PUT",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: id, sectionId: "intro" },
      { baseVersion: 1.5, section: paragraph("Fraction.") },
    );
    expect(jsonBody(fractional)).toEqual(INVALID_REQUEST);
    const noSection = await call(
      alice,
      "PUT",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: id, sectionId: "intro" },
      { baseVersion: 1 },
    );
    expect(noSection.status).toBe(400);
    expect(jsonBody(noSection)).toEqual(INVALID_REQUEST);
    const textSection = await putSection(alice, id, "intro", 1, "Plain text" as unknown as Record<string, unknown>);
    expect(textSection.status).toBe(400);
    expect(jsonBody(textSection)).toEqual(INVALID_REQUEST);
    const afterNotText = await call(
      alice,
      "POST",
      "/api/v1/docs/:artifactId/sections",
      { artifactId: id },
      { baseVersion: 1, afterSectionId: 7, section: paragraph("Bad after.") },
    );
    expect(jsonBody(afterNotText)).toEqual(INVALID_REQUEST);

    expect(await outcome(await putSection(alice, id, "intro", 1, { blocks: [{ type: "bogus" }] }))).toEqual({
      status: 400,
      code: "invalid_section",
    });

    const crowded = {
      blocks: Array.from({ length: 2000 }, (_, index) => ({ type: "paragraph", text: `Line ${index}` })),
    };
    expect(await outcome(await putSection(alice, id, "intro", 1, crowded))).toEqual({
      status: 400,
      code: "invalid_section",
    });
    expect(JSON.stringify(await versionsOf(alice, id))).toBe(before);
  });

  it("a render failure after an append leaves the version saved, the file is the head's render until a refresh catches up", async () => {
    const id = await freshDoc();
    expect(await outcome(await putSection(alice, id, "intro", 1, paragraph("Kept text.")))).toEqual(OK);

    const { docVersionStore } = await import("./doc-versions");
    const { refreshHeadBody } = await import("./doc-versions/render-head");
    const { replaceSection } = await import("./doc-model");
    const appended = docVersionStore().appendVersion(alice.tenant, id, {
      baseVersion: 2,
      author: { kind: "person" },
      edit: (head) =>
        head.kind === "document"
          ? {
              kind: "document",
              spec: replaceSection(head.spec, "close", {
                id: "close",
                heading: "Close",
                blocks: [{ type: "paragraph", text: "Unrendered close." }],
              }),
            }
          : head,
    });
    expect(appended).toMatchObject({ ok: true, head: { version: 3 } });

    const failed = await refreshHeadBody(alice.tenant, id, async () => {
      throw new Error("renderer is down");
    });
    expect(failed).toEqual({ ok: false, reason: "render_failed" });
    expect((await versionsOf(alice, id))[0]?.version).toBe(3);

    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const kept = bytesOf(await readArtifactFile(alice, id));
    expect(await docxBodyText(kept.bytes)).toContain("Kept text.");
    expect(await docxBodyText(kept.bytes)).toContain("Unrendered close.");

    expect(await refreshHeadBody(alice.tenant, id)).toEqual({ ok: true, version: 3 });
    const caught = bytesOf(await readArtifactFile(alice, id));
    expect(await docxBodyText(caught.bytes)).toContain("Unrendered close.");
  });

  it("C and D get 404 on every write route, identical to an unknown id, and change nothing", async () => {
    const id = await freshDoc();
    expect(
      await outcome(
        await call(alice, "DELETE", "/api/v1/projects/:id/members/:userId", { id: project, userId: "dan" }),
      ),
    ).toEqual(OK);
    const before = JSON.stringify(await versionsOf(alice, id));

    for (const stranger of [cara, dan]) {
      const who = stranger.tenant.userId;
      const real = await writeAnswers(stranger, id);
      const missing = await writeAnswers(stranger, MISSING);
      expect(real, who).toEqual(missing);
      for (const answer of real) {
        expect(answer.status, who).toBe(404);
        expect(answer.body, who).toEqual({ error: { code: "not_found", message: "Artifact not found" } });
      }
    }
    expect(JSON.stringify(await versionsOf(alice, id))).toBe(before);
    expect(await outcome(await putSection(ben, id, "intro", 1, paragraph("Ben still edits.")))).toEqual(OK);
  });

  it("a write past the hosted storage ceiling is 403 storage_quota_exceeded and saves no version", async () => {
    const id = await freshDoc();
    const before = JSON.stringify(await versionsOf(alice, id));
    const saved = process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "1";
    try {
      expect(await outcome(await putSection(alice, id, "intro", 1, paragraph("Too big to keep.")))).toEqual(QUOTA);
      expect(await outcome(await addSection(alice, id, 1, paragraph("Too big too.")))).toEqual(QUOTA);
    } finally {
      if (saved === undefined) {
        delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
      } else {
        process.env.AGENTFORGE_TENANT_STORAGE_BYTES = saved;
      }
    }
    expect(JSON.stringify(await versionsOf(alice, id))).toBe(before);
    expect(sectionOf(await headSpec(alice, id), "intro")?.blocks).toEqual([
      { type: "paragraph", text: "Sales grew this quarter." },
    ]);
  });
});

describe("Personal: one person, no server mode, the same write routes", () => {
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

  const personal = (
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<HostResult> => {
    const request: HostRequest = {
      method,
      path: path.replace(/:([A-Za-z]+)/g, (_match, key: string) => params[key] ?? ""),
      query,
      params,
      headers: {},
      ...(body === undefined ? {} : { body }),
    };
    return dispatch(request, { serverMode: false });
  };

  it("edits, adds, removes and restores a section with no sign-in, and the download follows", async () => {
    const intro = await personal(
      "PUT",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: docId, sectionId: "intro" },
      { baseVersion: 1, section: { heading: "Introduction", ...paragraph("Desk intro.") } },
    );
    expect(intro.status).toBe(200);
    expect(jsonBody<WriteAnswer>(intro).version?.version).toBe(2);

    const added = await personal(
      "POST",
      "/api/v1/docs/:artifactId/sections",
      { artifactId: docId },
      { baseVersion: 2, afterSectionId: "intro", section: paragraph("Desk added.") },
    );
    expect(added.status).toBe(201);
    const current = jsonBody<DocBody>(await personal("GET", "/api/v1/docs/:artifactId", { artifactId: docId }));
    const addedId = current.spec.sections[1]?.id ?? "";
    expect(addedId).toMatch(SECTION_ID_SHAPE);

    const removed = await personal(
      "DELETE",
      "/api/v1/docs/:artifactId/sections/:sectionId",
      { artifactId: docId, sectionId: addedId },
      { baseVersion: 3 },
    );
    expect(removed.status).toBe(200);
    expect(Object.keys(jsonBody<WriteAnswer>(removed)).sort()).toEqual(WRITE_KEYS);

    const restored = await personal(
      "POST",
      "/api/v1/docs/:artifactId/versions/:n/restore",
      { artifactId: docId, n: "1" },
      { baseVersion: 4 },
    );
    expect(restored.status).toBe(201);
    expect(jsonBody<WriteAnswer>(restored).version?.version).toBe(5);

    const { docxBodyText } = await import("./doc-tools/doc-tools-fixtures");
    const file = bytesOf(await personal("GET", "/api/v1/artifacts/:artifactId/file", { artifactId: docId }));
    expect(startsWith(file.bytes, "PK")).toBe(true);
    expect(await docxBodyText(file.bytes)).toContain("Sales grew this quarter.");
    expect(await docxBodyText(file.bytes)).not.toContain("Desk intro.");
  });

  it("an unknown id is the same 404 on every write route", async () => {
    const answers = [
      await personal(
        "PUT",
        "/api/v1/docs/:artifactId/sections/:sectionId",
        { artifactId: MISSING, sectionId: "intro" },
        { baseVersion: 1, section: paragraph("Nobody.") },
      ),
      await personal(
        "POST",
        "/api/v1/docs/:artifactId/sections",
        { artifactId: MISSING },
        { baseVersion: 1, section: paragraph("Nobody.") },
      ),
      await personal(
        "DELETE",
        "/api/v1/docs/:artifactId/sections/:sectionId",
        { artifactId: MISSING, sectionId: "intro" },
        { baseVersion: 1 },
      ),
      await personal(
        "POST",
        "/api/v1/docs/:artifactId/versions/:n/restore",
        { artifactId: MISSING, n: "1" },
        { baseVersion: 1 },
      ),
    ];
    for (const answer of answers) {
      expect(await outcome(answer)).toEqual(NOT_FOUND);
    }
  });
});

afterAll(async () => {
  process.env.AGENTFORGE_SERVER = "1";
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
