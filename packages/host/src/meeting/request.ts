/**
 * Meeting mode — what the owner asked for.
 *
 * The minutes and run streams take an optional `prompt` ("minutes and who does what"). It steers what
 * the minutes emphasise and never reaches a judge. It goes straight into the model's prompt, so it is
 * length-checked and passes the same injection guard as pasted source material, before the stream starts:
 * a refusal is a plain 400, not a frame inside a 200 stream.
 */

import { ApiError, type TenantContext } from "@agentforge/core";
import { MEETING_REQUEST_MAX_CHARS, requestTooLongMessage } from "@agentforge/core/meeting";
import { assertSafeSourceText } from "../job-source";
import { localeForRun } from "../run-context";
import { loadSettings } from "../settings-store";

/** The trimmed `prompt` from a request body, or undefined when there is none (empty counts as none). */
export function readMeetingRequest(body: unknown, tenant: TenantContext): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const raw = (body as { prompt?: unknown }).prompt;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ApiError("invalid_request", "prompt must be a string", 400);
  }
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > MEETING_REQUEST_MAX_CHARS) {
    throw new ApiError("invalid_request", requestTooLongMessage(MEETING_REQUEST_MAX_CHARS, localeForRun()), 400);
  }
  assertSafeSourceText(text, { injectionGuardBypass: loadSettings(tenant).injectionGuardBypass === true });
  return text;
}
