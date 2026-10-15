import { ApiError, STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE } from "@agentforge/core";
import { docVersionStore, proposalStore } from "../doc-versions";
import { agentForProposal } from "../doc-versions/proposal-agent";
import { MAX_INSTRUCTION_CHARS, writeSectionProposal } from "../doc-versions/propose-section";
import { refreshHeadBody } from "../doc-versions/render-head";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { findVisibleFile } from "../projects/store";
import { withRunSlot } from "../run-limits";
import { getTenant } from "../tenant";
import type { HostJsonResult, HostRequest, HostResult } from "../types";

const MAX_AGENT_ID_CHARS = 64;

const ARTIFACT_NOT_FOUND = "Artifact not found";
const PROPOSAL_NOT_FOUND = "Proposal not found";
const NOT_EDITABLE_MESSAGE = "This file has no editable document spec, so an agent cannot rewrite a section of it.";
const AGENT_NOT_IN_WORKSPACE_MESSAGE =
  "This agent is not in the Workspace. A member brings it in first, or pick an agent from your own desk.";
const INVALID_SECTION_MESSAGE = "The agent did not return a section the document can hold. Try again.";
const SECTION_CHANGED_MESSAGE = "This section changed since the version you started from.";
const NOT_PENDING_MESSAGE = "This proposal was already kept or discarded.";

type AskBody = { readonly agentId: string; readonly instruction: string; readonly baseVersion: number };

type Refusal =
  | "not_found"
  | "not_editable"
  | "bad_base"
  | "bad_section"
  | "kind_changed"
  | "section_changed"
  | "not_pending"
  | "quota";

function route(work: (request: HostRequest) => Promise<HostResult>): (request: HostRequest) => Promise<HostResult> {
  return async (request) => {
    try {
      return await work(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}

function invalid(message: string): ApiError {
  return new ApiError("invalid_request", message, 400);
}

function parseAsk(body: unknown): AskBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("Request body must be a JSON object");
  }
  const { agentId, instruction, baseVersion } = body as Record<string, unknown>;
  if (typeof agentId !== "string" || agentId.trim() === "" || agentId.length > MAX_AGENT_ID_CHARS) {
    throw invalid("agentId is required");
  }
  if (typeof instruction !== "string" || instruction.trim() === "") {
    throw invalid("instruction is required");
  }
  if (instruction.trim().length > MAX_INSTRUCTION_CHARS) {
    throw invalid(`instruction is longer than ${MAX_INSTRUCTION_CHARS} characters`);
  }
  if (typeof baseVersion !== "number" || !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
    throw invalid("baseVersion must be a positive whole number");
  }
  return { agentId: agentId.trim(), instruction: instruction.trim(), baseVersion };
}

function sectionChanged(sectionIds: readonly string[]): HostJsonResult {
  return {
    type: "json",
    status: 409,
    body: { error: { code: "section_changed", message: SECTION_CHANGED_MESSAGE, sectionIds } },
  };
}

function refusalError(reason: Refusal): ApiError {
  switch (reason) {
    case "not_found":
      return new ApiError("not_found", PROPOSAL_NOT_FOUND, 404);
    case "quota":
      return new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403);
    case "bad_base":
      return new ApiError("bad_base", "The version this proposal started from is no longer available.", 409);
    case "bad_section":
      return new ApiError("invalid_section", INVALID_SECTION_MESSAGE, 502);
    case "not_pending":
      return new ApiError("proposal_not_pending", NOT_PENDING_MESSAGE, 409);
    case "kind_changed":
      return new ApiError("kind_changed", "A document cannot become a workbook.", 409);
    case "section_changed":
      return new ApiError("section_changed", SECTION_CHANGED_MESSAGE, 409);
    case "not_editable":
      return new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
  }
}

export const handlePostDocProposal = route(async (request) => {
  const tenant = await getTenant(request);
  const { artifactId, sectionId } = request.params;
  const file = findVisibleFile(tenant, artifactId);
  if (file === null) {
    throw new ApiError("not_found", ARTIFACT_NOT_FOUND, 404);
  }
  const ask = parseAsk(request.body);
  const versions = docVersionStore();
  const first = versions.ensureFirstVersion(tenant, artifactId);
  if (!first.ok) {
    throw first.reason === "quota"
      ? new ApiError(STORAGE_BLOCK, STORAGE_BLOCK_MESSAGE, 403)
      : first.reason === "not_found"
        ? new ApiError("not_found", ARTIFACT_NOT_FOUND, 404)
        : new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
  }
  const head = versions.getVersion(tenant, artifactId, first.head.version);
  if (head === null || head.spec.kind !== "document") {
    throw new ApiError("not_editable", NOT_EDITABLE_MESSAGE, 409);
  }
  const doc = head.spec.spec;
  const section = doc.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) {
    throw new ApiError("section_not_found", "No section with that id in this document.", 404);
  }
  const agent = await agentForProposal(tenant, file.project_id, ask.agentId);
  if (agent === null) {
    throw new ApiError("agent_not_in_workspace", AGENT_NOT_IN_WORKSPACE_MESSAGE, 403);
  }
  if (ask.baseVersion > head.version) {
    throw new ApiError("bad_base", "baseVersion is not a version of this document.", 400);
  }
  const changedAt = versions.sectionAuthors(tenant, artifactId)?.[sectionId]?.version ?? 0;
  if (changedAt > ask.baseVersion) {
    return sectionChanged([sectionId]);
  }
  requireGatewayAllowedFor(tenant);
  const written = await withRunSlot(tenant, () =>
    writeSectionProposal({
      tenant,
      doc,
      section,
      instruction: ask.instruction,
      agent,
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    }),
  );
  if (!written.ok) {
    throw new ApiError("invalid_section", INVALID_SECTION_MESSAGE, 502);
  }
  const created = proposalStore().createProposal(tenant, artifactId, {
    sectionId,
    section: written.section,
    baseVersion: ask.baseVersion,
    agentId: agent.id,
  });
  if (!created.ok) {
    throw refusalError(created.reason);
  }
  return jsonOk({ proposal: created.proposal }, 201);
});

export const handlePostDocProposalKeep = route(async (request) => {
  const tenant = await getTenant(request);
  const kept = proposalStore().keep(tenant, request.params.proposalId);
  if (!kept.ok) {
    if (kept.reason === "section_changed") {
      return sectionChanged(kept.sectionIds ?? []);
    }
    throw refusalError(kept.reason);
  }
  const refreshed = await refreshHeadBody(tenant, kept.proposal.artifactId);
  return jsonOk({ proposal: kept.proposal, headVersion: kept.proposal.keptVersion, bodyRefreshed: refreshed.ok });
});

export const handlePostDocProposalDiscard = route(async (request) => {
  const tenant = await getTenant(request);
  const discarded = proposalStore().discard(tenant, request.params.proposalId);
  if (!discarded.ok) {
    throw refusalError(discarded.reason);
  }
  return jsonOk({ proposal: discarded.proposal });
});
