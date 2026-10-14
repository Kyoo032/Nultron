/**
 * A work card made from a person's own artifact is theirs alone, on the hosted server (SR-175,
 * team-board-spec.md section 2b, F0 knowledge half).
 *
 * An artifact a person makes is private to them (F0, `artifacts.owner_user_id`). Saving it makes a
 * Knowledge work card, and that card copies the artifact's body into the desk's knowledge. Before this
 * lane a knowledge source had no owner, so a colleague read the card through the Sources list, the
 * source itself, `knowledge_search` and the Chat prompt.
 *
 * Rule pinned here: a card whose artifact has an owner is visible only to that owner. A card made from
 * a legacy artifact (no owner) stays company-visible, as it was made. Personal writes no owner and
 * shows every card, as before.
 *
 * Real router, real sessions, a real database in a throwaway data dir. Company A has an owner (A1) and
 * a member (A2); company B has an owner (B1). Each refusal sits beside the maker reading the same thing,
 * so a server that refused everybody would fail here too.
 */
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
/** Only in the artifact body, so a hit on it can only be the card's own text. */
const BODY_WORD = "lighthouseveneer";
const TITLE = "Harbor crane dossier";
const LEGACY_TITLE = "Legacy port tariff note";
const LEGACY_WORD = "driftwoodmarlin";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let a1: Person;
let a2: Person;
let b1: Person;
let artifactId: string;
let cardId: string;
let legacyCardId: string;

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

  // A1 saves a Research dossier: the artifact is A1's, and its work card follows it (the generator path).
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

  // A legacy artifact: written with no owner, as every row was before F0. Its card is company-visible.
  const { sql } = await import("@agentforge/db");
  const legacyId = crypto.randomUUID();
  sql
    .prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES (?, ?, 'research', 'dossier', ?, 'text/markdown', ?, '{}', 1, ?, ?)`,
    )
    .run(
      legacyId,
      a2.tenant.workspaceId,
      LEGACY_TITLE,
      `The ${LEGACY_WORD} tariff applies from March.`,
      Date.now(),
      Date.now(),
    );
  const legacy = await upsertWorkSource(
    a2.tenant,
    artifactWorkCard({
      type: "Research",
      artifactId: legacyId,
      title: LEGACY_TITLE,
      markdown: `The ${LEGACY_WORD} tariff applies from March.`,
    }),
  );
  if (legacy.status !== "indexed") {
    throw new Error(`legacy card was not indexed: ${legacy.status}`);
  }
  legacyCardId = legacy.source.id;
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("hosted: the Sources list and the card's source", () => {
  it("lists the card to its maker, and to nobody else on the desk or in another company", async () => {
    const asMaker = bodyText(await call(a1, "GET", "/api/v1/knowledge"));
    expect(asMaker).toContain(TITLE);

    const asColleague = bodyText(await call(a2, "GET", "/api/v1/knowledge"));
    expect(asColleague).not.toContain(TITLE);
    expect(asColleague).not.toContain(BODY_WORD);
    expect(asColleague).toContain(LEGACY_TITLE);

    const asOtherCompany = bodyText(await call(b1, "GET", "/api/v1/knowledge"));
    expect(asOtherCompany).not.toContain(TITLE);
    expect(asOtherCompany).not.toContain(BODY_WORD);
  });

  it("does not let a colleague delete the card by id, and answers as for a card already gone", async () => {
    const { sql } = await import("@agentforge/db");
    const colleague = await call(a2, "DELETE", `/api/v1/knowledge/sources/${cardId}`, {
      params: { sourceId: cardId },
    });
    // The same `ok` a missing id gets (handlers/knowledge.ts), so the answer does not reveal the card.
    expect(colleague.status).toBe(200);
    expect(sql.prepare("SELECT count(*) AS n FROM knowledge_sources WHERE id = ?").get(cardId)).toEqual({ n: 1 });
    expect(bodyText(await call(a1, "GET", "/api/v1/knowledge"))).toContain(TITLE);
  });

  it("answers a colleague's source read as a miss, and the maker's as a hit", async () => {
    const { sourceIsVisible } = await import("./knowledge-visibility");
    expect(sourceIsVisible(a1.tenant, cardId)).toBe(true);
    expect(sourceIsVisible(a2.tenant, cardId)).toBe(false);
    expect(sourceIsVisible(b1.tenant, cardId)).toBe(false);
    expect(sourceIsVisible(a2.tenant, legacyCardId)).toBe(true);
  });

  it("keeps the card out of the desk-wide map's sources, for everybody", async () => {
    const { listMappableSources } = await import("./knowledge");
    expect(listMappableSources(a1.tenant).map((source) => source.id)).not.toContain(cardId);
    expect(listMappableSources(a2.tenant).map((source) => source.id)).not.toContain(cardId);
    expect(listMappableSources(a2.tenant).map((source) => source.id)).toContain(legacyCardId);
  });
});

describe("hosted: retrieval", () => {
  it("never returns the card through knowledge_search to a colleague, and does to its maker", async () => {
    const { invokeTool } = await import("@agentforge/core");
    const { knowledgeSearchTool } = await import("./knowledge-search-tool");

    const asColleague = JSON.stringify(
      await invokeTool(knowledgeSearchTool, { query: `${BODY_WORD} dossier` }, a2.tenant),
    );
    expect(asColleague).not.toContain(BODY_WORD);
    expect(asColleague).not.toContain(TITLE);

    const asOtherCompany = JSON.stringify(
      await invokeTool(knowledgeSearchTool, { query: `${BODY_WORD} dossier` }, b1.tenant),
    );
    expect(asOtherCompany).not.toContain(BODY_WORD);

    const asMaker = JSON.stringify(await invokeTool(knowledgeSearchTool, { query: `${BODY_WORD} dossier` }, a1.tenant));
    expect(asMaker).toContain(BODY_WORD);
  });

  it("keeps the card out of a colleague's Chat prompt, and puts it in its maker's", async () => {
    const { knowledgeInjection } = await import("./knowledge");

    const forColleague = await knowledgeInjection(a2.tenant, `${BODY_WORD} dossier`);
    expect(forColleague.prompt).not.toContain(BODY_WORD);
    expect(forColleague.chunks.map((chunk) => chunk.sourceId)).not.toContain(cardId);

    const forMaker = await knowledgeInjection(a1.tenant, `${BODY_WORD} dossier`);
    expect(forMaker.prompt).toContain(BODY_WORD);
  });

  it("still retrieves a legacy artifact's card for a colleague", async () => {
    const { invokeTool } = await import("@agentforge/core");
    const { knowledgeSearchTool } = await import("./knowledge-search-tool");
    const found = JSON.stringify(await invokeTool(knowledgeSearchTool, { query: `${LEGACY_WORD} tariff` }, a1.tenant));
    expect(found).toContain(LEGACY_WORD);
  });
});

describe("hosted: meeting artifacts are deleted under the owner rule", () => {
  it("does not delete a meeting transcript another person made, and does delete the maker's", async () => {
    const { artifactStore } = await import("./artifacts");
    const { removeMeetingArtifacts } = await import("./meeting/artifacts");
    const { sql } = await import("@agentforge/db");
    const transcript = artifactStore().create(a1.tenant, {
      mode: "meeting",
      kind: "transcript",
      title: "Board call transcript",
      mime: "text/markdown",
      body: "transcript body",
      meta: { meetingId: "meeting-owned-1" },
    });
    const record = { id: "meeting-owned-1", transcriptArtifactId: transcript.id } as Parameters<
      typeof removeMeetingArtifacts
    >[1];

    expect(removeMeetingArtifacts(a2.tenant, record)).toBe(0);
    expect(sql.prepare("SELECT id FROM artifacts WHERE id = ?").get(transcript.id)).toBeTruthy();

    expect(removeMeetingArtifacts(a1.tenant, record)).toBe(1);
    expect(sql.prepare("SELECT id FROM artifacts WHERE id = ?").get(transcript.id)).toBeUndefined();
  });
});

describe("hosted: Edit reads generated media only inside its own company", () => {
  it("loads a media row for its own company and never for another", async () => {
    const { db, media } = await import("@agentforge/db");
    const { loadMediaRow } = await import("./edit/wire-generate");
    const mediaId = crypto.randomUUID();
    await db.insert(media).values({
      id: mediaId,
      organizationId: ORG_A,
      userId: a1.tenant.userId,
      kind: "image",
      mime: "image/png",
      sizeBytes: 4,
      storagePath: "media/none.png",
      url: `/media/${mediaId}`,
    });
    expect(await loadMediaRow(mediaId, ORG_A)).not.toBeNull();
    expect(await loadMediaRow(mediaId, ORG_B)).toBeNull();
  });
});

describe("Personal parity: off server mode no owner is written and every card is shown", () => {
  it("writes no owner and lists the card to a colleague, as before", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "0");
    const { artifactStore } = await import("./artifacts");
    const { upsertWorkSource } = await import("./knowledge-ingest");
    const { artifactWorkCard } = await import("./work-cards");
    const { sql } = await import("@agentforge/db");
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
    const row = sql.prepare("SELECT owner_user_id FROM knowledge_sources WHERE id = ?").get(card.source.id) as {
      owner_user_id: string | null;
    };
    expect(row.owner_user_id).toBeNull();
    expect(listSources(a2.tenant).map((source) => source.name)).toContain("Personal dossier");
  });
});
