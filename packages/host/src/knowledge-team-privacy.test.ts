/**
 * Hosted team privacy: a person's Chat cards are theirs alone.
 *
 * On the hosted server several people share one company desk. Chat is private to the person
 * (owner decision, 2026-10-06): the card a Chat thread leaves in the Knowledge Base (`origin_kind =
 * 'thread'`) is visible only to the person who owns the thread, and **not** to the owner or an admin
 * of the company either. Before this, `knowledge_sources` was read by workspace alone, so a member's
 * Sources list, search, retrieval, `knowledge_search`, graph, map and reindex answers all carried
 * every colleague's conversations.
 *
 * Three people of ONE company on ONE desk (`ensurePortalOwner` gives them the same home desk): an
 * owner, and two members. Real rows in a throwaway data dir, real retrieval (FTS5 plus the local stub
 * vectors); only the gateway gate is stubbed open, because the hosted gate is closed until a company
 * key exists and none of these cases is about the key.
 *
 * Server mode is the environment variable, set per case with `vi.stubEnv` and read per call, which is
 * how every hosted-only rule below the router reads it. Dispatch gets `serverMode: true` as well,
 * for the session gate.
 *
 * The Personal half is pinned too (the last `describe`): off server mode the same reads return
 * everything on the desk, exactly as they did before this lane, and nothing is stamped on the map.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { invokeTool, type PortalRole, type TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import type { HostJsonResult, HostRequest, HostResult } from "./types";

vi.mock("./gateway-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-gate")>();
  return { ...actual, requireGatewayAllowedFor: () => undefined };
});

const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const WRAP_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

type Person = "owner" | "alice" | "bob";

/** One word per person, so a hit on it can only be that person's card. */
const WORD: Record<Person, string> = { owner: "ownerpelican", alice: "zanzibarite", bob: "quillfeather" };
const TITLE: Record<Person, string> = {
  owner: "Owner board memo",
  alice: "Secret merger plan",
  bob: "Bob lunch notes",
};
const SHARED_WORD = "harborzeppelin";
const SHARED_TITLE = "Harbor tariff memo";
const ARTIFACT_WORD = "harborcrane";
const ARTIFACT_TITLE = "Dossier harborcrane";

type Company = {
  readonly tenants: Record<Person, TenantContext>;
  readonly threadIds: Record<Person, string>;
  readonly cardIds: Record<Person, string>;
  readonly sharedId: string;
  readonly artifactCardId: string;
  readonly agentVersionIds: Record<Person, string>;
};

function hosted(on: boolean): void {
  vi.stubEnv("AGENTFORGE_SERVER", on ? "1" : "0");
  vi.stubEnv("AGENTFORGE_SECRETS_KEY", WRAP_KEY);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const cache = new Map<string, Promise<Company>>();

/**
 * One company per label, seeded once: an owner and two members on the company's home desk, each
 * with a thread and the Chat card that thread left; one file source Bob added; one Research card.
 */
function company(label: string): Promise<Company> {
  const found = cache.get(label);
  if (found) {
    return found;
  }
  const made = seed(label);
  cache.set(label, made);
  return made;
}

async function seed(label: string): Promise<Company> {
  hosted(false);
  const dbm = await import("@agentforge/db");
  const { agentService } = await import("./tenant");
  const { createThread } = await import("./threads");
  const { addPastedSource } = await import("./knowledge");
  const { upsertWorkSource } = await import("./knowledge-ingest");
  const { artifactWorkCard, chatWorkCard } = await import("./work-cards");

  const roles: Array<[Person, PortalRole]> = [
    ["owner", "owner"],
    ["alice", "member"],
    ["bob", "member"],
  ];
  const tenants = {} as Record<Person, TenantContext>;
  const threadIds = {} as Record<Person, string>;
  const cardIds = {} as Record<Person, string>;
  const agentVersionIds = {} as Record<Person, string>;
  for (const [person, role] of roles) {
    tenants[person] = await dbm.ensurePortalOwner(dbm.db, {
      tenantId: `tenant-priv-${label}`,
      orgId: `org-priv-${label}`,
      userId: `usr-${label}-${person}`,
      role,
    });
  }
  for (const [person] of roles) {
    const tenant = tenants[person];
    const chat = await agentService.ensureDefaultChat(tenant);
    agentVersionIds[person] = chat.version.id;
    const thread = await createThread(tenant, chat.agent.id, TITLE[person]);
    threadIds[person] = thread.id;
    const card = await upsertWorkSource(
      tenant,
      chatWorkCard({
        threadId: thread.id,
        title: TITLE[person],
        userText: `Our codename ${WORD[person]} plan is confidential`,
        assistantText: `Noted the ${WORD[person]} terms for you`,
      }),
    );
    if (card.status !== "indexed") {
      throw new Error(`${person}'s chat card was not indexed: ${card.status}`);
    }
    cardIds[person] = card.source.id;
  }
  const bobTenant = tenants.bob;
  const shared = await addPastedSource(
    bobTenant,
    SHARED_TITLE,
    `The ${SHARED_WORD} tariff on bulk cargo is 4.5 percent from March.`,
  );
  const artifactId = crypto.randomUUID();
  dbm.sql
    .prepare(
      `INSERT INTO artifacts (id, workspace_id, mode, kind, title, mime, body, meta, size_bytes, created_at, updated_at)
       VALUES (?, ?, 'research', 'dossier', ?, 'text/markdown', 'body', '{}', 4, ?, ?)`,
    )
    .run(artifactId, bobTenant.workspaceId, ARTIFACT_TITLE, Date.now(), Date.now());
  const artifactCard = await upsertWorkSource(
    bobTenant,
    artifactWorkCard({
      type: "Research",
      artifactId,
      title: ARTIFACT_TITLE,
      markdown: `The ${ARTIFACT_WORD} dossier covers port cranes.`,
    }),
  );
  if (artifactCard.status !== "indexed") {
    throw new Error(`artifact card was not indexed: ${artifactCard.status}`);
  }
  return {
    tenants,
    threadIds,
    cardIds,
    sharedId: shared.id,
    artifactCardId: artifactCard.source.id,
    agentVersionIds,
  };
}

const names = (items: ReadonlyArray<{ name: string }>): string[] => items.map((item) => item.name).sort();

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
});

describe("Sources list: a Chat card is its thread owner's alone", () => {
  it("lists a colleague's Chat card to nobody but its owner", async () => {
    const c = await company("list");
    const { listSources } = await import("./knowledge");
    hosted(true);

    const forBob = names(listSources(c.tenants.bob));
    expect(forBob).toEqual([ARTIFACT_TITLE, SHARED_TITLE, TITLE.bob].sort());
    const forAlice = names(listSources(c.tenants.alice));
    expect(forAlice).toEqual([ARTIFACT_TITLE, SHARED_TITLE, TITLE.alice].sort());
  });

  it("treats the company owner like any other non-owner of the thread: no role override", async () => {
    const c = await company("list");
    const { listSources } = await import("./knowledge");
    hosted(true);

    const forOwner = names(listSources(c.tenants.owner));
    expect(forOwner).toEqual([ARTIFACT_TITLE, SHARED_TITLE, TITLE.owner].sort());
    expect(forOwner).not.toContain(TITLE.alice);
    expect(forOwner).not.toContain(TITLE.bob);
  });

  it("shows every person the file sources and job cards, whoever added them", async () => {
    const c = await company("list");
    const { listSources } = await import("./knowledge");
    hosted(true);

    for (const person of ["owner", "alice", "bob"] as const) {
      const seen = names(listSources(c.tenants[person]));
      expect(seen, person).toContain(SHARED_TITLE);
      expect(seen, person).toContain(ARTIFACT_TITLE);
    }
  });

  it("hides the card of a thread that no longer exists, from everyone", async () => {
    const c = await company("orphan");
    const { sql } = await import("@agentforge/db");
    const { listSources } = await import("./knowledge");
    hosted(true);
    sql.prepare("DELETE FROM threads WHERE id = ?").run(c.threadIds.alice);

    for (const person of ["owner", "alice", "bob"] as const) {
      expect(names(listSources(c.tenants[person])), person).not.toContain(TITLE.alice);
    }
  });

  it("answers GET /api/v1/knowledge without a colleague's card, map or graph", async () => {
    const c = await company("route");
    const answer = await asPerson(c, "bob", "GET", "/api/v1/knowledge");
    expect(answer.status).toBe(200);
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(TITLE.alice);
    expect(text).not.toContain(TITLE.owner);
    expect(text).not.toContain(WORD.alice);
    expect(text).toContain(TITLE.bob);
  });
});

describe("Retrieval: search, vectors, Chat injection and the knowledge_search tool", () => {
  it("never retrieves a colleague's card (full text and vectors together)", async () => {
    const c = await company("retrieve");
    const { retrieveChunks } = await import("./knowledge");
    hosted(true);

    const asBob = await retrieveChunks(c.tenants.bob, `${WORD.alice} plan`, 8);
    expect(asBob.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
    expect(JSON.stringify(asBob.chunks)).not.toContain(WORD.alice);

    const asAlice = await retrieveChunks(c.tenants.alice, `${WORD.alice} plan`, 8);
    expect(asAlice.chunks.map((chunk) => chunk.sourceId)).toContain(c.cardIds.alice);
  });

  it("never retrieves it for the company owner either", async () => {
    const c = await company("retrieve");
    const { retrieveChunks } = await import("./knowledge");
    hosted(true);

    const asOwner = await retrieveChunks(c.tenants.owner, `${WORD.alice} plan`, 8);
    expect(asOwner.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
  });

  it("still retrieves the shared file and job card for everyone", async () => {
    const c = await company("retrieve");
    const { retrieveChunks } = await import("./knowledge");
    hosted(true);

    for (const person of ["owner", "alice", "bob"] as const) {
      const shared = await retrieveChunks(c.tenants[person], SHARED_WORD, 8);
      expect(
        shared.chunks.map((chunk) => chunk.sourceId),
        person,
      ).toContain(c.sharedId);
      const artifact = await retrieveChunks(c.tenants[person], ARTIFACT_WORD, 8);
      expect(
        artifact.chunks.map((chunk) => chunk.sourceId),
        person,
      ).toContain(c.artifactCardId);
    }
  });

  it("filters the full-text half on its own (the card has no vectors)", async () => {
    const c = await company("retrieve-fts");
    const { sql } = await import("@agentforge/db");
    const { retrieveChunks } = await import("./knowledge");
    sql
      .prepare("DELETE FROM knowledge_vectors WHERE workspace_id = ? AND source_id = ?")
      .run(c.tenants.alice.workspaceId, c.cardIds.alice);
    hosted(true);

    const asAlice = await retrieveChunks(c.tenants.alice, `${WORD.alice} plan`, 8);
    expect(asAlice.chunks.map((chunk) => chunk.sourceId)).toContain(c.cardIds.alice);
    const asBob = await retrieveChunks(c.tenants.bob, `${WORD.alice} plan`, 8);
    expect(asBob.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
  });

  it("filters the vector half on its own (the card has no full-text rows)", async () => {
    const c = await company("retrieve-vec");
    const { sql } = await import("@agentforge/db");
    const { retrieveChunks } = await import("./knowledge");
    const { openVectorBody } = await import("./knowledge-vector-seal");
    hosted(true);
    const rawBody = (
      sql
        .prepare("SELECT body FROM knowledge_vectors WHERE workspace_id = ? AND source_id = ? LIMIT 1")
        .get(c.tenants.alice.workspaceId, c.cardIds.alice) as { body: string }
    ).body;
    const body = openVectorBody(rawBody);
    sql
      .prepare("DELETE FROM knowledge_chunks WHERE workspace_id = ? AND source_id = ?")
      .run(c.tenants.alice.workspaceId, c.cardIds.alice);

    const asAlice = await retrieveChunks(c.tenants.alice, body, 8);
    expect(asAlice.chunks.map((chunk) => chunk.sourceId)).toContain(c.cardIds.alice);
    const asBob = await retrieveChunks(c.tenants.bob, body, 8);
    expect(asBob.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
    expect(JSON.stringify(asBob.chunks)).not.toContain(WORD.alice);
  });

  it("keeps a colleague's card out of the Chat prompt", async () => {
    const c = await company("retrieve");
    const { knowledgeInjection } = await import("./knowledge");
    hosted(true);

    const forBob = await knowledgeInjection(c.tenants.bob, `${WORD.alice} plan`, {
      excludeThreadId: c.threadIds.bob,
    });
    expect(forBob.prompt).not.toContain(WORD.alice);
    expect(forBob.prompt).not.toContain(TITLE.alice);
    expect(forBob.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);

    const forAlice = await knowledgeInjection(c.tenants.alice, `${WORD.alice} plan`, {
      excludeThreadId: c.threadIds.bob,
    });
    expect(forAlice.prompt).toContain(WORD.alice);
  });

  it("keeps it out of the knowledge_search tool, and says nothing that names it", async () => {
    const c = await company("retrieve");
    const { knowledgeSearchTool } = await import("./knowledge-search-tool");
    hosted(true);

    const asBob = JSON.stringify(await invokeTool(knowledgeSearchTool, { query: `${WORD.alice} plan` }, c.tenants.bob));
    expect(asBob).not.toContain(WORD.alice);
    expect(asBob).not.toContain(TITLE.alice);
    const asAlice = JSON.stringify(
      await invokeTool(knowledgeSearchTool, { query: `${WORD.alice} plan` }, c.tenants.alice),
    );
    expect(asAlice).toContain(WORD.alice);
  });

  it("answers a person with only a colleague's cards on the desk as an empty desk, not a miss", async () => {
    const c = await company("only-cards");
    const { sql } = await import("@agentforge/db");
    const { knowledgeSearchTool, KNOWLEDGE_SEARCH_EMPTY_DESK_NOTE } = await import("./knowledge-search-tool");
    // Leave only the two colleagues' Chat cards on the desk: Bob's own card and the shared sources go.
    sql
      .prepare("DELETE FROM knowledge_sources WHERE workspace_id = ? AND (origin_kind IS NOT 'thread' OR id = ?)")
      .run(c.tenants.bob.workspaceId, c.cardIds.bob);
    hosted(true);

    const asBob = (await invokeTool(knowledgeSearchTool, { query: `${WORD.alice} plan` }, c.tenants.bob)) as {
      results: unknown[];
      note?: string;
    };
    expect(asBob.results).toEqual([]);
    expect(asBob.note).toBe(KNOWLEDGE_SEARCH_EMPTY_DESK_NOTE);
  });
});

describe("What a thread was handed (the context popover record)", () => {
  it("never replays another person's chunks, even from a record written before this fix", async () => {
    const c = await company("last-turn");
    const { sql } = await import("@agentforge/db");
    const { insertRun, finishRun } = await import("./threads");
    const { lastTurnRetrieval } = await import("./knowledge-last-turn");
    const ws = c.tenants.bob.workspaceId;
    const run = await insertRun(c.tenants.bob, c.threadIds.bob, c.agentVersionIds.bob, "text");
    await finishRun(c.tenants.bob, run.id, "completed");
    const record = sql.prepare(
      `INSERT INTO knowledge_retrievals (id, workspace_id, thread_id, run_id, source_id, chunk_index, score, backend, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0.5, 'builtin', ?)`,
    );
    // The record an earlier build wrote: Bob's thread was handed Alice's card and the shared file.
    record.run(crypto.randomUUID(), ws, c.threadIds.bob, run.id, c.cardIds.alice, Date.now());
    record.run(crypto.randomUUID(), ws, c.threadIds.bob, run.id, c.sharedId, Date.now());

    hosted(true);
    const seen = lastTurnRetrieval(c.tenants.bob, c.threadIds.bob);
    expect(seen.chunks.map((chunk) => chunk.sourceName)).toEqual([SHARED_TITLE]);
    expect(JSON.stringify(seen)).not.toContain(WORD.alice);

    hosted(false);
    const onDesk = lastTurnRetrieval(c.tenants.bob, c.threadIds.bob);
    expect(onDesk.chunks.map((chunk) => chunk.sourceName).sort()).toEqual([SHARED_TITLE, TITLE.alice].sort());
  });
});

describe("Graph: nodes, edges and counts", () => {
  const seeded = new Map<Company, Promise<Record<string, string>>>();

  /** Once per company: a second seeding would add a second set of topics beside the first. */
  function seedGraph(c: Company): Promise<Record<string, string>> {
    const found = seeded.get(c);
    if (found) {
      return found;
    }
    const made = writeGraph(c);
    seeded.set(c, made);
    return made;
  }

  async function writeGraph(c: Company): Promise<Record<string, string>> {
    hosted(false);
    const { upsertEdges, upsertNodes } = await import("./knowledge-graph");
    const t = c.tenants.owner;
    const id = {
      topicShared: `topic:shared-${crypto.randomUUID()}`,
      topicMixed: `topic:mixed-${crypto.randomUUID()}`,
      topicAlice: `topic:alice-${crypto.randomUUID()}`,
    };
    upsertNodes(t, [
      { id: c.sharedId, kind: "source", label: SHARED_TITLE },
      { id: c.cardIds.alice, kind: "source", label: TITLE.alice },
      { id: c.cardIds.bob, kind: "source", label: TITLE.bob },
      { id: c.threadIds.alice, kind: "thread", label: TITLE.alice },
      { id: c.threadIds.bob, kind: "thread", label: TITLE.bob },
      { id: id.topicShared, kind: "topic", label: "Port tariffs" },
      { id: id.topicMixed, kind: "topic", label: "Merger and tariffs" },
      { id: id.topicAlice, kind: "topic", label: "Merger only" },
    ]);
    upsertEdges(t, [
      { from: id.topicShared, to: c.sharedId, kind: "covers" },
      { from: id.topicMixed, to: c.sharedId, kind: "covers" },
      { from: id.topicMixed, to: c.cardIds.alice, kind: "covers" },
      { from: id.topicAlice, to: c.cardIds.alice, kind: "covers" },
      { from: c.sharedId, to: c.threadIds.bob, kind: "retrieved", weight: 2 },
      { from: c.sharedId, to: c.threadIds.alice, kind: "retrieved", weight: 3 },
      { from: c.cardIds.alice, to: c.threadIds.bob, kind: "retrieved", weight: 1 },
      { from: c.cardIds.alice, to: c.threadIds.alice, kind: "cites", weight: 1 },
    ]);
    return id;
  }

  const labels = (graph: { nodes: ReadonlyArray<{ label: string }> }): string[] =>
    graph.nodes.map((node) => node.label).sort();

  it("draws only what the person may see, and counts the same", async () => {
    const c = await company("graph");
    await seedGraph(c);
    const { getGraph, graphCounts } = await import("./knowledge-graph");
    hosted(true);

    const bob = getGraph(c.tenants.bob);
    expect(labels(bob)).toEqual(["Bob lunch notes", "Bob lunch notes", "Harbor tariff memo", "Port tariffs"].sort());
    expect(bob.edges.map((edge) => `${edge.kind}:${edge.weight}`).sort()).toEqual(["covers:1", "retrieved:2"]);
    expect(JSON.stringify(bob)).not.toContain(TITLE.alice);
    expect(graphCounts(c.tenants.bob)).toEqual({ nodes: bob.nodes.length, edges: bob.edges.length });

    const alice = getGraph(c.tenants.alice);
    expect(labels(alice)).toEqual(
      [
        "Harbor tariff memo",
        "Merger and tariffs",
        "Merger only",
        "Port tariffs",
        "Secret merger plan",
        "Secret merger plan",
      ].sort(),
    );
    expect(alice.edges).toHaveLength(6);
    expect(graphCounts(c.tenants.alice)).toEqual({ nodes: alice.nodes.length, edges: alice.edges.length });

    const owner = getGraph(c.tenants.owner);
    expect(JSON.stringify(owner)).not.toContain(TITLE.alice);
    expect(JSON.stringify(owner)).not.toContain(TITLE.bob);
  });

  it("applies the node limit to what the person may see, never to the whole desk", async () => {
    const c = await company("graph");
    await seedGraph(c);
    const { getGraph } = await import("./knowledge-graph");
    hosted(true);

    const small = getGraph(c.tenants.bob, { limit: 2 });
    expect(JSON.stringify(small)).not.toContain(TITLE.alice);
    expect(small.nodes).toHaveLength(2);
    const visible = new Set([c.sharedId, c.cardIds.bob, c.threadIds.bob]);
    expect(small.nodes.filter((node) => node.kind !== "topic").every((node) => visible.has(node.id))).toBe(true);
  });

  it("answers GET /api/v1/knowledge/graph the same way", async () => {
    const c = await company("graph");
    await seedGraph(c);
    const answer = await asPerson(c, "bob", "GET", "/api/v1/knowledge/graph");
    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).not.toContain(TITLE.alice);
    expect(JSON.stringify(answer.body)).toContain(SHARED_TITLE);
  });

  it("does not expand into a source the person cannot see", async () => {
    const c = await company("graph");
    await seedGraph(c);
    const { expandRetrievedChunks } = await import("./knowledge-expand");
    const weakTop = {
      chunks: [{ body: "tariff", sourceId: c.sharedId, sourceName: SHARED_TITLE, score: 0.1, chunkIndex: 0 }],
      mode: "fts" as const,
      backend: "builtin" as const,
      vectorModel: null,
    };
    hosted(true);

    const forAlice = expandRetrievedChunks(c.tenants.alice, weakTop, { expand: true });
    expect(forAlice.chunks.map((chunk) => chunk.sourceId)).toContain(c.cardIds.alice);
    const forBob = expandRetrievedChunks(c.tenants.bob, weakTop, { expand: true });
    expect(forBob.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
    const forOwner = expandRetrievedChunks(c.tenants.owner, weakTop, { expand: true });
    expect(forOwner.chunks.map((chunk) => chunk.sourceId)).not.toContain(c.cardIds.alice);
  });
});

describe("Map: one map per desk, built from what is shared", () => {
  it("builds the hosted map from the shared sources only and stamps it", async () => {
    const c = await company("map");
    const { getKnowledgeMap, mapKnowledge } = await import("./knowledge-map");
    const { sql } = await import("@agentforge/db");
    hosted(true);

    const map = await mapKnowledge(c.tenants.alice);
    const titles = map.topics.map((topic) => topic.title).sort();
    expect(titles).toEqual([ARTIFACT_TITLE, SHARED_TITLE].sort());
    expect(JSON.stringify(map)).not.toContain(TITLE.alice);
    expect(JSON.stringify(map)).not.toContain(TITLE.bob);

    // Bob reads the map Alice made, and it names none of Alice's conversations.
    const forBob = getKnowledgeMap(c.tenants.bob);
    expect(forBob?.topics.map((topic) => topic.title).sort()).toEqual(titles);
    expect(JSON.stringify(forBob)).not.toContain(TITLE.alice);
    // The marker is stored, and never handed to the renderer.
    const stored = sql
      .prepare("SELECT payload FROM knowledge_maps WHERE workspace_id = ?")
      .get(c.tenants.alice.workspaceId) as { payload: string };
    expect(JSON.parse(stored.payload)).toHaveProperty("privacyScope");
    expect(forBob).not.toHaveProperty("privacyScope");
  });

  it("treats a hosted map saved before this fix as absent until the desk is mapped again", async () => {
    const c = await company("map-legacy");
    const { getKnowledgeMap } = await import("./knowledge-map");
    const { sql } = await import("@agentforge/db");
    const legacy = {
      overview: `Map that names ${TITLE.alice}`,
      topics: [{ title: TITLE.alice, summary: "x", sourceIds: [c.cardIds.alice], verdict: "stub", note: "" }],
      gaps: [],
      ready: true,
      source: "stub",
      embeddingModel: "m",
      brainModel: "m",
      verifierModel: "m",
      createdAt: Date.now(),
    };
    sql
      .prepare(
        `INSERT INTO knowledge_maps (workspace_id, payload, status, error, created_at) VALUES (?, ?, 'Mapped', NULL, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(c.tenants.bob.workspaceId, JSON.stringify(legacy), Date.now());

    hosted(true);
    expect(getKnowledgeMap(c.tenants.bob)).toBeNull();
    expect(getKnowledgeMap(c.tenants.alice)).toBeNull();
    const answer = await asPerson(c, "bob", "GET", "/api/v1/knowledge");
    expect((answer.body as { map: unknown }).map).toBeNull();
    expect(JSON.stringify(answer.body)).not.toContain(TITLE.alice);
  });

  it("keeps the stamp when a source is deleted, so the map does not vanish", async () => {
    const c = await company("map-forget");
    const { getKnowledgeMap, mapKnowledge } = await import("./knowledge-map");
    const { deleteSource } = await import("./knowledge");
    hosted(true);

    await mapKnowledge(c.tenants.bob);
    deleteSource(c.tenants.bob, c.artifactCardId);
    const after = getKnowledgeMap(c.tenants.bob);
    expect(after?.topics.map((topic) => topic.title)).toEqual([SHARED_TITLE]);
  });
});

describe("Reindex and delete: a hidden card is not there to touch", () => {
  it("does not reindex, report or name a colleague's card", async () => {
    const c = await company("reindex");
    const { reindexSource, reindexWorkspace } = await import("./knowledge-reindex");
    hosted(true);

    const one = await reindexSource(c.tenants.bob, c.cardIds.alice);
    expect(one).toEqual({ status: "missing", sourceId: c.cardIds.alice });

    const sweep = await reindexWorkspace(c.tenants.bob);
    expect(JSON.stringify(sweep)).not.toContain(TITLE.alice);
    expect(JSON.stringify(sweep)).not.toContain(c.cardIds.alice);
    expect(sweep.total).toBe(3);

    const own = await reindexSource(c.tenants.alice, c.cardIds.alice);
    expect(own.status).toBe("reindexed");
  });

  it("leaves a colleague's card in place when asked to delete it by id", async () => {
    const c = await company("delete");
    const { sql } = await import("@agentforge/db");
    const { listSources } = await import("./knowledge");
    const exists = (id: string): boolean =>
      (sql.prepare("SELECT count(*) AS n FROM knowledge_sources WHERE id = ?").get(id) as { n: number }).n === 1;
    const refused = await asPerson(c, "bob", "DELETE", `/api/v1/knowledge/sources/${c.cardIds.alice}`);
    // The same answer as for an id that was never there, and Alice's card is untouched.
    expect(refused.status).toBe(200);
    expect(exists(c.cardIds.alice)).toBe(true);
    hosted(true);
    expect(names(listSources(c.tenants.alice))).toContain(TITLE.alice);

    const ownDelete = await asPerson(c, "bob", "DELETE", `/api/v1/knowledge/sources/${c.cardIds.bob}`);
    expect(ownDelete.status).toBe(200);
    expect(exists(c.cardIds.bob)).toBe(false);
  });
});

describe("Personal parity: off server mode nothing changes", () => {
  it("reads every card on the desk, as before", async () => {
    const c = await company("parity");
    const { listSources, retrieveChunks, knowledgeInjection } = await import("./knowledge");
    hosted(false);

    expect(names(listSources(c.tenants.bob))).toEqual(
      [ARTIFACT_TITLE, SHARED_TITLE, TITLE.alice, TITLE.bob, TITLE.owner].sort(),
    );
    const found = await retrieveChunks(c.tenants.bob, `${WORD.alice} plan`, 8);
    expect(found.chunks.map((chunk) => chunk.sourceId)).toContain(c.cardIds.alice);
    const prompt = await knowledgeInjection(c.tenants.bob, `${WORD.alice} plan`, { excludeThreadId: c.threadIds.bob });
    expect(prompt.prompt).toContain(WORD.alice);
  });

  it("draws the whole graph and counts every node and edge", async () => {
    const c = await company("parity-graph");
    hosted(false);
    const { upsertEdges, upsertNodes, getGraph, graphCounts } = await import("./knowledge-graph");
    upsertNodes(c.tenants.owner, [
      { id: c.cardIds.alice, kind: "source", label: TITLE.alice },
      { id: c.threadIds.alice, kind: "thread", label: TITLE.alice },
      { id: "topic:parity", kind: "topic", label: "Merger only" },
    ]);
    upsertEdges(c.tenants.owner, [
      { from: "topic:parity", to: c.cardIds.alice, kind: "covers" },
      { from: c.cardIds.alice, to: c.threadIds.alice, kind: "cites" },
    ]);

    const graph = getGraph(c.tenants.bob);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.map((node) => node.label).sort()).toEqual(["Merger only", TITLE.alice, TITLE.alice].sort());
    expect(graph.edges).toHaveLength(2);
    expect(graphCounts(c.tenants.bob)).toEqual({ nodes: 3, edges: 2 });
  });

  it("maps every source on the desk and stamps nothing; reads an old map unchanged", async () => {
    const c = await company("parity-map");
    const { getKnowledgeMap, mapKnowledge } = await import("./knowledge-map");
    const { sql } = await import("@agentforge/db");
    hosted(false);

    const map = await mapKnowledge(c.tenants.alice);
    expect(map.topics.map((topic) => topic.title).sort()).toEqual(
      [ARTIFACT_TITLE, SHARED_TITLE, TITLE.alice, TITLE.bob, TITLE.owner].sort(),
    );
    const stored = sql
      .prepare("SELECT payload FROM knowledge_maps WHERE workspace_id = ?")
      .get(c.tenants.alice.workspaceId) as { payload: string };
    expect(JSON.parse(stored.payload)).not.toHaveProperty("privacyScope");
    expect(getKnowledgeMap(c.tenants.bob)?.topics).toHaveLength(5);

    // A map with no marker (every map a desk has ever saved) is read as it always was.
    sql
      .prepare("UPDATE knowledge_maps SET payload = ? WHERE workspace_id = ?")
      .run(JSON.stringify({ ...map, overview: "an older map" }), c.tenants.alice.workspaceId);
    expect(getKnowledgeMap(c.tenants.bob)?.overview).toBe("an older map");
  });

  it("reindexes and deletes by id exactly as before", async () => {
    const c = await company("parity-reindex");
    const { reindexSource, reindexWorkspace } = await import("./knowledge-reindex");
    const { deleteSource, listSources } = await import("./knowledge");
    hosted(false);

    expect((await reindexSource(c.tenants.bob, c.cardIds.alice)).status).toBe("reindexed");
    expect((await reindexWorkspace(c.tenants.bob)).total).toBe(5);
    expect(deleteSource(c.tenants.bob, c.cardIds.alice)).toBe(true);
    expect(names(listSources(c.tenants.bob))).not.toContain(TITLE.alice);
  });
});

/** One call through the real router as one person of the company, hosted. */
async function asPerson(
  c: Company,
  person: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const { dispatch } = await import("./router");
  const { createSession, sessionCookieName } = await import("./auth/session");
  const { createMemorySessionStore } = await import("./auth/session-store");
  const tenant = c.tenants[person];
  sessions ??= createMemorySessionStore();
  const session = createSession({
    tenantId: tenant.tenantId,
    orgId: tenant.organizationId,
    userId: tenant.userId,
    now: T0,
  });
  await sessions.create(session);
  hosted(true);
  const request: HostRequest = {
    method,
    path,
    query: {},
    params: {},
    // The hosted name: the gate reads it from the environment, which `hosted(true)` has just set.
    headers: { cookie: `${sessionCookieName({ secure: true })}=${session.id}` },
    body,
  };
  const result: HostResult = await dispatch(request, { serverMode: true, sessionStore: sessions, now: () => T0 });
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return { status: result.status, body: (result as HostJsonResult).body };
}

let sessions: ReturnType<typeof import("./auth/session-store").createMemorySessionStore> | undefined;

const COMPANIES = [
  "list",
  "orphan",
  "route",
  "retrieve",
  "retrieve-fts",
  "retrieve-vec",
  "only-cards",
  "last-turn",
  "graph",
  "map",
  "map-legacy",
  "map-forget",
  "reindex",
  "delete",
  "parity",
  "parity-graph",
  "parity-map",
  "parity-reindex",
];

// The router closure is large and each company is a handful of real rows. Both are paid for here,
// once, under the budget for a cold module load, so no single case carries the cost.
beforeAll(async () => {
  await import("./router");
  for (const label of COMPANIES) {
    await company(label);
  }
}, ROUTER_IMPORT_BUDGET_MS);
