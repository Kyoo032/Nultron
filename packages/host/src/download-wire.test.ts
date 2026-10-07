/**
 * What the two Download buttons in Chat actually receive: the deck card's `.pptx` and a desk file.
 *
 * The route tests call a handler. This goes the rest of the way: a real HTTP socket through the real
 * `handleNodeRequest` (the webdev and packaged-server path), the real router with its session gate in
 * server mode (the hosted path), and the header composition the hosted adapter applies on top. Every
 * case reads the delivered bytes: the deck is opened as a zip and its slide parts are counted, the file
 * is compared with the text that was saved.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { PPTX_MIME } from "@agentforge/core/artifacts";
import type { DeskPath } from "@agentforge/core/tools/files";
import { db, ensurePortalOwner, sql } from "@agentforge/db";
import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";
import { buildDeckForTenant } from "./deck";
import type { BuildDeckInput } from "./deck";
import { createDeskRoot } from "./desk-files/store";
import { handleNodeRequest, writeHostResult } from "./http-adapter";
import { dispatch } from "./router";
import { applySecurityHeaders } from "./security-headers";
import { getTenant } from "./tenant";
import type { HostResult } from "./types";

process.env.AGENTFORGE_SECRETS_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const DECK: BuildDeckInput = {
  title: "Quarterly review",
  slides: [
    { kind: "bullets", heading: "Revenue grew", subhead: "", bullets: ["Up 12 percent"], aside: "", notes: "Say why." },
    { kind: "close", heading: "Next steps", subhead: "", bullets: ["Hire", "Ship"], aside: "", notes: "" },
  ],
};
const FILE_PATH = "reports/summary.md";
const FILE_TEXT = "# Summary\n\nRevenue grew 12 percent, with an accent: café.\n";

async function slideTexts(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => (await zip.file(name)?.async("string")) ?? ""));
}

async function seed(tenant: TenantContext) {
  const deck = await buildDeckForTenant(DECK, tenant);
  if (!deck.ok) {
    throw new Error(`deck was not built: ${deck.message}`);
  }
  const author = { kind: "user", userId: tenant.userId } as const;
  await createDeskRoot(tenant, author).write(FILE_PATH as DeskPath, FILE_TEXT, author);
  return deck;
}

afterEach(() => {
  delete process.env.AGENTFORGE_SERVER;
});

afterAll(() => {
  sql.close();
});

describe("off the hosted server, over a real socket (webdev and the packaged server)", () => {
  let server: Server;
  let base = "";
  let deck: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    deck = await seed(await getTenant());
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleNodeRequest(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends the deck as a zip with the PowerPoint type, the file name and the inert headers", async () => {
    const res = await fetch(`${base}/api/v1/artifacts/${deck.artifactId}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(PPTX_MIME);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${deck.filename}"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 4)).toString("latin1")).toBe("PK\u0003\u0004");
    const slides = await slideTexts(bytes);
    expect(slides).toHaveLength(3);
    expect(slides.join("\n")).toContain("Quarterly review");
    expect(slides.join("\n")).toContain("Revenue grew");
    expect(slides.join("\n")).toContain("Next steps");
  });

  it("sends a desk file byte for byte, as an attachment that is never cached", async () => {
    const res = await fetch(`${base}/api/v1/files/download?path=${encodeURIComponent(FILE_PATH)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="summary.md"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe(FILE_TEXT);
  });

  it("answers a path nobody wrote, and a path that is not a path, with the error envelope", async () => {
    const missing = await fetch(`${base}/api/v1/files/download?path=${encodeURIComponent("reports/none.md")}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No file at that path." } });
    const bad = await fetch(`${base}/api/v1/files/download?path=${encodeURIComponent("../etc/passwd")}`);
    expect(bad.status).toBe(400);
    const none = await fetch(`${base}/api/v1/files/download`);
    expect(none.status).toBe(400);
  });
});

describe("on the hosted server, through the real router and its session gate", () => {
  const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
  const OWNER = { tenantId: "wire-tenant-a", orgId: "wire-org-a", userId: "wire-user-a" };
  const OTHER = { tenantId: "wire-tenant-b", orgId: "wire-org-b", userId: "wire-user-b" };
  const store = createMemorySessionStore();
  const ownerSession = createSession({ ...OWNER, now: T0 });
  const otherSession = createSession({ ...OTHER, now: T0 });
  let deck: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    await ensurePortalOwner(db, { ...OWNER, role: "owner" });
    await ensurePortalOwner(db, { ...OTHER, role: "owner" });
    await store.create(ownerSession);
    await store.create(otherSession);
    deck = await seed(await getTenant({ session: ownerSession }));
  });

  const asSession = (id: string | null, path: string, query: Record<string, string> = {}): Promise<HostResult> => {
    process.env.AGENTFORGE_SERVER = "1";
    return dispatch(
      {
        method: "GET",
        path,
        query,
        params: {},
        headers: id ? { cookie: `${SESSION_COOKIE_SECURE}=${id}` } : {},
      },
      { serverMode: true, sessionStore: store, now: () => T0 },
    );
  };

  it("hands the signed-in person their deck and their file", async () => {
    const deckRes = await asSession(ownerSession.id, `/api/v1/artifacts/${deck.artifactId}/file`);
    expect(deckRes).toMatchObject({ type: "bytes", status: 200, contentType: PPTX_MIME, filename: deck.filename });
    if (deckRes.type !== "bytes") {
      return;
    }
    expect(await slideTexts(deckRes.bytes)).toHaveLength(3);

    const fileRes = await asSession(ownerSession.id, "/api/v1/files/download", { path: FILE_PATH });
    expect(fileRes).toMatchObject({ type: "bytes", status: 200, filename: "summary.md" });
    expect(fileRes.type === "bytes" ? Buffer.from(fileRes.bytes).toString("utf8") : "").toBe(FILE_TEXT);
  });

  it("gives another tenant the same 404 for both, and nothing of the content", async () => {
    const deckRes = await asSession(otherSession.id, `/api/v1/artifacts/${deck.artifactId}/file`);
    const ghostDeck = await asSession(otherSession.id, "/api/v1/artifacts/00000000-0000-4000-8000-000000000000/file");
    const fileRes = await asSession(otherSession.id, "/api/v1/files/download", { path: FILE_PATH });
    const ghostFile = await asSession(otherSession.id, "/api/v1/files/download", { path: "reports/none.md" });
    for (const result of [deckRes, ghostDeck, fileRes, ghostFile]) {
      expect(result.type).toBe("json");
      expect(result.status).toBe(404);
    }
    expect(JSON.stringify((fileRes as { body: unknown }).body)).not.toContain("Revenue");
    expect((fileRes as { body: unknown }).body).toEqual((ghostFile as { body: unknown }).body);
  });

  it("answers 401 to both with no session, before any handler runs", async () => {
    expect(await asSession(null, `/api/v1/artifacts/${deck.artifactId}/file`)).toMatchObject({
      type: "json",
      status: 401,
    });
    expect(await asSession(null, "/api/v1/files/download", { path: FILE_PATH })).toMatchObject({
      type: "json",
      status: 401,
    });
  });

  it("keeps the handler's own headers on top of the hosted page policy", async () => {
    const result = await asSession(ownerSession.id, "/api/v1/files/download", { path: FILE_PATH });
    const sent = new Map<string, string>();
    const sink = {
      statusCode: 0,
      setHeader: (name: string, value: string) => void sent.set(name.toLowerCase(), value),
      end: () => undefined,
    };
    // The order `handleNodeRequest` uses: the hosted security set first, then the handler's result.
    applySecurityHeaders(sink, true);
    expect(sent.get("content-security-policy")).not.toBe("sandbox");
    await writeHostResult(sink as unknown as ServerResponse, result);
    expect(sink.statusCode).toBe(200);
    expect(sent.get("content-security-policy")).toBe("sandbox");
    expect(sent.get("cache-control")).toBe("no-store");
    expect(sent.get("x-content-type-options")).toBe("nosniff");
    expect(sent.get("content-disposition")).toBe('attachment; filename="summary.md"');
    expect(sent.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(sent.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
