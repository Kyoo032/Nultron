import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { rangedFileResult } from "../file-bytes";
import { listVideoExamples, videoExamplePath } from "../video-examples";

/** Bundled example clips for the Videos studio. Works without a gateway key and without a workspace. */
export async function handleGetVideoExamples(_request: HostRequest): Promise<HostResult> {
  try {
    return jsonOk({ examples: listVideoExamples() });
  } catch (error) {
    return jsonError(error);
  }
}

/** Bundled clips honour `Range`, so the Videos studio can seek without reading the whole clip each time. */
export async function handleGetVideoExampleFile(request: HostRequest): Promise<HostResult> {
  try {
    const file = videoExamplePath(request.params.name ?? "");
    if (!file) {
      return jsonOk({ error: { code: "not_found", message: "Example clip not found" } }, 404);
    }
    return await rangedFileResult(file, request.headers.range, undefined);
  } catch (error) {
    return jsonError(error);
  }
}
