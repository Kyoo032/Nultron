import { ApiError } from "@agentforge/core";
import { z } from "zod";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostHandler, HostRequest, HostResult } from "../types";
import { MEDIA_KINDS } from "./constants";
import { defaultMediaApprovalDeps, type MediaApprovalDeps } from "./deps";
import {
  generateMediaProposal,
  getAlwaysAllow,
  getMediaProposal,
  setAlwaysAllow,
  skipMediaProposal,
} from "./decisions";
import { mediaApprovalOn } from "./gate";

export type MediaApprovalRoute = readonly [method: string, pattern: string, handler: HostHandler];

type DepsSource = () => Promise<MediaApprovalDeps>;

const allowBodySchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  allow: z.boolean(),
});

export function createMediaApprovalRoutes(
  depsOf: DepsSource = defaultMediaApprovalDeps,
): readonly MediaApprovalRoute[] {
  const guarded =
    (run: (request: HostRequest, deps: MediaApprovalDeps) => Promise<HostResult>): HostHandler =>
    async (request) => {
      try {
        if (!mediaApprovalOn()) {
          throw new ApiError("not_found", "Not found", 404);
        }
        return await run(request, await depsOf());
      } catch (error) {
        return jsonError(error);
      }
    };

  const getProposal = guarded(async (request, deps) =>
    jsonOk(getMediaProposal(await getTenant(request), request.params.proposalId, deps)),
  );

  const postGenerate = guarded(async (request, deps) =>
    jsonOk(await generateMediaProposal(await getTenant(request), request.params.proposalId, deps)),
  );

  const postSkip = guarded(async (request, deps) =>
    jsonOk(skipMediaProposal(await getTenant(request), request.params.proposalId, deps)),
  );

  const getAllow = guarded(async (request, deps) => jsonOk(getAlwaysAllow(await getTenant(request), deps)));

  const putAllow = guarded(async (request, deps) => {
    const parsed = allowBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError("invalid_request", "Send kind (image or video) and allow (true or false).", 400);
    }
    return jsonOk(setAlwaysAllow(await getTenant(request), parsed.data.kind, parsed.data.allow, deps));
  });

  return [
    ["GET", "/api/v1/media/proposals/:proposalId", getProposal],
    ["POST", "/api/v1/media/proposals/:proposalId/generate", postGenerate],
    ["POST", "/api/v1/media/proposals/:proposalId/skip", postSkip],
    ["GET", "/api/v1/media/always-allow", getAllow],
    ["PUT", "/api/v1/media/always-allow", putAllow],
  ];
}

export const MEDIA_APPROVAL_ROUTES: readonly MediaApprovalRoute[] = createMediaApprovalRoutes();
