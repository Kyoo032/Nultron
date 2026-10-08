/**
 * Legal mode — matter store over `localDataDir()/legal/tenants/<tenantId>/<workspaceId>/<matterId>/`,
 * which for the local tenant is the pre-Phase-3 `localDataDir()/legal/<workspaceId>/<matterId>/`.
 *
 * Every method filters on `tenant.tenantId` (through the path) and on `tenant.workspaceId`; records
 * from another tenant or another workspace read as missing.
 * Records are immutable: each mutation persists and returns a new object.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiError, type TenantContext } from "@agentforge/core";
import type { DocxDocument } from "@agentforge/core/docx";
import type {
  DeliverableKind,
  DocRole,
  LegalAsksFile,
  LegalExtractEditsFile,
  LegalExtractRecord,
  LegalSide,
  LegalWorkType,
  MatterDocCard,
} from "@agentforge/core/legal";
import { localDataDir } from "@agentforge/db/vault-key";
import { deleteArtifactsByOwner, sweepOrphanSources } from "../knowledge";
import {
  type LegalMatterRecord,
  type LegalRunRecord,
  legalAsksFileSchema,
  legalExtractEditsFileSchema,
  legalExtractRecordSchema,
  legalMatterRecordSchema,
  legalRunRecordSchema,
} from "./records";
import {
  LEGAL_LIST_LIMIT,
  asksFile,
  assertFileCaps,
  assertSafeId,
  buildDocCard,
  cardFile,
  docFile,
  docNumber,
  extractEditsFile,
  extractFilePath,
  listMatterIds,
  matterDir,
  matterFile,
  nextDocId,
  pagesFile,
  parseLegalFileOrThrow,
  parsedFile,
  readBytesIfPresent,
  readJson,
  runFile,
  sha256Hex,
  writeJsonAtomic,
} from "./store-files";

export type { LegalMatterRecord, LegalRunArtifact, LegalRunRecord } from "./records";

export type CreateMatterInput = {
  title: string;
  side: LegalSide;
  workType: LegalWorkType;
  deliverables: DeliverableKind[];
  instructions?: string;
  playbookId?: string | null;
  author?: string;
  addressee?: string;
  firm?: string;
  priorMatterId?: string | null;
};

export type MatterPatch = Partial<
  Pick<
    LegalMatterRecord,
    | "title"
    | "side"
    | "sideDeclined"
    | "workType"
    | "deliverables"
    | "instructions"
    | "playbookId"
    | "author"
    | "addressee"
    | "firm"
  >
>;

export type MatterRoleInput = { id: string; role: DocRole };
export type MatterFileInput = { filename: string; bytes: Uint8Array };

export interface LegalStore {
  create(tenant: TenantContext, input: CreateMatterInput): LegalMatterRecord;
  /** Newest first, capped at LEGAL_LIST_LIMIT. */
  list(tenant: TenantContext): LegalMatterRecord[];
  get(tenant: TenantContext, id: string): LegalMatterRecord | null;
  remove(tenant: TenantContext, id: string): boolean;
  addFile(
    tenant: TenantContext,
    id: string,
    file: MatterFileInput,
  ): Promise<{ matter: LegalMatterRecord; card: MatterDocCard }>;
  removeFile(tenant: TenantContext, id: string, docId: string): LegalMatterRecord;
  readDoc(tenant: TenantContext, id: string, docId: string): Promise<DocxDocument | null>;
  readBytes(tenant: TenantContext, id: string, docId: string): Uint8Array | null;
  setRoles(tenant: TenantContext, id: string, roles: readonly MatterRoleInput[]): LegalMatterRecord;
  update(tenant: TenantContext, id: string, patch: MatterPatch): LegalMatterRecord;
  saveRun(tenant: TenantContext, id: string, run: LegalRunRecord): void;
  getRun(tenant: TenantContext, id: string, runId: string): LegalRunRecord | null;
  /** Paragraph anchor -> page of a PDF whose reader marked its pages; null for Word files and unmarked PDFs. */
  readPages(tenant: TenantContext, id: string, docId: string): Record<string, number> | null;
  /** The latest extraction, or null before the first. */
  getExtract(tenant: TenantContext, id: string): LegalExtractRecord | null;
  saveExtract(tenant: TenantContext, id: string, record: LegalExtractRecord): void;
  /** The owner's edits and comments on the extraction; empty before the first. */
  getExtractEdits(tenant: TenantContext, id: string): LegalExtractEditsFile;
  saveExtractEdits(tenant: TenantContext, id: string, file: LegalExtractEditsFile): void;
  /** The questions asked and their answers, oldest first; empty before the first. */
  getAsks(tenant: TenantContext, id: string): LegalAsksFile;
  saveAsks(tenant: TenantContext, id: string, file: LegalAsksFile): void;
}

const TITLE_MAX = 200;

function newMatter(tenant: TenantContext, input: CreateMatterInput): LegalMatterRecord {
  const title = input.title.trim().slice(0, TITLE_MAX);
  if (!title) {
    throw new ApiError("invalid_request", "Matter title is required", 400);
  }
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    workspaceId: tenant.workspaceId,
    title,
    createdAt: now,
    updatedAt: now,
    side: { ...input.side },
    workType: input.workType,
    deliverables: [...input.deliverables],
    instructions: input.instructions ?? "",
    playbookId: input.playbookId ?? null,
    author: input.author ?? "",
    addressee: input.addressee ?? "",
    firm: input.firm ?? "",
    docs: [],
    priorMatterId: input.priorMatterId ?? null,
    lastRunId: null,
  };
}

/** Drop undefined keys so a partial patch never blanks a field. */
function definedEntries<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function createLegalStore(rootDir: string): LegalStore {
  const dirFor = (tenant: TenantContext, id: string): string =>
    matterDir(rootDir, tenant.tenantId, tenant.workspaceId, id);

  const load = (tenant: TenantContext, id: string): LegalMatterRecord | null => {
    const raw = readJson(matterFile(dirFor(tenant, id)));
    if (raw === null) {
      return null;
    }
    const parsed = legalMatterRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError("internal_error", `Stored matter ${id} is malformed: ${parsed.error.issues[0]?.message}`, 500);
    }
    return parsed.data.workspaceId === tenant.workspaceId ? parsed.data : null;
  };

  const require = (tenant: TenantContext, id: string): LegalMatterRecord => {
    const matter = load(tenant, id);
    if (!matter) {
      throw new ApiError("not_found", "Matter not found", 404);
    }
    return matter;
  };

  const persist = (tenant: TenantContext, matter: LegalMatterRecord): LegalMatterRecord => {
    writeJsonAtomic(matterFile(dirFor(tenant, matter.id)), matter);
    return matter;
  };

  /** A record beside matter.json: null when the file is missing, an error when the matter is gone or the file is malformed. */
  const readSidecar = <T>(
    tenant: TenantContext,
    id: string,
    fileOf: (dir: string) => string,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
    },
    label: string,
  ): T | null => {
    require(tenant, id);
    const raw = readJson(fileOf(dirFor(tenant, id)));
    if (raw === null) {
      return null;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError("internal_error", `Stored ${label} for ${id} is malformed: ${parsed.error.issues[0]?.message}`, 500);
    }
    return parsed.data;
  };

  const requireDoc = (matter: LegalMatterRecord, docId: string): MatterDocCard => {
    const card = matter.docs.find((doc) => doc.id === docId);
    if (!card) {
      throw new ApiError("not_found", "Document not found in this matter", 404);
    }
    return card;
  };

  return {
    create(tenant, input) {
      return persist(tenant, newMatter(tenant, input));
    },

    list(tenant) {
      return listMatterIds(rootDir, tenant.tenantId, tenant.workspaceId)
        .map((id) => load(tenant, id))
        .filter((matter): matter is LegalMatterRecord => matter !== null)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, LEGAL_LIST_LIMIT);
    },

    get(tenant, id) {
      return load(tenant, id);
    },

    remove(tenant, id) {
      if (!load(tenant, id)) {
        return false;
      }
      rmSync(dirFor(tenant, id), { recursive: true, force: true });
      // The matter's deliverables and its manifest are artifacts, and its Knowledge card hangs off
      // one of them. Removing the matter directory alone left the red-flags text feeding every later
      // Chat turn in this workspace, named after a matter the owner believes they deleted.
      deleteArtifactsByOwner(tenant, "matterId", id);
      sweepOrphanSources(tenant);
      return true;
    },

    async addFile(tenant, id, file) {
      const matter = require(tenant, id);
      assertFileCaps(matter.docs, file.bytes);
      const sha256 = sha256Hex(file.bytes);
      const duplicate = matter.docs.find((doc) => doc.sha256 === sha256);
      if (duplicate) {
        throw new ApiError(
          "conflict",
          `This file is already in the matter as ${duplicate.id} (${duplicate.name})`,
          409,
        );
      }
      const { format, doc, pages } = await parseLegalFileOrThrow(file.bytes);
      const docId = nextDocId(matter.docs, matter.docSeq ?? 0);
      const card = buildDocCard({ id: docId, filename: file.filename, bytes: file.bytes, sha256, doc, format });
      const dir = dirFor(tenant, id);
      const bytesPath = docFile(dir, docId, format);
      const cachePath = parsedFile(dir, docId);
      const pagesPath = pagesFile(dir, docId);
      try {
        mkdirSync(path.dirname(bytesPath), { recursive: true });
        writeFileSync(bytesPath, file.bytes);
        writeJsonAtomic(cachePath, doc);
        if (pages) {
          writeJsonAtomic(pagesPath, pages);
        }
        const next = persist(tenant, {
          ...matter,
          docs: [...matter.docs, card],
          docSeq: docNumber(docId),
          updatedAt: Date.now(),
        });
        return { matter: next, card };
      } catch (error) {
        // No card means no file: do not leave orphaned bytes behind.
        rmSync(bytesPath, { force: true });
        rmSync(cachePath, { force: true });
        rmSync(pagesPath, { force: true });
        throw error;
      }
    },

    removeFile(tenant, id, docId) {
      const matter = require(tenant, id);
      const card = requireDoc(matter, docId);
      const dir = dirFor(tenant, id);
      const next = persist(tenant, {
        ...matter,
        docs: matter.docs.filter((doc) => doc.id !== card.id),
        updatedAt: Date.now(),
      });
      rmSync(cardFile(dir, card), { force: true });
      rmSync(parsedFile(dir, card.id), { force: true });
      rmSync(pagesFile(dir, card.id), { force: true });
      return next;
    },

    async readDoc(tenant, id, docId) {
      const matter = load(tenant, id);
      if (!matter?.docs.some((doc) => doc.id === docId)) {
        return null;
      }
      const cached = readJson(parsedFile(dirFor(tenant, id), docId));
      if (cached === null) {
        return null;
      }
      if (typeof cached !== "object" || !Array.isArray((cached as { paragraphs?: unknown }).paragraphs)) {
        throw new ApiError("internal_error", `Cached reader output for ${docId} is malformed`, 500);
      }
      return cached as DocxDocument;
    },

    readBytes(tenant, id, docId) {
      const matter = load(tenant, id);
      if (!matter?.docs.some((doc) => doc.id === docId)) {
        return null;
      }
      const card = matter.docs.find((doc) => doc.id === docId) as MatterDocCard;
      return readBytesIfPresent(cardFile(dirFor(tenant, id), card));
    },

    setRoles(tenant, id, roles) {
      const matter = require(tenant, id);
      const byId = new Map(roles.map((entry) => [entry.id, entry.role] as const));
      for (const docId of byId.keys()) {
        requireDoc(matter, docId);
      }
      const docs = matter.docs.map((doc) => {
        const role = byId.get(doc.id);
        return role ? { ...doc, role } : doc;
      });
      return persist(tenant, { ...matter, docs, updatedAt: Date.now() });
    },

    update(tenant, id, patch) {
      const matter = require(tenant, id);
      const changes = definedEntries(patch);
      const title = changes.title === undefined ? matter.title : changes.title.trim().slice(0, TITLE_MAX);
      if (!title) {
        throw new ApiError("invalid_request", "Matter title is required", 400);
      }
      // Setting a side answers the side question, so an earlier "neither" no longer stands.
      const answered = changes.side !== undefined && changes.side.party.trim() !== "" && matter.sideDeclined === true;
      return persist(tenant, {
        ...matter,
        ...changes,
        ...(answered && changes.sideDeclined === undefined ? { sideDeclined: false } : {}),
        title,
        updatedAt: Date.now(),
      });
    },

    saveRun(tenant, id, run) {
      const matter = require(tenant, id);
      assertSafeId(run.id, "Run id");
      if (run.matterId !== matter.id) {
        throw new ApiError("invalid_request", "Run does not belong to this matter", 400);
      }
      writeJsonAtomic(runFile(dirFor(tenant, id), run.id), run);
      persist(tenant, { ...matter, lastRunId: run.id, updatedAt: Date.now() });
    },

    getRun(tenant, id, runId) {
      if (!load(tenant, id)) {
        return null;
      }
      const file = runFile(dirFor(tenant, id), runId);
      const raw = existsSync(file) ? readJson(file) : null;
      if (raw === null) {
        return null;
      }
      const parsed = legalRunRecordSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          "internal_error",
          `Stored run ${runId} is malformed: ${parsed.error.issues[0]?.message}`,
          500,
        );
      }
      return parsed.data;
    },

    readPages(tenant, id, docId) {
      const matter = load(tenant, id);
      if (!matter?.docs.some((doc) => doc.id === docId)) {
        return null;
      }
      const raw = readJson(pagesFile(dirFor(tenant, id), docId));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
      }
      // The file is on disk and can be edited: keep only `¶n -> page` entries a record may hold.
      const pages = Object.entries(raw).filter(
        (entry): entry is [string, number] => /^¶\d+$/.test(entry[0]) && Number.isInteger(entry[1]) && (entry[1] as number) > 0,
      );
      return pages.length > 0 ? Object.fromEntries(pages) : null;
    },

    getExtract(tenant, id) {
      return readSidecar(tenant, id, extractFilePath, legalExtractRecordSchema, "extraction");
    },

    saveExtract(tenant, id, record) {
      require(tenant, id);
      if (record.matterId !== id) {
        throw new ApiError("invalid_request", "Extraction does not belong to this matter", 400);
      }
      writeJsonAtomic(extractFilePath(dirFor(tenant, id)), legalExtractRecordSchema.parse(record));
    },

    getExtractEdits(tenant, id) {
      return (
        readSidecar(tenant, id, extractEditsFile, legalExtractEditsFileSchema, "edits") ?? {
          version: 1,
          edits: [],
          comments: [],
        }
      );
    },

    saveExtractEdits(tenant, id, file) {
      require(tenant, id);
      writeJsonAtomic(extractEditsFile(dirFor(tenant, id)), legalExtractEditsFileSchema.parse(file));
    },

    getAsks(tenant, id) {
      return readSidecar(tenant, id, asksFile, legalAsksFileSchema, "questions") ?? { version: 1, asks: [] };
    },

    saveAsks(tenant, id, file) {
      require(tenant, id);
      writeJsonAtomic(asksFile(dirFor(tenant, id)), legalAsksFileSchema.parse(file));
    },
  };
}

let defaultStore: LegalStore | null = null;

export function legalRoot(): string {
  return path.resolve(localDataDir(), "legal");
}

/** Singleton over `localDataDir()/legal`. */
export function legalStore(): LegalStore {
  if (!defaultStore) {
    defaultStore = createLegalStore(legalRoot());
  }
  return defaultStore;
}

export function requireLegalMatter(tenant: TenantContext, id: string): LegalMatterRecord {
  const matter = legalStore().get(tenant, id);
  if (!matter) {
    throw new ApiError("not_found", "Matter not found", 404);
  }
  return matter;
}
