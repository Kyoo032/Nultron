import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostRequest, HostResult } from "./types";

vi.mock("./gateway-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-gate")>();
  return { ...actual, requireGatewayAllowedFor: () => undefined };
});

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-knowledge-owned-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "./auth/session";
import { createMemorySessionStore } from "./auth/session-store";

const { dispatch } = await import("./router");

const PARTNER = "knowledge-owned";
const ORG_A = "org-owned-a";
const ORG_B = "org-owned-b";
const BODY_WORD = "lighthouseveneer";
const TITLE = "Harbor crane dossier";
const PEER_TITLE = "Peer port tariff note";
const PEER_WORD = "driftwoodmarlin";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let a1: Person;
let a2: Person;
let b1: Person;
let artifactId: string;
let cardId: string;
let peerCardId: string;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function request(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...over,
  };
}

function call(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): Promise<HostResult> {
  return dispatch(request(person, method, path, over), { serverMode: true, sessionStore });
}

function bodyText(result: HostResult): string {
  return JSON.stringify((result as { body?: unknown }).body ?? null);
}

beforeAll(async () => {
  sessionStore = createMemorySessionStore();
  a1 = await provision(ORG_A, "usr-owned-a1", "owner");
  a2 = await provision(ORG_A, "usr-owned-a2", "member");
  b1 = await provision(ORG_B, "usr-owned-b1", "owner");

  const { artifactStore } = await import("./artifacts");
  const { upsertWorkSource } = await import("./knowledge-ingest");
  const { artifactWorkCard } = await import("./work-cards");

  const saved = artifactStore().create(a1.tenant, {
    mode: "research",
    kind: "dossier",
    title: TITLE,
    mime: "text/markdown",
    body: `# ${TITLE}\n\nThe ${BODY_WORD} dossier covers port cranes.`,
    meta: {},
  });
  artifactId = saved.id;
  const card = await upsertWorkSource(
    a1.tenant,
    artifactWorkCard({ type: "Research", artifactId, title: TITLE, markdown: saved.body }),
  );
  if (card.status !== "indexed") {
    throw new Error(`A1's artifact card was not indexed: ${card.status}`);
  }
  cardId = card.source.id;

  const { sql } = await import("@agentforge/db");
  const peerId = crypto.randomUUID();
  sql
    .prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES (?, ?, 'research', 'dossier', ?, 'text/markdown', ?, '{}', 1, ?, ?)`,
    )
    .run(
      peerId,
      a2.tenant.workspaceId,
      PEER_TITLE,
      `The ${PEER_WORD} tariff applies from March.`,
      Date.now(),
      Date.now(),
    );
  const peer = await upsertWorkSource(
    a2.tenant,
    artifactWorkCard({
      type: "Research",
      artifactId: peerId,
      title: PEER_TITLE,
      markdown: `The ${PEER_WORD} tariff applies from March.`,
    }),
  );
  if (peer.status !== "indexed") {
    throw new Error(`peer card was not indexed: ${peer.status}`);
  }
  peerCardId = peer.source.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("hosted: the Sources list and the card's source", () => {
  it("lists the card to its maker, and not to another company", async () => {
    const asMaker = bodyText(await call(a1, "GET", "/api/v1/knowledge"));
    expect(asMaker).toContain(TITLE);

    const asOtherCompany = bodyText(await call(b1, "GET", "/api/v1/knowledge"));
    expect(asOtherCompany).not.toContain(TITLE);
    expect(asOtherCompany).not.toContain(BODY_WORD);
  });

  it("answers another company's source read as a miss, and the maker's as a hit", async () => {
    const { sourceIsVisible } = await import("./knowledge-visibility");
    expect(sourceIsVisible(a1.tenant, cardId)).toBe(true);
    expect(sourceIsVisible(b1.tenant, cardId)).toBe(false);
    expect(sourceIsVisible(a2.tenant, peerCardId)).toBe(true);
  });
});

describe("hosted: retrieval", () => {
  it("never returns the card through knowledge_search to another company, and does to its maker", async () => {
    const { invokeTool } = await import("@agentforge/core");
    const { knowledgeSearchTool } = await import("./knowledge-search-tool");

    const asOtherCompany = JSON.stringify(
      await invokeTool(knowledgeSearchTool, { query: `${BODY_WORD} dossier` }, b1.tenant),
    );
    expect(asOtherCompany).not.toContain(BODY_WORD);

    const asMaker = JSON.stringify(await invokeTool(knowledgeSearchTool, { query: `${BODY_WORD} dossier` }, a1.tenant));
    expect(asMaker).toContain(BODY_WORD);
  });

  it("puts the card in its maker's Chat prompt", async () => {
    const { knowledgeInjection } = await import("./knowledge");

    const forMaker = await knowledgeInjection(a1.tenant, `${BODY_WORD} dossier`);
    expect(forMaker.prompt).toContain(BODY_WORD);
  });

  it("retrieves a colleague's card through knowledge_search", async () => {
    const { invokeTool } = await import("@agentforge/core");
    const { knowledgeSearchTool } = await import("./knowledge-search-tool");
    const found = JSON.stringify(await invokeTool(knowledgeSearchTool, { query: `${PEER_WORD} tariff` }, a1.tenant));
    expect(found).toContain(PEER_WORD);
  });
});

describe("hosted: meeting artifacts", () => {
  it("removes the meeting transcript and its row", async () => {
    const { artifactStore } = await import("./artifacts");
    const { removeMeetingArtifacts } = await import("./meeting/artifacts");
    const { sql } = await import("@agentforge/db");
    const transcript = artifactStore().create(a1.tenant, {
      mode: "meeting",
      kind: "transcript",
      title: "Board call transcript",
      mime: "text/markdown",
      body: "transcript body",
      meta: { meetingId: "meeting-cleanup-1" },
    });
    const record = { id: "meeting-cleanup-1", transcriptArtifactId: transcript.id } as Parameters<
      typeof removeMeetingArtifacts
    >[1];

    expect(removeMeetingArtifacts(a1.tenant, record)).toBe(1);
    expect(sql.prepare("SELECT id FROM artifacts WHERE id = ?").get(transcript.id)).toBeUndefined();
  });
});

describe("Personal parity: off server mode every card is shown", () => {
  it("lists the card to a colleague off server mode, as before", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "0");
    const { artifactStore } = await import("./artifacts");
    const { upsertWorkSource } = await import("./knowledge-ingest");
    const { artifactWorkCard } = await import("./work-cards");
    const { listSources } = await import("./knowledge");
    const personalWord = "copperkestrel";
    const saved = artifactStore().create(a1.tenant, {
      mode: "research",
      kind: "dossier",
      title: "Personal dossier",
      mime: "text/markdown",
      body: `The ${personalWord} note.`,
      meta: {},
    });
    const card = await upsertWorkSource(
      a1.tenant,
      artifactWorkCard({
        type: "Research",
        artifactId: saved.id,
        title: "Personal dossier",
        markdown: `The ${personalWord} note.`,
      }),
    );
    if (card.status !== "indexed") {
      throw new Error(`personal card was not indexed: ${card.status}`);
    }
    expect(listSources(a2.tenant).map((source) => source.name)).toContain("Personal dossier");
  });
});
