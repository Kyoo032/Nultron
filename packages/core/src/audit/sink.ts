import { auditEventInput, type AuditEventInput } from "./events";

/**
 * The F2 event sink. Core code emits through `reportAuditEvent` without knowing where the rows go;
 * the host installs the writer (`packages/host/src/audit/install.ts`, imported by `router.ts` for
 * the same seam reason as `./tenant-state-db`). With no writer installed — the desktop, webdev,
 * unit tests — reporting is a no-op, exactly like `reportToolIo` with no sink.
 */
export type AuditWriter = (event: AuditEventInput) => void;

let writer: AuditWriter | null = null;

/** Host-side install point. `null` restores the no-op (tests). */
export function installAuditWriter(next: AuditWriter | null): void {
  writer = next;
}

/**
 * Emit one event. The `.strict()` schema runs even with no writer, so a malformed event fails the
 * same way everywhere. An event the schema rejects is dropped — never written anywhere — and said
 * so once per process on stderr, because a dropped audit row is itself worth a log line (it holds
 * no content, only the rejected keys).
 */
let rejectedLogged = false;
export function reportAuditEvent(input: unknown): void {
  const parsed = auditEventInput.safeParse(input);
  if (!parsed.success) {
    if (!rejectedLogged) {
      rejectedLogged = true;
      console.warn(
        `audit_event_rejected: an event was dropped because it did not match the metadata-only schema (${parsed.error.issues
          .map((issue) => issue.path.join("."))
          .join(",")})`,
      );
    }
    return;
  }
  writer?.(parsed.data);
}
