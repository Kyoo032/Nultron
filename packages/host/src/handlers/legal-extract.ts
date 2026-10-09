/**
 * Legal "add files, get answers" routes (docs/internal/doc-flow-plan.md sections 2 and 7a).
 *
 * Every route here is by-id, so each one:
 *
 *   1. resolves the tenant (`getTenant`);
 *   2. looks the matter up in that tenant's own store (`requireLegalMatter`, a 404 that is the same
 *      for another tenant's id and for an id nobody ever had), and only then
 *   3. checks the gateway gate, on the routes that reach the model (`gated: true`);
 *   4. hands the matter to the route's function.
 *
 * The lookup stays synchronous and stays ahead of `streamJob`, so a foreign id is a real 404 rather than a
 * frame in a 200 stream, and the `tenancy-harness.test.ts` rows stay `not_found` instead of needing an
 * `indistinguishable` excuse. The body is parsed after the gate, so a closed gate answers 403 whatever the body.
 *
 * Paid or free (plan 7a.1): `extract/stream` and `ask/stream` are the Run presses and are gated; the reads,
 * the owner's edits and the comments cost nothing and stay open with a closed gate.
 */
import type { TenantContext } from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { streamJob } from "../job-stream";
import { getTenant } from "../tenant";
import { generateLegalAsk, readLegalAsks } from "../legal/ask";
import {
  addLegalExtractComment,
  generateLegalExtract,
  readLegalExtractView,
  saveLegalExtractEdits,
} from "../legal/extract";
import {
  askBodySchema,
  assertSafeSourceTexts,
  commentBodySchema,
  editsBodySchema,
  extractBodySchema,
  parseLegalBody,
} from "../legal/input";
import { type LegalMatterRecord, requireLegalMatter } from "../legal/store";

/**
 * What a route writes: the tenant, the matter record the lookup returned, and the request (body,
 * `abortSignal`, `files`). Return `jsonOk(...)`, or `streamJob(...)` for the `/stream` routes.
 */
export type MatterHandler = (
  tenant: TenantContext,
  matter: LegalMatterRecord,
  request: HostRequest,
) => Promise<HostResult> | HostResult;

type MatterRouteOptions = {
  /** True when the route reaches the gateway: a closed gate answers 403 `gateway_blocked`. */
  readonly gated: boolean;
};

async function runForMatter(
  request: HostRequest,
  options: MatterRouteOptions,
  run: MatterHandler,
): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const matter = requireLegalMatter(tenant, request.params.matterId ?? "");
    if (options.gated) {
      requireGatewayAllowedFor(tenant);
    }
    return await run(tenant, matter, request);
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Read every file, extract the facts, check them, save `extract.json`, as job.* SSE events.
 * Gated: it is the paid press (1 call, plus at most 1 repair, or one per file/part on a long matter).
 * The body may carry `prompt`: what the owner wants looked at harder. It never relaxes a check.
 */
export function handlePostLegalExtractStream(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: true }, (tenant, matter) => {
    const body = parseLegalBody(extractBodySchema, request.body);
    assertSafeSourceTexts([body.prompt ?? ""]);
    return streamJob(
      (emit, abortSignal) => generateLegalExtract(tenant, matter.id, body, request.body, emit, abortSignal),
      { abortSignal: request.abortSignal },
    );
  });
}

/** The latest saved extract, merged with the owner's edits and comments (`{ extract: null }` before the first). Free, never gated. */
export function handleGetLegalExtract(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: false }, (tenant, matter) => jsonOk(readLegalExtractView(tenant, matter)));
}

/** One question answered from the matter's documents, as job.* SSE events. Gated: 1 call, plus at most 1 repair. */
export function handlePostLegalAskStream(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: true }, (tenant, matter) => {
    const body = parseLegalBody(askBodySchema, request.body);
    assertSafeSourceTexts([body.question]);
    return streamJob(
      (emit, abortSignal) => generateLegalAsk(tenant, matter.id, body, request.body, emit, abortSignal),
      { abortSignal: request.abortSignal },
    );
  });
}

/** The saved questions and answers (`asks.json`, capped at 50), newest first. Free, never gated. */
export function handleGetLegalAsks(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: false }, (tenant, matter) => jsonOk(readLegalAsks(tenant, matter)));
}

/**
 * The owner's inline edits to extracted facts and red flags (plan 7a.3, `extract-edits.json`).
 * Free, never gated: an edit must save with a closed gateway, and a re-extract must not overwrite it.
 * Answers the extraction as the owner now sees it.
 */
export function handlePutLegalExtractEdits(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: false }, (tenant, matter) =>
    jsonOk(saveLegalExtractEdits(tenant, matter, parseLegalBody(editsBodySchema, request.body))),
  );
}

/** A comment on one fact or red flag (plan 7a.3). Free, never gated. Answers the extraction as the owner now sees it. */
export function handlePostLegalExtractComments(request: HostRequest): Promise<HostResult> {
  return runForMatter(request, { gated: false }, (tenant, matter) =>
    jsonOk(addLegalExtractComment(tenant, matter, parseLegalBody(commentBodySchema, request.body))),
  );
}
