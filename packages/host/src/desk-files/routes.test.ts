/**
 * The desk file routes, called through the table the router will register, with two provisioned
 * tenants. The router is not involved: each case builds the request the dispatcher would hand over
 * (a verified session on it) and calls the handler. `tenancy-harness.test.ts` repeats the
 * cross-tenant cases through `dispatch` once the routes are registered.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import { MAX_FILE_BYTES } from "@agentforge/core/tools/files";
import { mediaRoot } from "../media-root";
import { forgetTenantJobBytes, resetObjectStoreForTests } from "../tenant-storage";
import "../tenant-storage-db";
import type { HostJsonResult, HostRequest, HostResult } from "../types";
import { DESK_FILE_ROUTES } from "./routes";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const LEAK_MARKER = "TENANT-A-SECRET-MARKER-9f2c";
const ALPHA = { id: "files-session-a", tenantId: "files-tenant-a", orgId: "files-org-a", userId: "files-user-a" };
const BETA = { id: "files-session-b", tenantId: "files-tenant-b", orgId: "files-org-b", userId: "files-user-b" };

type Who = typeof ALPHA;

let alphaDesk = "";

function handlerFor(method: string, path: string) {
  const found = DESK_FILE_ROUTES.find(([m, p]) => m === method && p === path);
  if (!found) {
    throw new Error(`${method} ${path} is not in DESK_FILE_ROUTES`);
  }
  return found[2];
}

async function call(
  who: Who,
  method: string,
  path: string,
  over: Partial<HostRequest> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await handlerFor(
    method,
    path,
  )({
    method,
    path,
    query: {},
    params: {},
    headers: {},
    session: { id: who.id, tenantId: who.tenantId, orgId: who.orgId, userId: who.userId },
    ...over,
  });
  const json = result as HostJsonResult;
  expect(json.type).toBe("json");
  return { status: json.status, body: json.body as Record<string, unknown> };
}

const put = (who: Who, path: string, content: string) =>
  call(who, "POST", "/api/v1/files", { body: { path, content } });

beforeAll(async () => {
  const a = await ensurePortalOwner(db, {
    tenantId: ALPHA.tenantId,
    orgId: ALPHA.orgId,
    userId: ALPHA.userId,
    role: "owner",
  });
  await ensurePortalOwner(db, { tenantId: BETA.tenantId, orgId: BETA.orgId, userId: BETA.userId, role: "owner" });
  alphaDesk = a.workspaceId;
});

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
  delete process.env.AGENTFORGE_TENANT_STORAGE_BYTES;
  sql.prepare("DELETE FROM tenant_storage").run();
  resetObjectStoreForTests();
  forgetTenantJobBytes();
});

afterAll(() => {
  sql.close();
});

describe("the route table", () => {
  it("is exactly the eight verbs, none of them by id", () => {
    expect(DESK_FILE_ROUTES.map(([method, path]) => `${method} ${path}`)).toEqual([
      "GET /api/v1/files",
      "GET /api/v1/files/content",
      "GET /api/v1/files/download",
      "GET /api/v1/files/versions",
      "GET /api/v1/files/version",
      "POST /api/v1/files",
      "POST /api/v1/files/revert",
      "DELETE /api/v1/files",
    ]);
    expect(DESK_FILE_ROUTES.some(([, path]) => path.includes(":"))).toBe(false);
  });
});

describe("a person's files, end to end", () => {
  it("saves, edits, lists, reads history, reverts and deletes", async () => {
    const created = await put(ALPHA, "notes/plan.md", "1. gather\n2. draft\n");
    expect(created).toEqual({ status: 200, body: { status: "saved", path: "notes/plan.md", version: 1 } });
    expect((await put(ALPHA, "notes/plan.md", "1. gather\n2. rewrite\n")).body).toEqual({
      status: "saved",
      path: "notes/plan.md",
      version: 2,
    });

    const content = await call(ALPHA, "GET", "/api/v1/files/content", { query: { path: "notes/plan.md" } });
    expect(content.status).toBe(200);
    expect(content.body).toEqual({
      path: "notes/plan.md",
      text: "1. gather\n2. rewrite\n",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: 21,
      version: 2,
    });

    const history = await call(ALPHA, "GET", "/api/v1/files/versions", { query: { path: "notes/plan.md" } });
    expect(history.body).toEqual({
      items: [
        {
          version: 1,
          bytes: 19,
          sha256: expect.any(String),
          authorKind: "user",
          authorId: ALPHA.userId,
          mode: null,
          createdAt: expect.any(Number),
        },
        {
          version: 2,
          bytes: 21,
          sha256: expect.any(String),
          authorKind: "user",
          authorId: ALPHA.userId,
          mode: null,
          createdAt: expect.any(Number),
        },
      ],
    });

    const first = await call(ALPHA, "GET", "/api/v1/files/version", { query: { path: "notes/plan.md", version: "1" } });
    expect(first.body).toMatchObject({ text: "1. gather\n2. draft\n", version: 1 });

    const reverted = await call(ALPHA, "POST", "/api/v1/files/revert", { body: { path: "notes/plan.md", version: 1 } });
    expect(reverted.body).toEqual({ status: "saved", path: "notes/plan.md", version: 3 });
    expect(
      (await call(ALPHA, "GET", "/api/v1/files/content", { query: { path: "notes/plan.md" } })).body,
    ).toMatchObject({
      text: "1. gather\n2. draft\n",
      version: 3,
    });

    const listed = await call(ALPHA, "GET", "/api/v1/files", { query: { dir: "notes", glob: "notes/*.md" } });
    expect(listed.body).toEqual({
      items: [{ path: "notes/plan.md", kind: "file", bytes: 19, updatedAt: expect.any(Number), version: 3 }],
    });
    expect((await call(ALPHA, "GET", "/api/v1/files", { query: { glob: "*.txt" } })).body).toEqual({ items: [] });

    const removed = await call(ALPHA, "DELETE", "/api/v1/files", { query: { path: "notes/plan.md" } });
    expect(removed).toEqual({ status: 200, body: { status: "saved", path: "notes/plan.md", version: 3 } });
    const gone = await call(ALPHA, "GET", "/api/v1/files/content", { query: { path: "notes/plan.md" } });
    expect(gone).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "No file at that path." } },
    });
  });
});

describe("another tenant's files", () => {
  const SECRET_PATH = "private/budget.md";

  beforeAll(async () => {
    await put(ALPHA, SECRET_PATH, `${LEAK_MARKER} the real numbers`);
    await put(ALPHA, SECRET_PATH, `${LEAK_MARKER} the real numbers, revised`);
  });

  const probes: Array<[string, string, string, (path: string) => Partial<HostRequest>]> = [
    ["read", "GET", "/api/v1/files/content", (path) => ({ query: { path } })],
    ["history", "GET", "/api/v1/files/versions", (path) => ({ query: { path } })],
    ["download", "GET", "/api/v1/files/download", (path) => ({ query: { path } })],
    ["one version", "GET", "/api/v1/files/version", (path) => ({ query: { path, version: "1" } })],
    ["revert", "POST", "/api/v1/files/revert", (path) => ({ body: { path, version: 1 } })],
    ["delete", "DELETE", "/api/v1/files", (path) => ({ query: { path } })],
  ];

  it.each(probes)(
    "%s answers 404, and exactly as it answers a path nobody has",
    async (_name, method, route, build) => {
      const theirs = await call(BETA, method, route, build(SECRET_PATH));
      const nobody = await call(BETA, method, route, build("private/never-written.md"));
      expect(theirs.status).toBe(404);
      expect(theirs).toEqual(nobody);
      expect(JSON.stringify(theirs.body)).not.toContain(LEAK_MARKER);
      expect(theirs.body).toEqual({ error: { code: "not_found", message: "No file at that path." } });
    },
  );

  it("lists and searches nothing of it", async () => {
    const listed = await call(BETA, "GET", "/api/v1/files", {});
    expect(listed).toEqual({ status: 200, body: { items: [] } });
    expect((await call(BETA, "GET", "/api/v1/files", { query: { dir: "private" } })).body).toEqual({ items: [] });
  });

  it("answers 404 when the other tenant names this tenant's desk", async () => {
    const aimed = await call(BETA, "GET", "/api/v1/files", { workspaceId: alphaDesk });
    expect(aimed.status).toBe(404);
    expect(JSON.stringify(aimed.body)).not.toContain(LEAK_MARKER);
  });

  it("lets the other tenant use the same path for its own file, and touches nothing of the owner's", async () => {
    expect((await put(BETA, SECRET_PATH, "beta's own text")).body).toEqual({
      status: "saved",
      path: SECRET_PATH,
      version: 1,
    });
    expect((await call(BETA, "GET", "/api/v1/files/content", { query: { path: SECRET_PATH } })).body).toMatchObject({
      text: "beta's own text",
    });
    // And after everything above, the owner still reads their own latest version.
    expect((await call(ALPHA, "GET", "/api/v1/files/content", { query: { path: SECRET_PATH } })).body).toMatchObject({
      text: `${LEAK_MARKER} the real numbers, revised`,
      version: 2,
    });
  });
});

describe("downloading a file", () => {
  const withSession = (who: Who) => ({
    session: { id: who.id, tenantId: who.tenantId, orgId: who.orgId, userId: who.userId },
  });

  function download(who: Who | null, path: string): Promise<HostResult> {
    return handlerFor(
      "GET",
      "/api/v1/files/download",
    )({
      method: "GET",
      path: "/api/v1/files/download",
      query: { path },
      params: {},
      headers: {},
      ...(who ? withSession(who) : {}),
    });
  }

  function delivered(result: HostResult): Extract<HostResult, { type: "bytes" }> {
    if (result.type !== "bytes") {
      throw new Error(`expected bytes, got ${result.type}: ${JSON.stringify((result as HostJsonResult).body)}`);
    }
    return result;
  }

  const textOf = (result: Extract<HostResult, { type: "bytes" }>) => Buffer.from(result.bytes).toString("utf8");

  it("sends the saved text byte for byte, named by the file and not its folder", async () => {
    const text = "1. gather\n2. draft, with an accent: é, and a dash –\n";
    await put(ALPHA, "dl/notes/plan.md", text);
    const result = delivered(await download(ALPHA, "dl/notes/plan.md"));
    expect(result.status).toBe(200);
    expect(result.filename).toBe("plan.md");
    expect(result.contentType).toBe("text/markdown; charset=utf-8");
    expect(textOf(result)).toBe(text);
    expect(result.bytes.byteLength).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("is an inert attachment: never sniffed, never sandbox-free, never cached", async () => {
    await put(ALPHA, "dl/headers.md", "# hi\n");
    const { headers } = delivered(await download(ALPHA, "dl/headers.md"));
    expect(headers).toEqual({
      "Content-Disposition": 'attachment; filename="headers.md"',
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      // The adapter's default for bytes is an hour of private cache, which would hand back an old
      // version after an edit. A file the person edits is never served from a cache.
      "Cache-Control": "no-store",
    });
  });

  it("sends the newest version, and nothing once the file is deleted", async () => {
    await put(ALPHA, "dl/versions.txt", "first");
    await put(ALPHA, "dl/versions.txt", "second");
    expect(textOf(delivered(await download(ALPHA, "dl/versions.txt")))).toBe("second");
    await call(ALPHA, "DELETE", "/api/v1/files", { query: { path: "dl/versions.txt" } });
    const gone = await download(ALPHA, "dl/versions.txt");
    expect(gone).toMatchObject({ type: "json", status: 404 });
  });

  it("names a type for text the browser would not render, and a plain type for a path nobody typed", async () => {
    await put(ALPHA, "dl/data.csv", "a,b\n1,2\n");
    await put(ALPHA, "dl/config.json", '{"a":1}');
    await put(ALPHA, "dl/README", "no extension");
    expect(delivered(await download(ALPHA, "dl/data.csv")).contentType).toBe("text/csv; charset=utf-8");
    expect(delivered(await download(ALPHA, "dl/config.json")).contentType).toBe("application/json; charset=utf-8");
    expect(delivered(await download(ALPHA, "dl/README")).contentType).toBe("text/plain; charset=utf-8");
  });

  it("never names a renderable type, whatever the file is called, and keeps the file name", async () => {
    for (const name of ["page.html", "page.htm", "feed.xml"]) {
      await put(ALPHA, `dl/${name}`, "<script>alert(1)</script>");
      const result = delivered(await download(ALPHA, `dl/${name}`));
      expect(result.contentType, name).toBe("application/octet-stream");
      expect(result.filename, name).toBe(name);
      expect(textOf(result), name).toBe("<script>alert(1)</script>");
    }
  });

  it("builds the file name header the way the adapter does, for a name with spaces and non-Latin-1 text", async () => {
    await put(ALPHA, "dl/My plan (v2) ☕.md", "x");
    const result = delivered(await download(ALPHA, "dl/My plan (v2) ☕.md"));
    expect(result.filename).toBe("My plan (v2) ☕.md");
    expect(result.headers?.["Content-Disposition"]).toBe(
      "attachment; filename=\"My plan (v2) _.md\"; filename*=UTF-8''My%20plan%20%28v2%29%20%E2%98%95.md",
    );
  });

  it("carries the largest file a desk can hold", async () => {
    const big = "line of text\n".repeat(Math.floor(MAX_FILE_BYTES / 13));
    await put(ALPHA, "dl/big.txt", big);
    const result = delivered(await download(ALPHA, "dl/big.txt"));
    expect(result.bytes.byteLength).toBe(Buffer.byteLength(big, "utf8"));
    expect(textOf(result)).toBe(big);
  });

  it("works in server mode for the signed-in person, and answers 401 with no session", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    await put(BETA, "dl/hosted.md", "hosted text");
    expect(textOf(delivered(await download(BETA, "dl/hosted.md")))).toBe("hosted text");
    expect(await download(null, "dl/hosted.md")).toMatchObject({
      type: "json",
      status: 401,
      body: { error: { code: "session_required" } },
    });
  });

  it("works off the hosted server for the local desk, which a signed-in tenant cannot see", async () => {
    await call(ALPHA, "POST", "/api/v1/files", {
      session: undefined,
      body: { path: "dl/local.md", content: "local desk text" },
    });
    expect(textOf(delivered(await download(null, "dl/local.md")))).toBe("local desk text");
    expect(await download(ALPHA, "dl/local.md")).toMatchObject({ type: "json", status: 404 });
  });
});

describe("refusals", () => {
  async function refused(who: Who, method: string, route: string, over: Partial<HostRequest>) {
    const result = await call(who, method, route, over);
    const text = JSON.stringify(result.body);
    // A message that reaches a person or a model never carries the host's own paths.
    expect(text).not.toContain(process.env.AGENTFORGE_DATA_DIR ?? "no data dir");
    expect(text).not.toContain(mediaRoot());
    expect(text).not.toMatch(/node_modules|\.master-key|\bat .*\(.*:\d+:\d+\)/);
    return result;
  }

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a parent part", "../outside.md"],
    ["a drive letter", "C:/Windows/win.ini"],
    ["a backslash", "notes\\plan.md"],
    ["an empty part", "notes//plan.md"],
    ["a trailing slash", "notes/"],
    ["a NUL", "notes/pl\u0000an.md"],
    ["nine parts", "a/b/c/d/e/f/g/h/i.md"],
    ["241 characters", `${"a".repeat(241)}.md`],
  ])("refuses %s as a bad path on every verb that takes one", async (_name, bad) => {
    for (const [method, route, over] of [
      ["GET", "/api/v1/files/content", { query: { path: bad } }],
      ["GET", "/api/v1/files/download", { query: { path: bad } }],
      ["GET", "/api/v1/files/versions", { query: { path: bad } }],
      ["GET", "/api/v1/files/version", { query: { path: bad, version: "1" } }],
      ["GET", "/api/v1/files", { query: { dir: bad } }],
      ["POST", "/api/v1/files", { body: { path: bad, content: "x" } }],
      ["POST", "/api/v1/files/revert", { body: { path: bad, version: 1 } }],
      ["DELETE", "/api/v1/files", { query: { path: bad } }],
    ] as const) {
      const result = await refused(ALPHA, method, route, over);
      expect(result.status, `${method} ${route}`).toBe(400);
      expect((result.body.error as { code: string }).code, `${method} ${route}`).toBe("bad_path");
    }
  });

  it("refuses a body that is not what the route takes", async () => {
    const cases: Array<[Partial<HostRequest>, string]> = [
      [{ body: undefined }, "A JSON object body is required"],
      [{ body: ["x"] }, "A JSON object body is required"],
      [{ body: { content: "x" } }, "path is required"],
      [{ body: { path: 7, content: "x" } }, "path is required"],
      [{ body: { path: "a.md" } }, "content must be text"],
      [{ body: { path: "a.md", content: 12 } }, "content must be text"],
    ];
    for (const [over, message] of cases) {
      const result = await refused(ALPHA, "POST", "/api/v1/files", over);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: { code: "invalid_request", message } });
    }
  });

  it("refuses a version that is not a positive whole number", async () => {
    for (const version of [undefined, "", "0", "-1", "1.5", "abc", "1e3", "9999999999"]) {
      const result = await refused(ALPHA, "GET", "/api/v1/files/version", {
        query: version === undefined ? { path: "a.md" } : { path: "a.md", version },
      });
      expect(result.status, String(version)).toBe(400);
      expect(result.body).toEqual({
        error: { code: "invalid_request", message: "version must be a whole number from 1" },
      });
    }
    const body = await refused(ALPHA, "POST", "/api/v1/files/revert", { body: { path: "a.md", version: 0 } });
    expect(body.status).toBe(400);
  });

  it("refuses a glob that is too long", async () => {
    const result = await refused(ALPHA, "GET", "/api/v1/files", { query: { glob: "a".repeat(201) } });
    expect(result).toEqual({
      status: 400,
      body: { error: { code: "bad_pattern", message: "The glob is longer than 200 characters." } },
    });
  });

  it("answers 413 for a body over 2 MB, and 404 for a file that is not there", async () => {
    const big = await refused(ALPHA, "POST", "/api/v1/files", {
      body: { path: "big.txt", content: "a".repeat(MAX_FILE_BYTES + 1) },
    });
    expect(big).toEqual({
      status: 413,
      body: { error: { code: "too_large", message: "The content is larger than 2 MB." } },
    });
    const missing = await refused(ALPHA, "GET", "/api/v1/files/content", { query: { path: "never/written.md" } });
    expect(missing.status).toBe(404);
  });

  it("refuses NUL text as 400 with the denied code", async () => {
    const result = await refused(ALPHA, "POST", "/api/v1/files", { body: { path: "b.dat", content: "a\u0000b" } });
    expect(result).toEqual({
      status: 400,
      body: { error: { code: "denied", message: "Desk files are text. The content has a NUL character." } },
    });
  });
});

describe("the storage ceiling, in server mode", () => {
  it("answers 403 storage_quota_exceeded, the code the media routes use", async () => {
    process.env.AGENTFORGE_SERVER = "1";
    process.env.AGENTFORGE_TENANT_STORAGE_BYTES = "2500";

    expect((await put(BETA, "quota/small.md", "small")).status).toBe(200);
    const refused = await put(BETA, "quota/large.md", "x".repeat(4000));
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error: {
        code: "storage_quota_exceeded",
        message: expect.stringContaining("no storage space left"),
      },
    });
    // Nothing of the refused file exists.
    expect((await call(BETA, "GET", "/api/v1/files/content", { query: { path: "quota/large.md" } })).status).toBe(404);
  });
});
