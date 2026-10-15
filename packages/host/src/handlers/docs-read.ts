import { ApiError, STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE } from "@agentforge/core";
import { artifactFilename, DOCX_MIME, PDF_MIME, XLSX_MIME, type ArtifactMime } from "@agentforge/core/artifacts";
import { requireArtifact } from "../artifacts";
import { renderDocx, renderPdf, renderXlsx } from "../doc-model";
import type { EditableSpec } from "../doc-tools/doc-meta";
import { docVersionStore, proposalStore, type DocVersion, type DocVersionInfo } from "../doc-versions";
import type { EnsureFirstRefusal } from "../doc-versions/types";
import { jsonError, jsonOk } from "../errors";
import { log } from "../log";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";
import { artifactFileDelivery } from "./artifacts";

const DOCUMENT_FORMATS: ReadonlyMap<string, ArtifactMime> = new Map([
  ["docx", DOCX_MIME],
  ["pdf", PDF_MIME],
]);
const WORKBOOK_FORMATS: ReadonlyMap<string, ArtifactMime> = new Map([["xlsx", XLSX_MIME]]);

const NOT_EDITABLE_MESSAGE = "This file has no editable spec, so it has no document versions.";
const VERSION_NOT_FOUND_MESSAGE = "No version with that number.";
const RENDER_FAILED_MESSAGE = "The file could not be made right now. Try again in a moment.";

function docRoute(work: (request: HostRequest) => Promise<HostResult>): (request: HostRequest) => Promise<HostResult> {
  return async (request) => {
    try {
      return await work(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}

function refusalOf(reason: EnsureFirstRefusal): ApiError {
  if (reason === "quota") {
    return new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403);
  }
  if (reason === "not_found") {
    return new ApiError("not_found", "Artifact not found", 404);
  }
  return new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
}

async function openDocument(request: HostRequest) {
  const tenant = await getTenant(request);
  const artifactId = request.params.artifactId;
  const artifact = requireArtifact(tenant, artifactId);
  const store = docVersionStore();
  const first = await store.ensureFirstVersion(tenant, artifactId);
  if (!first.ok) {
    throw refusalOf(first.reason);
  }
  return { tenant, artifactId, title: artifact.title, head: first.head, store };
}

function parseVersionNumber(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function mimeForFormat(kind: DocVersionInfo["kind"], format: string | undefined): ArtifactMime {
  const allowed = kind === "workbook" ? WORKBOOK_FORMATS : DOCUMENT_FORMATS;
  const mime = format === undefined ? undefined : allowed.get(format);
  if (mime === undefined) {
    const expected = kind === "workbook" ? "xlsx" : "docx or pdf";
    throw new ApiError("bad_format", `format must be ${expected} for this file.`, 400);
  }
  return mime;
}

async function renderVersion(spec: EditableSpec, mime: ArtifactMime): Promise<Uint8Array> {
  if (spec.kind === "workbook") {
    return renderXlsx(spec.spec);
  }
  return mime === PDF_MIME ? renderPdf(spec.spec) : renderDocx(spec.spec);
}

export const handleGetDoc = docRoute(async (request) => {
  const { tenant, artifactId, title, head, store } = await openDocument(request);
  const version = store.getVersion(tenant, artifactId, head.version);
  const sectionAuthors = store.sectionAuthors(tenant, artifactId);
  if (version === null || sectionAuthors === null) {
    throw new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
  }
  return jsonOk({
    artifactId,
    title,
    kind: head.kind,
    headVersion: head.version,
    spec: version.spec.spec,
    sectionAuthors,
    proposals: proposalStore().listPending(tenant, artifactId) ?? [],
  });
});

export const handleGetDocVersions = docRoute(async (request) => {
  const { tenant, artifactId, store } = await openDocument(request);
  const items = store.listVersions(tenant, artifactId);
  if (items === null) {
    throw new ApiError("not_found", "Artifact not found", 404);
  }
  return jsonOk({ items });
});

export const handleGetDocVersionFile = docRoute(async (request) => {
  const { tenant, artifactId, title, store } = await openDocument(request);
  const number = parseVersionNumber(request.params.n);
  const version: DocVersion | null = number === null ? null : store.getVersion(tenant, artifactId, number);
  if (number === null || version === null) {
    throw new ApiError("not_found", VERSION_NOT_FOUND_MESSAGE, 404);
  }
  const mime = mimeForFormat(version.kind, request.query.format);
  let bytes: Uint8Array;
  try {
    bytes = await renderVersion(version.spec, mime);
  } catch (error) {
    log.warn("doc_version_render_failed", { format: mime, detail: error instanceof Error ? error.name : "error" });
    throw new ApiError("render_failed", RENDER_FAILED_MESSAGE, 503);
  }
  const filename = artifactFilename(`${title} v${number}`, mime);
  const delivery = artifactFileDelivery(mime, filename);
  return {
    type: "bytes",
    status: 200,
    bytes,
    contentType: delivery.contentType,
    filename,
    headers: delivery.headers,
  };
});
