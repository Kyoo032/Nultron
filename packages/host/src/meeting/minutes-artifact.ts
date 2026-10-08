/**
 * Meeting mode — saving a transcript or a set of minutes as an artifact, and filing the minutes as a
 * Knowledge card. Shared by the run (`./run.ts`) and the owner's edits (`./edit.ts`).
 *
 * Saving never fails the run: the transcript or the minutes are still returned to the caller, the same
 * precedent as `persistDraft` in `document-generate.ts`.
 */

import { ApiError, type TenantContext } from "@agentforge/core";
import { meetingMinutesToMarkdown } from "@agentforge/core/meeting";
import { artifactStore } from "../artifacts";
import { upsertWorkSource } from "../knowledge-ingest";
import { log } from "../log";
import { artifactWorkCard } from "../work-cards";
import type { MeetingMinutesRecord } from "./records";
import type { MeetingRecord } from "./store";

/** Saving an artifact never fails the run; the minutes are still returned to the caller. */
export function persistMeetingArtifact(
  tenant: TenantContext,
  input: { kind: "transcript" | "minutes"; title: string; body: string; meta: Record<string, unknown> },
): string {
  try {
    return artifactStore().create(tenant, {
      mode: "meeting",
      kind: input.kind,
      title: input.title,
      mime: "text/markdown",
      body: input.body,
      meta: input.meta,
    }).id;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("meeting_artifact_not_saved", { code, kind: input.kind });
    return "";
  }
}

async function fileWorkCard(
  tenant: TenantContext,
  input: { artifactId: string; title: string; markdown: string; model: string },
): Promise<void> {
  if (!input.artifactId) {
    return;
  }
  try {
    await upsertWorkSource(
      tenant,
      artifactWorkCard({
        type: "Meeting",
        artifactId: input.artifactId,
        title: input.title,
        markdown: input.markdown,
        model: input.model,
      }),
    );
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "internal_error";
    log.warn("meeting_work_card_not_filed", { code });
  }
}

/** The minutes as an artifact and a Knowledge card; the returned record names the artifact. */
export async function saveMinutesArtifact(
  tenant: TenantContext,
  meeting: MeetingRecord,
  record: MeetingMinutesRecord,
  suffix: string,
): Promise<MeetingMinutesRecord> {
  const markdown = meetingMinutesToMarkdown(record.minutes);
  const title = `${meeting.title} — ${suffix}`;
  const artifactId = persistMeetingArtifact(tenant, {
    kind: "minutes",
    title,
    body: markdown,
    meta: {
      model: record.model,
      locale: record.locale,
      unverifiedNames: record.unverifiedNames,
      meetingId: meeting.id,
      // Ids and pass/fail only: the meta is not encrypted, so no minutes text goes into it.
      ...(record.checks ? { checks: record.checks } : {}),
    },
  });
  await fileWorkCard(tenant, { artifactId, title, markdown, model: record.model });
  return { ...record, artifactId };
}
