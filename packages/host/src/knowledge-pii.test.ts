import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { buildTextPdf } from "@agentforge/core/pdf/test-fixtures";

const dataDir = mkdtempSync(join(tmpdir(), "af-knowledge-pii-at-rest-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.AGENTFORGE_SETTINGS_PATH = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_RUNTIME = "stub";
process.env.AGENTFORGE_SECRETS_KEY = "c".repeat(64);
delete process.env.AGENTFORGE_SERVER;
delete process.env.DATABASE_URL;
delete process.env.OPENAI_API_KEY;

const mockedUrlBody = vi.hoisted(() => ({ body: "", contentType: "text/html" }));

vi.mock("./safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./safe-fetch")>();
  return {
    ...actual,
    fetchPublicHttps: async () => ({
      status: 200,
      contentType: mockedUrlBody.contentType,
      body: Buffer.from(mockedUrlBody.body, "utf8"),
      finalUrl: "https://docs.example.org/handbook",
    }),
  };
});

const { checkpointWalTruncate, sql } = await import("@agentforge/db");
const { sqliteFilePath } = await import("@agentforge/db/vault-key");
const {
  addFileSource,
  addPastedSource,
  addUrlSource,
  deleteSource,
  findSourceByOrigin,
  getKnowledgeModels,
  listSources,
  retrieveChunks,
} = await import("./knowledge");
const { handleGetKnowledge } = await import("./handlers/knowledge");
const { upsertWorkSource } = await import("./knowledge-ingest");
const { embedTextsWithModel, reembedWorkspaceChunks, resetEmbedCircuit, searchVectors, STUB_EMBED_MODEL } = await import(
  "./knowledge-embed"
);
const { mapKnowledge } = await import("./knowledge-map");
const { reindexSource } = await import("./knowledge-reindex");
const { isSealedVectorBody, openVectorBody } = await import("./knowledge-vector-seal");
const { saveSettings } = await import("./settings-store");
const { agentService, getTenant } = await import("./tenant");
const {
  createThread,
  deleteThread,
  getThread,
  isSealedThreadTitle,
  listPastSessionsForAgent,
  listThreads,
  listWorkspaceThreads,
  setThreadTitleFromParts,
} = await import("./threads");
const { startModalityRun } = await import("./runs");
const { chatWorkCard } = await import("./work-cards");
const { invokeToolGuarded, stubEmbed } = await import("@agentforge/core");
const { knowledgeSearchTool } = await import("./knowledge-search-tool");

const RAW_EMAIL = "alex.rivera@example.com";
const RAW_NIK = "3273011505900001";
const RAW_NPWP = "01.234.567.8-012.000";
const RAW_PHONE = "+62 812 9988 7766";

function makeTenant(): TenantContext {
  return {
    tenantId: "local-tenant",
    organizationId: `org-pii-${crypto.randomUUID()}`,
    workspaceId: `ws-pii-${crypto.randomUUID()}`,
    userId: "user-pii-test",
    role: "owner",
  };
}

function readChunks(workspaceId: string, sourceId: string): string[] {
  const rows = sql
    .prepare("SELECT body FROM knowledge_chunks WHERE workspace_id = ? AND source_id = ? ORDER BY rowid")
    .all(workspaceId, sourceId) as Array<{ body: string }>;
  return rows.map((row) => row.body);
}

function readRawVectors(workspaceId: string, sourceId: string): string[] {
  const rows = sql
    .prepare("SELECT body FROM knowledge_vectors WHERE workspace_id = ? AND source_id = ? ORDER BY chunk_index")
    .all(workspaceId, sourceId) as Array<{ body: string }>;
  return rows.map((row) => row.body);
}

beforeEach(() => {
  mockedUrlBody.body = "";
  mockedUrlBody.contentType = "text/html";
});

afterAll(() => {
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("Knowledge uploads, URLs, paste, and re-index mask PII before storing chunks and vectors", () => {
  it("masks PII in addFileSource chunks and vectors while preserving the owner's original uploaded bytes", async () => {
    const ctx = makeTenant();
    const originalText = `Owner contact: ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}, phone ${RAW_PHONE}. Project code ALDER-CREST-991.`;
    const originalBytes = Buffer.from(originalText, "utf8");

    const source = await addFileSource(ctx, {
      filename: "client-dossier.txt",
      mime: "text/plain",
      bytes: originalBytes,
    });
    expect(source.status).toBe("Indexed");

    const chunks = readChunks(ctx.workspaceId, source.id);
    expect(chunks.length).toBeGreaterThan(0);
    const joinedChunks = chunks.join("\n");
    expect(joinedChunks).not.toContain(RAW_EMAIL);
    expect(joinedChunks).not.toContain(RAW_NIK);
    expect(joinedChunks).not.toContain(RAW_NPWP);
    expect(joinedChunks).not.toContain(RAW_PHONE);
    expect(joinedChunks).toContain("[email]");
    expect(joinedChunks).toContain("[nik]");
    expect(joinedChunks).toContain("[npwp]");
    expect(joinedChunks).toContain("[phone]");
    expect(joinedChunks).toContain("ALDER-CREST-991");

    const rawVectors = readRawVectors(ctx.workspaceId, source.id);
    expect(rawVectors.length).toBeGreaterThan(0);
    for (const raw of rawVectors) {
      expect(isSealedVectorBody(raw)).toBe(true);
      expect(raw).not.toContain(RAW_EMAIL);
      expect(raw).not.toContain(RAW_NIK);
      expect(raw).not.toContain(RAW_NPWP);
      expect(raw).not.toContain("ALDER-CREST-991");
    }
    const openedVectors = rawVectors.map(openVectorBody).join("\n");
    expect(openedVectors).not.toContain(RAW_EMAIL);
    expect(openedVectors).not.toContain(RAW_NIK);
    expect(openedVectors).not.toContain(RAW_NPWP);
    expect(openedVectors).toContain("[email]");
    expect(openedVectors).toContain("[nik]");
    expect(openedVectors).toContain("[npwp]");
    expect(openedVectors).toContain("ALDER-CREST-991");

    // The owner's original uploaded file stays intact on disk for download.
    const uploadDir = join(dataDir, "knowledge", ctx.organizationId);
    const storedName = readdirSync(uploadDir).find((entry) => entry.startsWith(`${source.id}-`));
    expect(storedName).toBeDefined();
    const storedBytes = readFileSync(join(uploadDir, storedName as string));
    expect(storedBytes.equals(originalBytes)).toBe(true);

    // Re-indexing from the stored original upload keeps PII masked and vectors sealed.
    const reindexed = await reindexSource(ctx, source.id);
    expect(reindexed.status).toBe("reindexed");
    const reindexedChunks = readChunks(ctx.workspaceId, source.id).join("\n");
    expect(reindexedChunks).not.toContain(RAW_EMAIL);
    expect(reindexedChunks).not.toContain(RAW_NIK);
    expect(reindexedChunks).not.toContain(RAW_NPWP);
    expect(reindexedChunks).toContain("[email]");
    expect(reindexedChunks).toContain("[nik]");
    expect(reindexedChunks).toContain("[npwp]");
    const reindexedVectors = readRawVectors(ctx.workspaceId, source.id);
    expect(reindexedVectors.every((raw) => isSealedVectorBody(raw))).toBe(true);
    expect(reindexedVectors.map(openVectorBody).join("\n")).not.toContain(RAW_EMAIL);
  });

  it("masks PII in uploaded PDF text before storing chunks and vectors", async () => {
    const ctx = makeTenant();
    const pdfBytes = buildTextPdf([`Contact ${RAW_EMAIL}`, `NIK ${RAW_NIK}`, `NPWP ${RAW_NPWP}`]);

    const source = await addFileSource(ctx, {
      filename: "billing.pdf",
      mime: "application/pdf",
      bytes: pdfBytes,
    });
    expect(source.status).toBe("Indexed");

    const chunks = readChunks(ctx.workspaceId, source.id).join("\n");
    expect(chunks).not.toContain(RAW_EMAIL);
    expect(chunks).not.toContain(RAW_NIK);
    expect(chunks).not.toContain(RAW_NPWP);
    expect(chunks).toContain("[email]");
    expect(chunks).toContain("[nik]");
    expect(chunks).toContain("[npwp]");
  });

  it("masks PII in addPastedSource and addUrlSource chunks and vectors", async () => {
    const ctx = makeTenant();
    const pasted = await addPastedSource(
      ctx,
      "Contact sheet",
      `Reach ${RAW_EMAIL} with NIK ${RAW_NIK} and NPWP ${RAW_NPWP}.`,
    );
    expect(pasted.status).toBe("Indexed");
    const pastedChunks = readChunks(ctx.workspaceId, pasted.id).join("\n");
    expect(pastedChunks).not.toContain(RAW_EMAIL);
    expect(pastedChunks).not.toContain(RAW_NIK);
    expect(pastedChunks).not.toContain(RAW_NPWP);
    expect(pastedChunks).toContain("[email]");
    expect(pastedChunks).toContain("[nik]");
    expect(pastedChunks).toContain("[npwp]");

    mockedUrlBody.body = `<html><head><title>Team Directory</title></head><body><p>Mail ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}.</p></body></html>`;
    const fromUrl = await addUrlSource(ctx, "https://docs.example.org/handbook");
    expect(fromUrl.status).toBe("Indexed");
    const urlChunks = readChunks(ctx.workspaceId, fromUrl.id).join("\n");
    expect(urlChunks).not.toContain(RAW_EMAIL);
    expect(urlChunks).not.toContain(RAW_NIK);
    expect(urlChunks).not.toContain(RAW_NPWP);
    expect(urlChunks).toContain("[email]");
    expect(urlChunks).toContain("[nik]");
    expect(urlChunks).toContain("[npwp]");
    const urlVectors = readRawVectors(ctx.workspaceId, fromUrl.id);
    expect(urlVectors.every((raw) => isSealedVectorBody(raw))).toBe(true);
    expect(urlVectors.map(openVectorBody).join("\n")).not.toContain(RAW_EMAIL);
  });
});

function readDbAndWal(): { db: Buffer; wal: Buffer } {
  const dbPath = sqliteFilePath();
  const walPath = `${dbPath}-wal`;
  return {
    db: readFileSync(dbPath),
    wal: existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0),
  };
}

async function drain(run: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of run) {
    out += chunk;
  }
  return out;
}

describe("Knowledge vectors at-rest encryption and SQLite secure_delete", () => {
  it("runs SQLite with PRAGMA secure_delete = 1, journal_size_limit, and FTS5 secure-delete = 1", () => {
    expect(sql.pragma("secure_delete", { simple: true })).toBe(1);
    expect(sql.pragma("journal_size_limit", { simple: true })).toBe(16_777_216);
    const ftsConfig = sql
      .prepare("SELECT v FROM knowledge_chunks_config WHERE k = 'secure-delete'")
      .get() as { v: number } | undefined;
    expect(ftsConfig?.v).toBe(1);
  });

  it("seals knowledge_vectors.body with AES-GCM and returns decrypted text from vector search", async () => {
    const ctx = makeTenant();
    const planted = "QUARTZ-LANTERN-AT-REST-7741";
    const source = await addPastedSource(
      ctx,
      "At-rest probe",
      `The vault beacon marker is ${planted} for sealed vector retrieval.`,
    );
    expect(source.status).toBe("Indexed");

    const rawVectors = readRawVectors(ctx.workspaceId, source.id);
    expect(rawVectors).toHaveLength(1);
    expect(isSealedVectorBody(rawVectors[0] as string)).toBe(true);
    expect(rawVectors[0]).not.toContain(planted);

    // Delete FTS chunks so retrieval MUST come from the sealed `knowledge_vectors` rows alone.
    sql.prepare("DELETE FROM knowledge_chunks WHERE workspace_id = ? AND source_id = ?").run(ctx.workspaceId, source.id);

    const retrieved = await retrieveChunks(ctx, planted, 4);
    expect(retrieved.mode).toBe("rag");
    expect(retrieved.chunks).toHaveLength(1);
    expect(retrieved.chunks[0]?.sourceId).toBe(source.id);
    expect(retrieved.chunks[0]?.body).toContain(planted);
  });

  it("keeps knowledge_vectors.body sealed across reembedWorkspaceChunks and mapKnowledge, and decrypts in searchVectors", async () => {
    const ctx = makeTenant();
    const planted = "AMBER-COMPASS-MAP-REEMBED-6104";
    const source = await addPastedSource(
      ctx,
      "Map reembed probe",
      `Strategic ledger beacon ${planted} must stay sealed after map re-embedding.`,
    );
    expect(source.status).toBe("Indexed");

    const models = getKnowledgeModels(ctx);
    await reembedWorkspaceChunks(ctx, models.embeddingModel);

    const afterReembed = readRawVectors(ctx.workspaceId, source.id);
    expect(afterReembed.length).toBeGreaterThan(0);
    for (const raw of afterReembed) {
      expect(isSealedVectorBody(raw)).toBe(true);
      expect(raw).not.toContain(planted);
    }

    const mapped = await mapKnowledge(ctx);
    expect(mapped.topics.length).toBeGreaterThanOrEqual(0);

    const afterMap = readRawVectors(ctx.workspaceId, source.id);
    expect(afterMap.length).toBeGreaterThan(0);
    for (const raw of afterMap) {
      expect(isSealedVectorBody(raw)).toBe(true);
      expect(raw).not.toContain(planted);
    }

    const directSearch = await searchVectors(ctx, planted, models, 4);
    expect(directSearch.hits).toHaveLength(1);
    expect(directSearch.hits[0]?.sourceId).toBe(source.id);
    expect(directSearch.hits[0]?.body).toContain(planted);

    const retrieved = await retrieveChunks(ctx, planted, 4);
    expect(retrieved.chunks.some((chunk) => chunk.body.includes(planted))).toBe(true);
  });

  it("masks PII before sending outbound /embeddings requests in live mode", async () => {
    const prevRuntime = process.env.AGENTFORGE_RUNTIME;
    const originalFetch = globalThis.fetch;
    const sentInputs: string[] = [];
    saveSettings({ openaiApiKey: "sk-test-embed-pii-key-0001" });
    process.env.AGENTFORGE_RUNTIME = "ai";
    resetEmbedCircuit();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputs = Array.isArray(body.input) ? body.input : [];
      sentInputs.push(...inputs);
      return new Response(
        JSON.stringify({
          data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await embedTextsWithModel(
        [`Reach ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}`],
        "text-embedding-3-small",
      );
      expect(result.degraded).toBe(false);
      expect(sentInputs).toHaveLength(1);
      expect(sentInputs[0]).not.toContain(RAW_EMAIL);
      expect(sentInputs[0]).not.toContain(RAW_NIK);
      expect(sentInputs[0]).not.toContain(RAW_NPWP);
      expect(sentInputs[0]).toContain("[email]");
      expect(sentInputs[0]).toContain("[nik]");
      expect(sentInputs[0]).toContain("[npwp]");
    } finally {
      globalThis.fetch = originalFetch;
      resetEmbedCircuit();
      process.env.AGENTFORGE_RUNTIME = prevRuntime;
    }
  });

  it("masks legacy unmasked paste, URL, and work-card sources on reindexSource while preserving work-card pointers", async () => {
    const ctx = makeTenant();
    const now = Date.now() - 60_000;
    const pasteId = crypto.randomUUID();
    const urlId = crypto.randomUUID();
    const cardId = crypto.randomUUID();
    const artifactUuid = "b73b2194-8471-4712-9012-123456789012";

    const seedLegacy = (
      id: string,
      name: string,
      type: string,
      body: string,
      origin: { kind: string; id: string } | null = null,
    ) => {
      sql
        .prepare(
          `INSERT INTO knowledge_sources (id, workspace_id, name, type, status, chunks, error, created_at, origin_kind, origin_id)
           VALUES (?, ?, ?, ?, 'Indexed', 1, NULL, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, name, type, now, origin?.kind ?? null, origin?.id ?? null);
      sql
        .prepare("INSERT INTO knowledge_chunks (source_id, workspace_id, body) VALUES (?, ?, ?)")
        .run(id, ctx.workspaceId, body);
    };

    seedLegacy(pasteId, "Legacy Paste", "Paste", `Legacy paste for ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}.`);
    seedLegacy(urlId, "Legacy URL", "URL", `Legacy web page for ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}.`);
    seedLegacy(
      cardId,
      "Legacy Research Card",
      "Research",
      [
        `# Research note for ${RAW_EMAIL}`,
        "Mode: Research",
        `Pointer: artifact:${artifactUuid}`,
        `Prompt: Audit ${RAW_NIK}`,
        "",
        `Findings for ${RAW_EMAIL}, NIK ${RAW_NIK}, NPWP ${RAW_NPWP}.`,
      ].join("\n"),
      { kind: "artifact", id: artifactUuid },
    );

    const prevRuntime = process.env.AGENTFORGE_RUNTIME;
    const originalFetch = globalThis.fetch;
    const outboundBodies: string[] = [];
    saveSettings({ openaiApiKey: "sk-test-reindex-pii-key-0001" }, ctx);
    process.env.AGENTFORGE_RUNTIME = "ai";
    resetEmbedCircuit();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputs = Array.isArray(payload.input) ? payload.input : [];
      outboundBodies.push(...inputs);
      return new Response(
        JSON.stringify({
          data: inputs.map((_, index) => ({ index, embedding: [0.5, 0.25, 0.125, 0.0625] })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      for (const id of [pasteId, urlId, cardId]) {
        const outcome = await reindexSource(ctx, id);
        expect(outcome.status).toBe("reindexed");

        const chunks = readChunks(ctx.workspaceId, id).join("\n");
        expect(chunks).not.toContain(RAW_EMAIL);
        expect(chunks).not.toContain(RAW_NIK);
        expect(chunks).not.toContain(RAW_NPWP);
        expect(chunks).toContain("[email]");
        expect(chunks).toContain("[nik]");
        expect(chunks).toContain("[npwp]");

        const rawVectors = readRawVectors(ctx.workspaceId, id);
        expect(rawVectors.length).toBeGreaterThan(0);
        expect(rawVectors.every((raw) => isSealedVectorBody(raw))).toBe(true);
        const opened = rawVectors.map(openVectorBody).join("\n");
        expect(opened).not.toContain(RAW_EMAIL);
        expect(opened).not.toContain(RAW_NIK);
        expect(opened).not.toContain(RAW_NPWP);
        expect(opened).toContain("[email]");
        expect(opened).toContain("[nik]");
        expect(opened).toContain("[npwp]");
      }

      // Host-generated work-card pointer UUID stays intact after reindex masking.
      expect(readChunks(ctx.workspaceId, cardId).join("\n")).toContain(`Pointer: artifact:${artifactUuid}`);

      expect(outboundBodies.length).toBeGreaterThanOrEqual(3);
      const joinedOutbound = outboundBodies.join("\n");
      expect(joinedOutbound).not.toContain(RAW_EMAIL);
      expect(joinedOutbound).not.toContain(RAW_NIK);
      expect(joinedOutbound).not.toContain(RAW_NPWP);
      expect(joinedOutbound).toContain("[email]");
      expect(joinedOutbound).toContain("[nik]");
      expect(joinedOutbound).toContain("[npwp]");
    } finally {
      globalThis.fetch = originalFetch;
      resetEmbedCircuit();
      process.env.AGENTFORGE_RUNTIME = prevRuntime;
    }
  });

  it("remains backward-compatible on read with legacy unsealed knowledge_vectors rows", async () => {
    const ctx = makeTenant();
    const legacyId = crypto.randomUUID();
    const legacyMarker = "LEGACY-UNSEALED-VECTOR-4192";
    const legacyBody = `Legacy vector passage containing ${legacyMarker}.`;
    const now = Date.now();
    sql
      .prepare(
        `INSERT INTO knowledge_sources (id, workspace_id, name, type, status, chunks, error, created_at)
         VALUES (?, ?, 'Legacy', 'Paste', 'Indexed', 1, NULL, ?)`,
      )
      .run(legacyId, ctx.workspaceId, now);
    sql
      .prepare(
        `INSERT INTO knowledge_vectors (id, workspace_id, source_id, chunk_index, body, embedding, model, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        ctx.workspaceId,
        legacyId,
        legacyBody,
        JSON.stringify(stubEmbed(legacyBody)),
        STUB_EMBED_MODEL,
        now,
      );

    const retrieved = await retrieveChunks(ctx, legacyMarker, 4);
    expect(retrieved.mode).toBe("rag");
    expect(retrieved.chunks).toHaveLength(1);
    expect(retrieved.chunks[0]?.body).toBe(legacyBody);
  });

  it("leaves no remnant of a planted marker (including lowercase FTS5 token) in raw .sqlite or .sqlite-wal after deleting a source", async () => {
    const ctx = makeTenant();
    const planted = "EphemeralSecureDeleteBeacon88241";
    const plantedLower = planted.toLowerCase();
    // FTS5 prefix-compresses adjacent inverted-index terms (e.g. sharing leading 'e' with 'email'),
    // so checking the unique lowercase suffix proves the FTS5 segment itself landed and was scrubbed.
    const ftsSuffix = "securedeletebeacon88241";
    const source = await addPastedSource(ctx, "Delete probe", `Temporary note holding ${planted} before deletion.`);
    expect(source.status).toBe("Indexed");
    checkpointWalTruncate();

    // Confirm both the verbatim content row and the lowercased FTS5 index suffix landed before delete.
    const before = readDbAndWal();
    expect(before.db.includes(Buffer.from(planted, "utf8"))).toBe(true);
    expect(before.db.includes(Buffer.from(ftsSuffix, "utf8"))).toBe(true);

    expect(deleteSource(ctx, source.id)).toBe(true);

    const after = readDbAndWal();
    for (const token of [planted, plantedLower, ftsSuffix]) {
      expect(after.db.includes(Buffer.from(token, "utf8"))).toBe(false);
      expect(after.wal.includes(Buffer.from(token, "utf8"))).toBe(false);
    }
  });
});

describe("Thread titles at-rest encryption and end-to-end Chat-turn raw-DB acceptance", () => {
  it("seals threads.title with AES-256-GCM while remaining readable via thread APIs and legacy plaintext rows", async () => {
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);

    const secretTitle = "Confidential Board Merger Memo 5519";
    const created = await createThread(tenant, ready.agent.id, secretTitle);
    expect(created.title).toBe(secretTitle);

    const rawCreated = sql.prepare("SELECT title FROM threads WHERE id = ?").get(created.id) as { title: string };
    expect(isSealedThreadTitle(rawCreated.title)).toBe(true);
    expect(rawCreated.title).not.toContain(secretTitle);

    // Default-titled thread starts sealed, is excluded from past sessions, and re-seals on title update.
    const defaultThread = await createThread(tenant, ready.agent.id);
    const rawDefault = sql.prepare("SELECT title FROM threads WHERE id = ?").get(defaultThread.id) as {
      title: string;
    };
    expect(isSealedThreadTitle(rawDefault.title)).toBe(true);

    const sessionsBefore = await listPastSessionsForAgent(tenant, ready.agent.id, created.id, 20);
    expect(sessionsBefore.some((item) => item.id === defaultThread.id)).toBe(false);

    const promotedTitle = "Quarterly Payroll Review 9182";
    await setThreadTitleFromParts(tenant, defaultThread.id, [{ type: "text", text: promotedTitle }]);
    const rawPromoted = sql.prepare("SELECT title FROM threads WHERE id = ?").get(defaultThread.id) as {
      title: string;
    };
    expect(isSealedThreadTitle(rawPromoted.title)).toBe(true);
    expect(rawPromoted.title).not.toContain(promotedTitle);

    const loaded = await getThread(tenant, defaultThread.id);
    expect(loaded?.title).toBe(promotedTitle);
    const listed = await listThreads(tenant, ready.agent.id);
    expect(listed.find((item) => item.id === defaultThread.id)?.title).toBe(promotedTitle);
    const wsListed = await listWorkspaceThreads(tenant);
    expect(wsListed.find((item) => item.id === defaultThread.id)?.title).toBe(promotedTitle);
    const sessionsAfter = await listPastSessionsForAgent(tenant, ready.agent.id, created.id, 20);
    expect(sessionsAfter.find((item) => item.id === defaultThread.id)?.title).toBe(promotedTitle);

    // Legacy unsealed plaintext title row stays readable.
    const legacyId = crypto.randomUUID();
    const legacyTitle = "Legacy Unsealed Thread Title 3042";
    sql
      .prepare(
        `INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyId, tenant.organizationId, tenant.workspaceId, ready.agent.id, tenant.userId, legacyTitle, Date.now());
    expect((await getThread(tenant, legacyId))?.title).toBe(legacyTitle);

    await deleteThread(tenant, created.id);
    await deleteThread(tenant, defaultThread.id);
    await deleteThread(tenant, legacyId);
  });

  it("seals messages, thread title, and vector bodies on a real Chat turn, masks PII in FTS5, and clears all remnants on delete", async () => {
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const thread = await createThread(tenant, ready.agent.id);

    const marker = "CobaltLanternChatTurnBeacon7391";
    const markerLower = marker.toLowerCase();
    const turnEmail = "chat.turn.secret@example.com";
    const turnNik = "3273011505900099";
    const turnNpwp = "09.876.543.2-019.000";

    await drain(
      startModalityRun({
        tenant,
        threadId: thread.id,
        modality: "text",
        body: {
          content: [
            {
              type: "text",
              text: `Summarize ${marker} for ${turnEmail} NIK ${turnNik} NPWP ${turnNpwp}`,
            },
          ],
          model: "gpt-5.6-luna",
        },
      }),
    );

    // Wait for fire-and-forget chat work-card ingestion to finish writing chunks + vectors.
    let card = findSourceByOrigin(tenant, { kind: "thread", id: thread.id });
    for (let attempt = 0; attempt < 50 && card?.status !== "Indexed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      card = findSourceByOrigin(tenant, { kind: "thread", id: thread.id });
    }
    expect(card?.status).toBe("Indexed");
    if (!card) {
      throw new Error("Expected indexed chat work card");
    }
    checkpointWalTruncate();

    // 1. threads.title is AES-256-GCM sealed at rest (no raw marker or PII).
    const rawThread = sql.prepare("SELECT title FROM threads WHERE id = ?").get(thread.id) as { title: string };
    expect(isSealedThreadTitle(rawThread.title)).toBe(true);
    expect(rawThread.title).not.toContain(marker);
    expect(rawThread.title).not.toContain(turnEmail);
    expect(rawThread.title).not.toContain(turnNik);
    expect(rawThread.title).not.toContain(turnNpwp);

    const rawSource = sql
      .prepare("SELECT name FROM knowledge_sources WHERE workspace_id = ? AND origin_kind = 'thread' AND origin_id = ?")
      .get(tenant.workspaceId, thread.id) as { name: string };
    expect(isSealedThreadTitle(rawSource.name)).toBe(true);
    expect(rawSource.name).not.toContain(marker);
    expect(rawSource.name).not.toContain(turnEmail);
    expect(rawSource.name).not.toContain(turnNik);
    expect(rawSource.name).not.toContain(turnNpwp);

    // 2. messages.content rows are AES-256-GCM sealed at rest.
    const rawMessages = sql
      .prepare("SELECT content FROM messages WHERE thread_id = ?")
      .all(thread.id) as Array<{ content: string }>;
    expect(rawMessages.length).toBeGreaterThanOrEqual(2);
    for (const msg of rawMessages) {
      expect(msg.content).not.toContain(marker);
      expect(msg.content).not.toContain(turnEmail);
      expect(msg.content).not.toContain(turnNik);
      expect(msg.content).not.toContain(turnNpwp);
    }

    // 3. knowledge_vectors.body rows for the chat work card are AES-256-GCM sealed at rest.
    const rawVectors = readRawVectors(tenant.workspaceId, card.id);
    expect(rawVectors.length).toBeGreaterThan(0);
    for (const raw of rawVectors) {
      expect(isSealedVectorBody(raw)).toBe(true);
      expect(raw).not.toContain(marker);
      expect(raw).not.toContain(turnEmail);
      expect(raw).not.toContain(turnNik);
      expect(raw).not.toContain(turnNpwp);
    }

    // 4. knowledge_chunks (FTS5) stores pattern-masked searchable text with ZERO raw PII.
    const ftsChunks = readChunks(tenant.workspaceId, card.id).join("\n");
    expect(ftsChunks).not.toContain(turnEmail);
    expect(ftsChunks).not.toContain(turnNik);
    expect(ftsChunks).not.toContain(turnNpwp);
    expect(ftsChunks).toContain("[email]");
    expect(ftsChunks).toContain("[nik]");
    expect(ftsChunks).toContain("[npwp]");

    // 5. Neither raw .sqlite nor .sqlite-wal contains ANY raw PII from the Chat turn.
    const beforeDelete = readDbAndWal();
    for (const pii of [turnEmail, turnNik, turnNpwp]) {
      expect(beforeDelete.db.includes(Buffer.from(pii, "utf8"))).toBe(false);
      expect(beforeDelete.wal.includes(Buffer.from(pii, "utf8"))).toBe(false);
    }

    // 6. Deleting the thread removes the thread + its work card and scrubs marker + FTS tokens from .sqlite and .sqlite-wal.
    const markerFtsSuffix = "lanternchatturnbeacon7391";
    expect(beforeDelete.db.includes(Buffer.from(markerFtsSuffix, "utf8"))).toBe(true);
    expect(await deleteThread(tenant, thread.id)).toBe(true);
    checkpointWalTruncate();

    const afterDelete = readDbAndWal();
    for (const token of [marker, markerLower, markerFtsSuffix, turnEmail, turnNik, turnNpwp]) {
      expect(afterDelete.db.includes(Buffer.from(token, "utf8"))).toBe(false);
      expect(afterDelete.wal.includes(Buffer.from(token, "utf8"))).toBe(false);
    }
  });

  it("seals knowledge_sources.name for origin_kind='thread' at rest while keeping sources APIs readable and thread delete removing the row", async () => {
    const tenant = await getTenant();
    const ready = await agentService.ensureDefaultChat(tenant);
    const plantedTitle = "Confidential Thread Work Card 4821";
    const bodyToken = "sapphirebeacon4821";
    const thread = await createThread(tenant, ready.agent.id, plantedTitle);

    const upserted = await upsertWorkSource(
      tenant,
      chatWorkCard({
        threadId: thread.id,
        title: plantedTitle,
        userText: `Analyze ${bodyToken}`,
        assistantText: `Summary for ${bodyToken} completed.`,
      }),
    );
    expect(upserted.status).toBe("indexed");
    if (upserted.status === "skipped") {
      throw new Error("unexpected skip");
    }
    expect(upserted.source.name).toBe(plantedTitle);

    const rawRow = sql
      .prepare("SELECT name FROM knowledge_sources WHERE workspace_id = ? AND origin_kind = 'thread' AND origin_id = ?")
      .get(tenant.workspaceId, thread.id) as { name: string } | undefined;
    expect(rawRow).toBeDefined();
    expect(isSealedThreadTitle(rawRow?.name ?? "")).toBe(true);
    expect(rawRow?.name).not.toContain(plantedTitle);
    expect(rawRow?.name).not.toContain("4821");

    expect(listSources(tenant).find((item) => item.id === upserted.source.id)?.name).toBe(plantedTitle);
    expect(findSourceByOrigin(tenant, { kind: "thread", id: thread.id })?.name).toBe(plantedTitle);

    const apiResponse = await handleGetKnowledge({
      method: "GET",
      path: "/api/v1/knowledge",
      query: {},
      params: {},
      headers: {},
      body: undefined,
    });
    expect(apiResponse.status).toBe(200);
    if (!("body" in apiResponse)) {
      throw new Error("Expected JSON response body");
    }
    const apiBody = apiResponse.body as { sources: Array<{ id: string; name: string }> };
    expect(apiBody.sources.find((item) => item.id === upserted.source.id)?.name).toBe(plantedTitle);

    const retrieved = await retrieveChunks(tenant, bodyToken, 4);
    expect(retrieved.chunks[0]?.sourceName).toBe(plantedTitle);

    const searchResult = (await invokeToolGuarded(knowledgeSearchTool, { query: bodyToken }, tenant)) as {
      results: Array<{ title: string; source_id: string }>;
    };
    expect(searchResult.results[0]?.title).toBe(plantedTitle);

    const reindexed = await reindexSource(tenant, upserted.source.id);
    expect(reindexed).toMatchObject({ status: "reindexed", sourceId: upserted.source.id, name: plantedTitle });
    const rawAfterReindex = sql
      .prepare("SELECT name FROM knowledge_sources WHERE workspace_id = ? AND id = ?")
      .get(tenant.workspaceId, upserted.source.id) as { name: string };
    expect(isSealedThreadTitle(rawAfterReindex.name)).toBe(true);
    expect(rawAfterReindex.name).not.toContain(plantedTitle);

    const legacyThreadId = `legacy-thread-${crypto.randomUUID()}`;
    const legacySourceId = crypto.randomUUID();
    const legacyName = "Legacy Plaintext Chat Card 9012";
    sql
      .prepare(
        `INSERT INTO threads (id, organization_id, workspace_id, agent_id, user_id, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(legacyThreadId, tenant.organizationId, tenant.workspaceId, ready.agent.id, tenant.userId, legacyName, Date.now());
    sql
      .prepare(
        `INSERT INTO knowledge_sources (id, workspace_id, name, type, status, chunks, error, created_at, origin_kind, origin_id)
         VALUES (?, ?, ?, 'Chat', 'Indexed', 0, NULL, ?, 'thread', ?)`,
      )
      .run(legacySourceId, tenant.workspaceId, legacyName, Date.now(), legacyThreadId);
    expect(listSources(tenant).find((item) => item.id === legacySourceId)?.name).toBe(legacyName);
    expect(findSourceByOrigin(tenant, { kind: "thread", id: legacyThreadId })?.name).toBe(legacyName);

    expect(await deleteThread(tenant, thread.id)).toBe(true);
    const remaining = sql
      .prepare("SELECT count(*) AS n FROM knowledge_sources WHERE workspace_id = ? AND origin_kind = 'thread' AND origin_id = ?")
      .get(tenant.workspaceId, thread.id) as { n: number };
    expect(remaining.n).toBe(0);
    expect(findSourceByOrigin(tenant, { kind: "thread", id: thread.id })).toBeNull();

    await deleteThread(tenant, legacyThreadId);
  });
});
