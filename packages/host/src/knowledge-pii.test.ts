import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

const { sql } = await import("@agentforge/db");
const { sqliteFilePath } = await import("@agentforge/db/vault-key");
const { addFileSource, addPastedSource, addUrlSource, deleteSource, retrieveChunks } = await import("./knowledge");
const { STUB_EMBED_MODEL } = await import("./knowledge-embed");
const { reindexSource } = await import("./knowledge-reindex");
const { isSealedVectorBody, openVectorBody } = await import("./knowledge-vector-seal");
const { stubEmbed } = await import("@agentforge/core");

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

describe("Knowledge vectors at-rest encryption and SQLite secure_delete", () => {
  it("runs SQLite with PRAGMA secure_delete = 1", () => {
    const enabled = sql.pragma("secure_delete", { simple: true });
    expect(enabled).toBe(1);
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

  it("leaves no remnant of a planted string in the raw DB file after deleting a source and checkpointing WAL", async () => {
    const ctx = makeTenant();
    const planted = "EPHEMERAL-SECURE-DELETE-MARKER-88241";
    const source = await addPastedSource(ctx, "Delete probe", `Temporary note holding ${planted} before deletion.`);
    expect(source.status).toBe("Indexed");
    sql.pragma("wal_checkpoint(TRUNCATE)");

    expect(deleteSource(ctx, source.id)).toBe(true);
    sql.pragma("wal_checkpoint(TRUNCATE)");

    const rawDbBytes = readFileSync(sqliteFilePath());
    expect(rawDbBytes.includes(Buffer.from(planted, "utf8"))).toBe(false);
  });
});
