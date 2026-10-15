import { ApiError, STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, type TenantContext } from "@agentforge/core";
import { requireArtifact } from "../artifacts";
import { DocModelError, replaceSection, type DocSpec, type Section } from "../doc-model";
import { sectionSchema } from "../doc-model/types";
import { readEditableSpec, type EditableSpec } from "../doc-tools/doc-meta";
import {
  docVersionStore,
  newSectionId,
  type AppendResult,
  type DocVersionInfo,
  type SectionAuthors,
} from "../doc-versions";
import type { EnsureFirstRefusal } from "../doc-versions/types";
import { refreshHeadBody } from "../doc-versions/render-head";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostJsonResult, HostRequest, HostResult } from "../types";

const NOT_EDITABLE_MESSAGE = "This file has no editable spec, so it has no document versions.";
const WORKBOOK_SECTIONS_MESSAGE = "Workbooks are not edited section by section yet.";
const SECTION_NOT_FOUND_MESSAGE = "No section with that id in this document.";
const LAST_SECTION_MESSAGE = "A document keeps at least one section, so this one cannot be deleted.";
const VERSION_NOT_FOUND_MESSAGE = "No version with that number.";
const BAD_BASE_MESSAGE = "The base version is not one this file has.";
const KIND_CHANGED_MESSAGE = "A document cannot change into a workbook.";
const SECTION_CHANGED_MESSAGE = "This section changed since the version you started from.";
const ARTIFACT_NOT_FOUND_MESSAGE = "Artifact not found";
const BASE_VERSION_MESSAGE = "baseVersion must be a positive whole number.";
const SECTION_SHAPE_MESSAGE = "section must be an object.";

const SECTION_CONTENT = sectionSchema.omit({ id: true });

type SectionContent = Omit<Section, "id">;

type WriteTarget = { readonly tenant: TenantContext; readonly artifactId: string };

export type WriteAnswer = {
  readonly headVersion: number;
  readonly version: DocVersionInfo | null;
  readonly sectionAuthors: SectionAuthors;
  readonly bodyRefreshed: boolean;
};

function docWriteRoute(
  work: (request: HostRequest) => Promise<HostResult>,
): (request: HostRequest) => Promise<HostResult> {
  return async (request) => {
    try {
      return await work(request);
    } catch (error) {
      if (error instanceof DocModelError) {
        return jsonError(new ApiError("invalid_section", error.message, 400));
      }
      return jsonError(error);
    }
  };
}

function bodyOf(request: HostRequest): Record<string, unknown> {
  return request.body !== null && typeof request.body === "object" && !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
}

export function baseVersionOf(body: Record<string, unknown>): number {
  const value = body.baseVersion;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError("invalid_request", BASE_VERSION_MESSAGE, 400);
  }
  return value;
}

function afterSectionOf(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new ApiError("invalid_request", "afterSectionId must be a section id.", 400);
}

function sectionContentOf(raw: unknown): SectionContent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("invalid_request", SECTION_SHAPE_MESSAGE, 400);
  }
  const parsed = SECTION_CONTENT.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "section"}: ${issue.message}`)
      .join("; ");
    throw new ApiError("invalid_section", `Invalid section: ${detail}`, 400);
  }
  return parsed.data;
}

function parseVersionNumber(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function sectionMissing(): ApiError {
  return new ApiError("section_not_found", SECTION_NOT_FOUND_MESSAGE, 404);
}

function documentOf(head: EditableSpec): DocSpec {
  if (head.kind !== "document") {
    throw new ApiError("not_editable", WORKBOOK_SECTIONS_MESSAGE, 409);
  }
  return head.spec;
}

function replaceSectionEdit(sectionId: string, content: SectionContent): (head: EditableSpec) => EditableSpec {
  return (head) => {
    const doc = documentOf(head);
    if (!doc.sections.some((section) => section.id === sectionId)) {
      throw sectionMissing();
    }
    return { kind: "document", spec: replaceSection(doc, sectionId, { ...content, id: sectionId }) };
  };
}

function insertSectionEdit(
  content: SectionContent,
  afterSectionId: string | undefined,
): (head: EditableSpec) => EditableSpec {
  return (head) => {
    const doc = documentOf(head);
    const id = newSectionId(head);
    const at =
      afterSectionId === undefined
        ? doc.sections.length
        : doc.sections.findIndex((section) => section.id === afterSectionId) + 1;
    if (afterSectionId !== undefined && at === 0) {
      throw sectionMissing();
    }
    const section: Section = { ...content, id };
    const sections = [...doc.sections.slice(0, at), section, ...doc.sections.slice(at)];
    return { kind: "document", spec: { ...doc, sections } };
  };
}

function withoutSectionEdit(sectionId: string): (head: EditableSpec) => EditableSpec {
  return (head) => {
    const doc = documentOf(head);
    const at = doc.sections.findIndex((section) => section.id === sectionId);
    if (at === -1) {
      throw sectionMissing();
    }
    if (doc.sections.length === 1) {
      throw new ApiError("last_section", LAST_SECTION_MESSAGE, 409);
    }
    const sections = [...doc.sections.slice(0, at), ...doc.sections.slice(at + 1)];
    return { kind: "document", spec: { ...doc, sections } };
  };
}

async function openForWrite(request: HostRequest): Promise<WriteTarget> {
  const tenant = await getTenant(request);
  const artifactId = request.params.artifactId;
  const record = requireArtifact(tenant, artifactId);
  if (readEditableSpec(record) === null) {
    throw new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
  }
  return { tenant, artifactId };
}

function refusedResult(result: Extract<AppendResult, { ok: false }>): HostJsonResult {
  switch (result.reason) {
    case "section_changed":
      return jsonError(new ApiError("section_changed", SECTION_CHANGED_MESSAGE, 409), {
        sectionIds: result.sectionIds ?? [],
      });
    case "bad_base":
      return jsonError(new ApiError("bad_base", BAD_BASE_MESSAGE, 409));
    case "quota":
      return jsonError(new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403));
    case "not_found":
      return jsonError(new ApiError("not_found", ARTIFACT_NOT_FOUND_MESSAGE, 404));
    case "not_editable":
      return jsonError(new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409));
    case "kind_changed":
      return jsonError(new ApiError("kind_changed", KIND_CHANGED_MESSAGE, 409));
  }
}

export async function writeAnswer(
  tenant: TenantContext,
  artifactId: string,
  head: DocVersionInfo,
  created: boolean,
): Promise<WriteAnswer> {
  const refreshed = await refreshHeadBody(tenant, artifactId);
  const sectionAuthors = docVersionStore().sectionAuthors(tenant, artifactId);
  if (sectionAuthors === null) {
    throw new ApiError("not_found", ARTIFACT_NOT_FOUND_MESSAGE, 404);
  }
  return {
    headVersion: head.version,
    version: created ? head : null,
    sectionAuthors,
    bodyRefreshed: refreshed.ok,
  };
}

async function settle(
  tenant: TenantContext,
  artifactId: string,
  result: AppendResult,
  createdStatus: number,
): Promise<HostResult> {
  if (!result.ok) {
    return refusedResult(result);
  }
  const answer = await writeAnswer(tenant, artifactId, result.head, result.created);
  return jsonOk(answer, result.created ? createdStatus : 200);
}

export const handlePutDocSection = docWriteRoute(async (request) => {
  const { tenant, artifactId } = await openForWrite(request);
  const body = bodyOf(request);
  const baseVersion = baseVersionOf(body);
  const content = sectionContentOf(body.section);
  const result = docVersionStore().appendVersion(tenant, artifactId, {
    baseVersion,
    author: { kind: "person" },
    edit: replaceSectionEdit(request.params.sectionId, content),
  });
  return settle(tenant, artifactId, result, 200);
});

export const handlePostDocSection = docWriteRoute(async (request) => {
  const { tenant, artifactId } = await openForWrite(request);
  const body = bodyOf(request);
  const baseVersion = baseVersionOf(body);
  const content = sectionContentOf(body.section);
  const result = docVersionStore().appendVersion(tenant, artifactId, {
    baseVersion,
    author: { kind: "person" },
    edit: insertSectionEdit(content, afterSectionOf(body.afterSectionId)),
  });
  return settle(tenant, artifactId, result, 201);
});

export const handleDeleteDocSection = docWriteRoute(async (request) => {
  const { tenant, artifactId } = await openForWrite(request);
  const baseVersion = baseVersionOf(bodyOf(request));
  const result = docVersionStore().appendVersion(tenant, artifactId, {
    baseVersion,
    author: { kind: "person" },
    edit: withoutSectionEdit(request.params.sectionId),
  });
  return settle(tenant, artifactId, result, 200);
});

function firstVersionRefusal(reason: EnsureFirstRefusal): ApiError {
  if (reason === "quota") {
    return new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403);
  }
  if (reason === "not_found") {
    return new ApiError("not_found", ARTIFACT_NOT_FOUND_MESSAGE, 404);
  }
  return new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
}

export const handlePostDocRestore = docWriteRoute(async (request) => {
  const { tenant, artifactId } = await openForWrite(request);
  const baseVersion = baseVersionOf(bodyOf(request));
  const number = parseVersionNumber(request.params.n);
  if (number === null) {
    throw new ApiError("not_found", VERSION_NOT_FOUND_MESSAGE, 404);
  }
  const versions = docVersionStore();
  const first = versions.ensureFirstVersion(tenant, artifactId);
  if (!first.ok) {
    throw firstVersionRefusal(first.reason);
  }
  const target = versions.getVersion(tenant, artifactId, number);
  if (target === null) {
    throw new ApiError("not_found", VERSION_NOT_FOUND_MESSAGE, 404);
  }
  const result = versions.appendVersion(tenant, artifactId, {
    baseVersion,
    author: { kind: "person" },
    note: `restored v${number}`,
    edit: () => target.spec,
  });
  return settle(tenant, artifactId, result, 201);
});
