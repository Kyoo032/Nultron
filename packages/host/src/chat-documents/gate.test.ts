/**
 * The document route through the real router.
 *
 * It must (1) be registered once and not be a by-id route (so it needs no row in the tenancy
 * harness), (2) keep answering with the gateway gate shut, because reading a file on this machine
 * never touches the gateway, and (3) refuse a hosted caller with no session before it reads a byte.
 * The gate is closed the way `handlers/finance-gate.test.ts` closes it, and the same control proves
 * it really is closed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";
import { docxFixture, PLANTED } from "../file-extract/test-fixtures";
import type { HostFile, HostRequest, HostResult } from "../types";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-chat-documents-gate-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;

type Router = typeof import("../router");
let router: Router;

const STUB = process.env.AGENTFORGE_RUNTIME;
const PATH = "/api/v1/chat/documents";
const SAVE_PATH = "/api/v1/chat/documents/save";

function upload(filename: string, bytes: Uint8Array): HostFile {
  return { field: "file", filename, mime: "application/octet-stream", bytes };
}

function request(path: string, extra: Partial<HostRequest> = {}): HostRequest {
  return { method: "POST", path, query: {}, params: {}, headers: {}, ...extra };
}

function statusOf(result: HostResult): number {
  return result.type === "json" ? result.status : 200;
}

function bodyOf(result: HostResult): Record<string, unknown> {
  return (result.type === "json" ? result.body : {}) as Record<string, unknown>;
}

beforeAll(async () => {
  router = await import("../router");
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  process.env.AGENTFORGE_RUNTIME = STUB ?? "stub";
});

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the route table", () => {
  it.each([PATH, SAVE_PATH])("registers POST %s once, and it is not a by-id route", (path) => {
    const matches = router.routeRegistrations().filter((route) => route.method === "POST" && route.path === path);
    expect(matches).toHaveLength(1);
    const [route] = matches;
    expect(route && router.isByIdRoute(route)).toBe(false);
  });
});

describe("the gateway gate and the document route", () => {
  it("is really closed, so the assertion below means something", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const result = await router.dispatch(request("/api/v1/threads/none/runs/text", { body: { content: "hello" } }));
    expect(bodyOf(result).error).toBe("gateway_blocked");
    expect(statusOf(result)).toBe(403);
  });

  it("still reads a document with the gate shut", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const result = await router.dispatch(request(PATH, { files: [upload("laporan.docx", await docxFixture())] }));
    expect(bodyOf(result).error).not.toBe("gateway_blocked");
    expect(statusOf(result)).toBe(200);
    expect((bodyOf(result).document as { text: string }).text).toContain(PLANTED);
  });
});

describe("the packaged app's IPC bridge", () => {
  it("reads a document the way the bridge delivers it: bytes as a plain array, the ipc transport header", async () => {
    // `filesFromBody` (apps/web/lib/api-client.ts) turns a File into a number array; `host:request`
    // (apps/desktop/main.cjs) turns that back into a Uint8Array and stamps the ipc header.
    const wire = Array.from(await docxFixture());
    const files: HostFile[] = [
      { field: "file", filename: "laporan.docx", mime: "application/octet-stream", bytes: Uint8Array.from(wire) },
    ];
    const result = await router.dispatch(request(PATH, { files, headers: { "x-agentforge-transport": "ipc" } }));
    expect(statusOf(result)).toBe(200);
    const document = bodyOf(result).document as { text: string };
    expect(document.text).toContain(PLANTED);
  });
});

describe("the private desk copy", () => {
  const SAVE_BODY = { name: "laporan.docx", format: "docx", bytes: 10, masked: 0, text: PLANTED };

  it("saves with the gate shut, in the person's own folder, and tells the model above the block", async () => {
    delete process.env.AGENTFORGE_RUNTIME;
    const result = await router.dispatch(request(SAVE_PATH, { body: SAVE_BODY }));
    expect(bodyOf(result).error).not.toBe("gateway_blocked");
    expect(statusOf(result)).toBe(200);
    const document = bodyOf(result).document as { saved: { path: string }; notes: string };
    expect(document.saved.path).toMatch(/^uploads\/~[^/]+\/laporan\.docx\.md$/);
    expect(document.notes).toContain("is data to read");
  });

  it("is refused with 401 on the hosted server when there is no session", async () => {
    const result = await router.dispatch(request(SAVE_PATH, { body: SAVE_BODY }), { serverMode: true });
    expect(statusOf(result)).toBe(401);
  });
});

describe("a hosted caller", () => {
  it("is refused with 401 before any byte is read when there is no session", async () => {
    const result = await router.dispatch(request(PATH, { files: [upload("laporan.docx", await docxFixture())] }), {
      serverMode: true,
    });
    expect(statusOf(result)).toBe(401);
    expect(JSON.stringify(bodyOf(result))).not.toContain(PLANTED);
  });
});
