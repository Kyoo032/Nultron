/**
 * F2 — the one place that hands the core audit sink a database connection.
 *
 * Same seam and same reason as `tenant-state-db.ts` next door: `reportAuditEvent` lives in
 * `@agentforge/core` so emitters (invoke-guarded, auth routes, settings) never import host code,
 * and importing `@agentforge/db` OPENS the SQLite file — so the install happens on the module
 * every request already goes through, and only there.
 */
import { sql } from "@agentforge/db";
import { installAuditWriter, reportAuditEvent } from "@agentforge/core";
import { appendAuditEvent } from "./store";
import { purgeAuditByAge } from "./purge";

installAuditWriter((event) => {
  appendAuditEvent(sql, event);
});

/**
 * The retention job (spec: a purge that writes a checkpoint). Off by default: the window is
 * Rizky's call (section 6), so `AGENTFORGE_AUDIT_RETENTION_DAYS` enables it and names the age.
 * Hourly, unref'd — a process exiting never waits on its audit log.
 */
const retentionDays = Number(process.env.AGENTFORGE_AUDIT_RETENTION_DAYS);
if (Number.isFinite(retentionDays) && retentionDays > 0) {
  const run = () => {
    try {
      const { purged } = purgeAuditByAge(sql, retentionDays);
      if (purged > 0) {
        reportAuditEvent({
          tenantId: "system",
          event: "audit.purge",
          actorKind: "system",
          targetKind: "audit_events",
          outcome: "ok",
          itemCount: purged,
        });
      }
    } catch (error) {
      console.warn(`audit purge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(run, 3_600_000);
  timer.unref?.();
}
