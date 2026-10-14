/**
 * `knowledge-visibility.ts`: the fragments every hosted read path builds its SQL from.
 *
 * Two promises are pinned here, apart from the two-member behaviour in `knowledge-team-privacy.test.ts`:
 *
 * 1. **Off server mode every builder answers "no restriction"** (an empty fragment, a null graph
 *    prefix, "visible", "not hidden"), so the SQL the Personal app and webdev run is the SQL they ran
 *    before the module existed.
 * 2. **On, each fragment is well formed and cheap**: its placeholders match its values, no person's id
 *    is spliced into the text, it names the `threads` table (a subselect, never a list of ids), and on a
 *    desk with thousands of sources the planner reaches `threads` through its existing index rather
 *    than by scanning the table. The plan is read from SQLite itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "./__fixtures__/test-budgets";
import {
  andSharedSource,
  andVisibleSource,
  andVisibleSourceId,
  chatCardsArePrivate,
  sourceIsHidden,
  sourceIsVisible,
  visibleGraphNodes,
} from "./knowledge-visibility";

const WRAP_KEY = "3f8a1c05d97e26b4084fa3c1e5d7290b6c48af13e02d95b7ca6318fd4e7092a5";

const tenant: TenantContext = {
  tenantId: "tenant-vis",
  organizationId: "org-vis-0000000000000000",
  workspaceId: "ws-vis-0000000000000000",
  userId: "usr-vis-0000000000000000",
  role: "member",
};

const ON = { serverMode: true } as const;
const OFF = { serverMode: false } as const;

function placeholders(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("off server mode: no restriction, the SQL callers build is unchanged", () => {
  it("returns empty fragments and a null graph prefix", () => {
    expect(chatCardsArePrivate(OFF)).toBe(false);
    for (const fragment of [
      andVisibleSource(tenant, undefined, OFF),
      andVisibleSource(tenant, "s", OFF),
      andVisibleSourceId(tenant, "source_id", OFF),
      andSharedSource(undefined, OFF),
    ]) {
      expect(fragment).toEqual({ sql: "", params: [] });
    }
    expect(visibleGraphNodes(tenant, OFF)).toBeNull();
  });

  it("reads the environment when nothing is injected, and says visible and not hidden", () => {
    vi.stubEnv("AGENTFORGE_SERVER", "0");
    expect(chatCardsArePrivate()).toBe(false);
    expect(andVisibleSource(tenant)).toEqual({ sql: "", params: [] });
    // No row is consulted at all: the callers' own handling of a missing source is untouched.
    expect(sourceIsVisible(tenant, "no-such-source")).toBe(true);
    expect(sourceIsHidden(tenant, "no-such-source")).toBe(false);
  });

  it("follows the hosted flag when it is set", () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    expect(chatCardsArePrivate()).toBe(true);
    expect(andVisibleSource(tenant).sql).not.toBe("");
  });
});

describe("on server mode: each fragment is well formed", () => {
  const fragments = (): Array<[string, { sql: string; params: readonly string[] }]> => [
    ["andVisibleSource", andVisibleSource(tenant, undefined, ON)],
    ["andVisibleSource (aliased)", andVisibleSource(tenant, "s", ON)],
    ["andVisibleSourceId", andVisibleSourceId(tenant, "source_id", ON)],
  ];

  it.each(fragments().map(([label]) => label))(
    "%s: placeholders match values, and nobody's id is in the text",
    (label) => {
      const fragment = fragments().find(([name]) => name === label)?.[1];
      if (!fragment) {
        throw new Error(label);
      }
      expect(placeholders(fragment.sql)).toBe(fragment.params.length);
      for (const value of fragment.params) {
        expect(fragment.sql).not.toContain(value);
      }
      // A subselect against the person's threads, never a list of ids.
      expect(fragment.sql).toContain("FROM threads");
      expect(fragment.sql).not.toMatch(/NOT IN \(\?/);
    },
  );

  it("builds the graph prefix with 15 placeholders and 15 values (the owner check adds four)", () => {
    const view = visibleGraphNodes(tenant, ON);
    expect(view).not.toBeNull();
    expect(placeholders(view?.with ?? "")).toBe(15);
    expect(view?.params).toHaveLength(15);
    expect(view?.with).toContain("WITH visible(id)");
  });

  it("the shared-only fragment (for the map) names no thread, no owned card and takes no values", () => {
    const shared = andSharedSource("s", ON);
    expect(shared.params).toEqual([]);
    expect(shared.sql).toBe(" AND (s.origin_kind IS NULL OR s.origin_kind <> 'thread') AND s.owner_user_id IS NULL");
  });

  it("binds the person for the owner check, then the organization, desk and person for the thread lookup", () => {
    const fragment = andVisibleSource(tenant, undefined, ON);
    expect(fragment.params).toEqual([tenant.userId, tenant.organizationId, tenant.workspaceId, tenant.userId]);
    expect(fragment.sql).toContain("t.organization_id = ? AND t.workspace_id = ? AND t.user_id = ?");
    expect(fragment.sql).toContain("owner_user_id IS NULL OR knowledge_sources.owner_user_id = ?");
  });
});

describe("query plan on a desk with thousands of sources", () => {
  const SOURCES = 4_000;
  const PEOPLE = ["usr-plan-a", "usr-plan-b", "usr-plan-c", "usr-plan-d"];
  let sqlite: typeof import("@agentforge/db").sql;
  let planTenant: TenantContext;

  beforeAll(async () => {
    vi.stubEnv("AGENTFORGE_SECRETS_KEY", WRAP_KEY);
    // The hosted reads below resolve the desk's model catalogue, which needs the tenant-state backend
    // the router installs; importing both here keeps the module load out of the cases.
    await import("./tenant-state-db");
    await import("./knowledge");
    const dbm = await import("@agentforge/db");
    sqlite = dbm.sql;
    const { agentService } = await import("./tenant");
    const roster: TenantContext[] = [];
    for (const userId of PEOPLE) {
      roster.push(
        await dbm.ensurePortalOwner(dbm.db, {
          tenantId: "tenant-plan",
          orgId: "org-plan",
          userId,
          role: "member",
        }),
      );
    }
    planTenant = roster[0] as TenantContext;
    const chat = await agentService.ensureDefaultChat(planTenant);
    const insertThread = sqlite.prepare(
      `INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, title, created_at)
       VALUES (?, ?, ?, ?, ?, 'plan thread', ?)`,
    );
    const insertSource = sqlite.prepare(
      `INSERT INTO knowledge_sources (id, workspace_id, name, type, status, chunks, error, created_at, origin_kind, origin_id)
       VALUES (?, ?, ?, ?, 'Indexed', 1, NULL, ?, ?, ?)`,
    );
    const insertChunk = sqlite.prepare("INSERT INTO knowledge_chunks (source_id, workspace_id, body) VALUES (?, ?, ?)");
    const insertVector = sqlite.prepare(
      `INSERT INTO knowledge_vectors (id, workspace_id, source_id, chunk_index, body, embedding, model, created_at)
       VALUES (?, ?, ?, 0, ?, '[0.1,0.2,0.3]', 'stub-fnv-32', ?)`,
    );
    sqlite
      .transaction(() => {
        let threadCount = 0;
        for (let i = 0; i < SOURCES; i += 1) {
          const id = `plan-source-${i}`;
          // A quarter are files, a quarter job cards, half are Chat cards spread over four people.
          const kind = i % 4 === 0 ? null : i % 4 === 1 ? "artifact" : "thread";
          let originId: string | null = null;
          if (kind === "thread") {
            originId = `plan-thread-${i}`;
            const owner = roster[threadCount % roster.length] as TenantContext;
            threadCount += 1;
            insertThread.run(
              originId,
              owner.organizationId,
              owner.workspaceId,
              chat.agent.id,
              owner.userId,
              Date.now(),
            );
          } else if (kind === "artifact") {
            originId = `plan-artifact-${i}`;
          }
          insertSource.run(id, planTenant.workspaceId, `Plan source ${i}`, "Paste", Date.now(), kind, originId);
          insertChunk.run(id, planTenant.workspaceId, `plan words ${i} lorem ipsum plantoken${i % 50}`);
          insertVector.run(`plan-vector-${i}`, planTenant.workspaceId, id, `plan words ${i}`, Date.now());
        }
      })
      .immediate();
  }, ROUTER_IMPORT_BUDGET_MS);

  afterAll(async () => {
    const { sql } = await import("@agentforge/db");
    sql.close();
  });

  const plan = (statement: string, params: readonly unknown[]): string[] =>
    (sqlite.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...(params as never[])) as Array<{ detail: string }>).map(
      (row) => row.detail,
    );

  it("reaches the thread subselect through an index, not a scan of `threads`", () => {
    const visible = andVisibleSourceId(planTenant, "knowledge_chunks.source_id", ON);
    const details = plan(
      `SELECT rowid AS rid, source_id, body, bm25(knowledge_chunks) AS rank FROM knowledge_chunks
       WHERE workspace_id = ? AND knowledge_chunks MATCH ?${visible.sql} ORDER BY bm25(knowledge_chunks) LIMIT ?`,
      [planTenant.workspaceId, "plantoken7", ...visible.params, 4],
    );
    console.info(`full-text plan:\n  ${details.join("\n  ")}`);
    const threads = details.filter((line) => /threads/.test(line));
    expect(threads.length).toBeGreaterThan(0);
    expect(threads.some((line) => /^SCAN (t|threads)\b/.test(line))).toBe(false);
  });

  it("plans the vector and Sources-list reads without a scan of `threads`", () => {
    const inner = andVisibleSource(planTenant, undefined, ON);
    const vectors = plan(
      `SELECT body, embedding, source_id, chunk_index FROM knowledge_vectors
       WHERE workspace_id = ? AND model = ?
         AND source_id IN (SELECT id FROM knowledge_sources WHERE workspace_id = ?${inner.sql})`,
      [planTenant.workspaceId, "stub-fnv-32", planTenant.workspaceId, ...inner.params],
    );
    const list = plan(
      `SELECT id, name FROM knowledge_sources WHERE workspace_id = ?${inner.sql} ORDER BY created_at DESC`,
      [planTenant.workspaceId, ...inner.params],
    );
    console.info(`vector plan:\n  ${vectors.join("\n  ")}\nlist plan:\n  ${list.join("\n  ")}`);
    for (const details of [vectors, list]) {
      expect(details.some((line) => /^SCAN (t|threads)\b/.test(line))).toBe(false);
    }
  });

  it("returns the person's own cards and the shared sources, and nobody else's, at this size", async () => {
    vi.stubEnv("AGENTFORGE_SERVER", "1");
    const { listSources } = await import("./knowledge");
    const mine = listSources(planTenant);
    const threadCards = mine.filter((source) => source.origin?.kind === "thread");
    const shared = mine.filter((source) => source.origin?.kind !== "thread");
    expect(shared).toHaveLength(SOURCES / 2);
    expect(threadCards).toHaveLength(SOURCES / 2 / PEOPLE.length);
    const others = sqlite
      .prepare(
        `SELECT count(*) AS n FROM threads WHERE workspace_id = ? AND user_id <> ? AND id IN (${threadCards
          .map(() => "?")
          .join(",")})`,
      )
      .get(planTenant.workspaceId, planTenant.userId, ...threadCards.map((source) => source.origin?.id)) as {
      n: number;
    };
    expect(others.n).toBe(0);
  });

  it("reaches `threads` through its index for the graph reads too", () => {
    const view = visibleGraphNodes(planTenant, ON);
    if (!view) {
      throw new Error("no graph prefix on server mode");
    }
    const details = plan(`${view.with} SELECT count(*) FROM visible`, view.params);
    console.info(`graph plan:\n  ${details.join("\n  ")}`);
    expect(details.some((line) => /^SCAN (t|threads)\b/.test(line))).toBe(false);
  });

  it("answers a retrieval over the whole desk quickly, hosted and not", async () => {
    const { retrieveChunks } = await import("./knowledge");
    const time = async (hostedFlag: boolean): Promise<number> => {
      vi.stubEnv("AGENTFORGE_SERVER", hostedFlag ? "1" : "0");
      await retrieveChunks(planTenant, "plantoken1", 4); // warm the module, the page cache and the plan
      const runs: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const started = performance.now();
        await retrieveChunks(planTenant, `plantoken${i + 3}`, 4);
        runs.push(performance.now() - started);
      }
      return runs.sort((a, b) => a - b)[3] as number;
    };
    const desk = await time(false);
    const hostedMs = await time(true);
    console.info(
      `retrieval over ${SOURCES} sources (median of 7): desk ${desk.toFixed(1)} ms, hosted ${hostedMs.toFixed(1)} ms`,
    );
    // Not a benchmark: a ceiling that only a scan of every thread per chunk would break.
    expect(hostedMs).toBeLessThan(2_000);
  }, 60_000);

  it("adds little to the full-text statement: its cost follows the rows it returns, not the desk", () => {
    const visible = andVisibleSourceId(planTenant, "knowledge_chunks.source_id", ON);
    const base = "SELECT rowid AS rid, source_id, body, bm25(knowledge_chunks) AS rank FROM knowledge_chunks";
    const without = sqlite.prepare(
      `${base} WHERE workspace_id = ? AND knowledge_chunks MATCH ? ORDER BY bm25(knowledge_chunks) LIMIT ?`,
    );
    const withFragment = sqlite.prepare(
      `${base} WHERE workspace_id = ? AND knowledge_chunks MATCH ?${visible.sql} ORDER BY bm25(knowledge_chunks) LIMIT ?`,
    );
    const median = (run: () => unknown): number => {
      run();
      const runs: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        const started = performance.now();
        run();
        runs.push(performance.now() - started);
      }
      return runs.sort((a, b) => a - b)[7] as number;
    };
    // `plan` matches 80 rows of the 4000, a common-token case; `lorem` matches every row.
    for (const token of ["plantoken7", "lorem"]) {
      const plain = median(() => without.all(planTenant.workspaceId, token, 4));
      const guarded = median(() => withFragment.all(planTenant.workspaceId, token, ...visible.params, 4));
      console.info(`full-text "${token}" over ${SOURCES} sources: ${plain.toFixed(2)} ms -> ${guarded.toFixed(2)} ms`);
      expect(guarded - plain).toBeLessThan(50);
    }
  });
});
