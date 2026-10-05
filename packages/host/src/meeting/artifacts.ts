/**
 * Meeting mode — the artifacts a meeting owns, and their removal.
 *
 * The transcript and each set of minutes are `meeting` artifacts (`run.ts` `persist`), rows in the
 * kernel `artifacts` table rather than files in the meeting folder. Deleting the folder alone left
 * them in `GET /api/v1/artifacts` and left the minutes' Knowledge card feeding Chat, though the
 * delete panel says the transcript and minutes go with the meeting.
 *
 * Two ways to find them, and both are used. The record names the ids it last saved, which is the
 * only handle an artifact written before `meetingId` was stamped on its meta has. The stamp finds
 * the rest: transcripts and minutes from earlier runs that a re-run replaced on the record.
 */

import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";
import { artifactIdsOwnedBy, sweepOrphanSources } from "../knowledge";
import { log } from "../log";
import type { MeetingRecord } from "./records";

/** Every artifact id this meeting owns on this desk: the ids on the record plus the stamped ones. */
export function meetingArtifactIds(tenant: TenantContext, record: MeetingRecord): string[] {
  const recorded = [record.transcriptArtifactId, record.minutes?.artifactId, record.translation?.artifactId];
  const ids = new Set<string>(recorded.filter((id): id is string => typeof id === "string" && id !== ""));
  for (const id of artifactIdsOwnedBy(tenant, "meetingId", record.id)) {
    ids.add(id);
  }
  return [...ids];
}

/**
 * Delete the meeting's artifacts in one transaction, scoped to the desk and to `mode = 'meeting'`
 * so a stale or edited record can never name another mode's row. A failure rolls everything back
 * and propagates: the caller leaves the folder alone and the delete can be tried again.
 */
export function removeMeetingArtifacts(tenant: TenantContext, record: MeetingRecord): number {
  const run = sql.transaction(() => {
    const statement = sql.prepare("DELETE FROM artifacts WHERE workspace_id = ? AND mode = 'meeting' AND id = ?");
    let removed = 0;
    for (const id of meetingArtifactIds(tenant, record)) {
      removed += statement.run(tenant.workspaceId, id).changes;
    }
    return removed;
  });
  const removed = run.immediate();
  dropOrphanCards(tenant);
  return removed;
}

/**
 * The artifacts are already gone, so a card that cannot be dropped now only warns; the next read of
 * the Knowledge Base sweeps it (`GET /api/v1/knowledge`).
 */
function dropOrphanCards(tenant: TenantContext): void {
  try {
    sweepOrphanSources(tenant);
  } catch (error) {
    log.warn("meeting_knowledge_card_not_dropped", {
      detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
  }
}
