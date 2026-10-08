/**
 * Meeting "drop a file" routes (docs/internal/doc-flow-plan.md section 4 and 7a).
 *
 *  - `POST /meetings/:meetingId/translate/stream`: translate the stored minutes, on request. Gated: 1 call.
 *  - `POST /meetings/:meetingId/transcript/file`: a transcript the owner already has, as a file. Free.
 *  - `PUT  /meetings/:meetingId/minutes/edits`: the owner's change to one decision or action item. Free.
 *    NOT registered yet: `router.ts` is another lane's file. Registration is one line,
 *    `compile("PUT", "/api/v1/meetings/:meetingId/minutes/edits", handlePutMeetingMinutesEdit)`, plus a
 *    by-id row in `tenancy-harness.test.ts`.
 *
 * All are by-id, so each one resolves the tenant, looks the meeting up in that tenant's own store
 * (`requireMeeting`, a 404 that is the same for another tenant's id and for an id nobody ever had), and only
 * then checks the gate on the route that reaches the model. The lookup stays synchronous and stays ahead of
 * `streamJob`, so a foreign id is a real 404 rather than a frame in a 200 stream. The older stream routes in
 * `handlers/meetings.ts` look the meeting up inside the job and need an `indistinguishable` row in
 * `tenancy-harness.test.ts`; these do not.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import { meetingTranscriptSchema, minutesItemEditSchema } from "@agentforge/core/meeting";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { requireGatewayAllowedFor } from "../gateway-gate";
import { readModelPinned } from "../job-regen";
import { streamJob } from "../job-stream";
import { editMeetingMinutes } from "../meeting/edit";
import type { MeetingRecord } from "../meeting/records";
import { saveTranscript, translateStoredMinutes } from "../meeting/run";
import { requireMeeting } from "../meeting/store";
import { readTranscriptFile } from "../meeting/transcript-file";
import { localeForRun } from "../run-context";
import { getTenant } from "../tenant";

/**
 * What a route writes: the tenant, the meeting record the lookup returned, and the request (body,
 * `abortSignal`, `files`). Return `jsonOk(...)`, or `streamJob(...)` for a stream.
 */
export type MeetingHandler = (
  tenant: TenantContext,
  meeting: MeetingRecord,
  request: HostRequest,
) => Promise<HostResult> | HostResult;

type MeetingRouteOptions = {
  /** True when the route reaches the gateway: a closed gate answers 403 `gateway_blocked`. */
  readonly gated: boolean;
};

async function runForMeeting(
  request: HostRequest,
  options: MeetingRouteOptions,
  run: MeetingHandler,
): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const meeting = requireMeeting(tenant, request.params.meetingId ?? "");
    if (options.gated) {
      requireGatewayAllowedFor(tenant);
    }
    return await run(tenant, meeting, request);
  } catch (error) {
    return jsonError(error);
  }
}

function bodyOf(request: HostRequest): Record<string, unknown> {
  const value = request.body;
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "Request body must be a JSON object", 400);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Translate the stored minutes into the other language, as job.* SSE events. Gated: 1 call, and
 * only on a press (plan 7a.2: translation is opt-in). Reads `model` and `modelPinned` like the minutes stream.
 */
export function handlePostMeetingTranslateStream(request: HostRequest): Promise<HostResult> {
  return runForMeeting(request, { gated: true }, (tenant, meeting) => {
    const input = bodyOf(request);
    const model = optionalString(input.model);
    const modelExplicit = readModelPinned(input);
    return streamJob(
      (emit, abortSignal) => translateStoredMinutes(tenant, meeting.id, { emit, abortSignal, model, modelExplicit }),
      { abortSignal: request.abortSignal },
    );
  });
}

/**
 * A transcript the owner already has, as a file under the field "file": .txt, .md, .vtt, .srt,
 * .docx or .pdf, read locally and capped at `TRANSCRIPT_MAX_CHARS`. Free, never gated, exactly
 * like the pasted-text sibling `POST /meetings/:meetingId/transcript`.
 */
export function handlePostMeetingTranscriptFile(request: HostRequest): Promise<HostResult> {
  return runForMeeting(request, { gated: false }, async (tenant, meeting) => {
    const file = request.files?.find((item) => item.field === "file") ?? request.files?.[0];
    const content = await readTranscriptFile(file, localeForRun());
    const transcript = meetingTranscriptSchema.parse({
      text: content.text,
      segments: content.segments,
      language: "",
      source: "pasted",
      model: "",
    });
    return jsonOk(saveTranscript(tenant, meeting.id, transcript));
  });
}

/**
 * The owner's change to one decision or action item of the stored minutes: `{ kind, index, set }`. Free: no
 * model call. The item is marked edited and a later regenerate keeps it.
 */
export function handlePutMeetingMinutesEdit(request: HostRequest): Promise<HostResult> {
  return runForMeeting(request, { gated: false }, async (tenant, meeting) => {
    const parsed = minutesItemEditSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw new ApiError("invalid_request", `${where}${issue?.message ?? "invalid edit"}`, 400);
    }
    return jsonOk(await editMeetingMinutes(tenant, meeting.id, parsed.data));
  });
}
