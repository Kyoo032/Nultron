import { afterEach, describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  DEFAULT_EMBEDDING_MODEL,
  stubEmbed,
  type AppLocale,
  type TenantContext,
} from "@agentforge/core";
import { sql } from "@agentforge/db";
import { handlePostEducationExam } from "../handlers/education";
import { addPastedSource, getKnowledgeModels } from "../knowledge";
import { resetEmbedCircuit, searchVectors, STUB_EMBED_MODEL } from "../knowledge-embed";
import { withRequestLocale } from "../run-context";
import { saveSettings } from "../settings-store";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

/**
 * SH-014. The stub embedder is 32 hash buckets. A one-word topic that lands in any
 * bucket a short passage already uses scores about 0.30, and that clears the 0.12
 * cosine floor. Education then turns the hit into an exam passage. These tests stay
 * on the machine: no gateway, no fetch, except the live-model case which stubs fetch.
 */

const PASSAGE = "Write a haiku about rain for the smoke check.";

function request(body: unknown): HostRequest {
  return {
    method: "POST",
    path: "/api/v1/education/exam",
    query: {},
    params: {},
    headers: {},
    body,
  };
}

function jsonBody(result: HostResult): Record<string, unknown> {
  if (result.type !== "json") {
    throw new Error(`expected json, got ${result.type}`);
  }
  return result.body as Record<string, unknown>;
}

async function exam(topic: string, locale: AppLocale = "en"): Promise<Record<string, unknown>> {
  const result = await withRequestLocale(
    () => locale,
    () => handlePostEducationExam(request({ topic })),
  );
  expect(result.status).toBe(200);
  return jsonBody(result);
}

describe("SH-014 stub passages in an Education exam", () => {
  it("gives an unrelated one-word topic a cosine above the floor", () => {
    const tides = cosineSimilarity(stubEmbed("tides"), stubEmbed(PASSAGE));
    const glaciers = cosineSimilarity(stubEmbed("glaciers"), stubEmbed(PASSAGE));
    const rain = cosineSimilarity(stubEmbed("rain"), stubEmbed(PASSAGE));
    expect(tides).toBeGreaterThan(0.12);
    expect(glaciers).toBeGreaterThan(0.12);
    expect(rain).toBeCloseTo(tides, 5);
  });

  it("does not cite a stub passage that shares no word with the topic", async () => {
    const tenant = await getTenant();
    const source = await addPastedSource(tenant, "Chat", PASSAGE);
    const models = getKnowledgeModels(tenant);
    const hits = await searchVectors(tenant, "tides", models, 6);
    expect(hits.model).toBe(STUB_EMBED_MODEL);
    expect(hits.hits).toEqual([]);

    for (const topic of ["tides", "glaciers"]) {
      const body = await exam(topic);
      expect(body.emptyBase).toBe(true);
      const items = body.items as Array<{ sourceId: string; citation: string; prompt: string }>;
      expect(items[0]?.sourceId).toBe("");
      expect(items[0]?.citation).toBe("");
      expect(items[0]?.prompt).not.toContain("haiku");
      expect(JSON.stringify(body)).not.toContain(source.id);
    }
  });

  it("still cites a stub passage that shares a word with the topic", async () => {
    const tenant = await getTenant();
    const source = await addPastedSource(tenant, "Chat", PASSAGE);
    const hits = await searchVectors(tenant, "rain", getKnowledgeModels(tenant), 6);
    expect(hits.hits.some((hit) => hit.sourceId === source.id)).toBe(true);

    const body = await exam("rain");
    expect(body.emptyBase).toBe(false);
    const items = body.items as Array<{ sourceId: string; citation: string }>;
    expect(items.some((item) => item.sourceId === source.id)).toBe(true);
    expect(items.some((item) => item.citation.includes("haiku"))).toBe(true);
  });
});

describe("SH-014 live embeddings keep the cosine floor", () => {
  const REAL_MODEL = DEFAULT_EMBEDDING_MODEL;
  let previousRuntime: string | undefined;
  let fetchImpl: typeof fetch;

  function unit(cosine: number): number[] {
    const rest = Math.sqrt(1 - cosine * cosine);
    return [cosine, rest, 0, 0, 0, 0, 0, 0];
  }

  function tenant(): TenantContext {
    return {
      tenantId: "local-tenant",
      organizationId: "org-sh014-live",
      workspaceId: `ws-sh014-${crypto.randomUUID()}`,
      userId: "user-sh014",
      role: "owner",
    };
  }

  function seed(ctx: TenantContext, sourceId: string, body: string, embedding: number[]): void {
    sql
      .prepare(
        `INSERT INTO knowledge_sources (id, workspace_id, name, type, status, chunks, error, created_at)
         VALUES (?, ?, 'Notes', 'Paste', 'Indexed', 1, NULL, ?)`,
      )
      .run(sourceId, ctx.workspaceId, Date.now());
    sql
      .prepare(
        `INSERT INTO knowledge_vectors (id, workspace_id, source_id, chunk_index, body, embedding, model, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), ctx.workspaceId, sourceId, body, JSON.stringify(embedding), REAL_MODEL, Date.now());
  }

  afterEach(() => {
    globalThis.fetch = fetchImpl;
    resetEmbedCircuit();
    if (previousRuntime === undefined) {
      delete process.env.AGENTFORGE_RUNTIME;
    } else {
      process.env.AGENTFORGE_RUNTIME = previousRuntime;
    }
  });

  it("returns a real-model hit at 0.12 with no shared word, and drops one just under", async () => {
    previousRuntime = process.env.AGENTFORGE_RUNTIME;
    fetchImpl = globalThis.fetch;
    process.env.AGENTFORGE_RUNTIME = "ai";
    resetEmbedCircuit();
    const ctx = tenant();
    saveSettings({ openaiApiKey: "sk-test-sh014-embed" }, ctx);
    const aboveId = crypto.randomUUID();
    const belowId = crypto.randomUUID();
    seed(ctx, aboveId, PASSAGE, unit(0.12));
    seed(ctx, belowId, `${PASSAGE} extra`, unit(0.119));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const found = await searchVectors(
      ctx,
      "tides",
      { embeddingModel: REAL_MODEL, brainModel: "gpt-5.6-luna", verifierModel: "deepseek-v4-flash" },
      4,
      [],
      REAL_MODEL,
    );

    expect(found.model).toBe(REAL_MODEL);
    expect(found.hits.map((hit) => hit.sourceId)).toEqual([aboveId]);
    expect(found.hits[0]?.score).toBeCloseTo(0.12, 6);
    expect(found.hits[0]?.body).not.toContain("tides");
  });
});
