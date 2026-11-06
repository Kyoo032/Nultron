import { checkDraftAgainstSource } from "@agentforge/core";
import { jsonError, jsonOk } from "../errors";
import { parseDocumentDraftBody } from "../document-outline";
import { assembleDeskSource } from "../desk-sources";
import { assertRequestWithin } from "../request-limits";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

/** Overlap check. No model call and no gateway gate. */
export async function handlePostDocumentsCheck(request: HostRequest): Promise<HostResult> {
  try {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as { draft?: unknown; sourceText?: unknown; sourceFiles?: unknown })
        : {};
    assertRequestWithin(body.draft, "Document draft");
    const draft = parseDocumentDraftBody(body.draft);
    const tenant = await getTenant(request);
    // No model reads this text, so the injection guard has nothing to protect here.
    const source = await assembleDeskSource(
      tenant,
      { sourceText: typeof body.sourceText === "string" ? body.sourceText : undefined, sourceFiles: body.sourceFiles },
      { injectionGuardBypass: true },
    );
    return jsonOk(checkDraftAgainstSource(draft, source.text));
  } catch (error) {
    return jsonError(error);
  }
}
