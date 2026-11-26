import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, auditEventInput } from "./events";
import { installAuditWriter, reportAuditEvent } from "./sink";

const VALID = {
  tenantId: "t1",
  event: "tool.call" as const,
  actorKind: "user" as const,
  actorId: "u1",
  targetKind: "tool",
  targetId: "web_search",
  outcome: "ok" as const,
  durationMs: 12,
};

describe("auditEventInput", () => {
  it("accepts a metadata-only event and every name in the spec's catalog", () => {
    for (const event of AUDIT_EVENTS) {
      expect(auditEventInput.safeParse({ ...VALID, event }).success).toBe(true);
    }
    expect(auditEventInput.safeParse(VALID).success).toBe(true);
  });

  it("refuses an unknown event name, a bad outcome and a non-strict field", () => {
    expect(auditEventInput.safeParse({ ...VALID, event: "user.message" }).success).toBe(false);
    expect(auditEventInput.safeParse({ ...VALID, outcome: "maybe" }).success).toBe(false);
    expect(auditEventInput.safeParse({ ...VALID, actorKind: "intruder" }).success).toBe(false);
    // The strict schema is the metadata-only guard: a content field can never ride along (S2).
    expect(auditEventInput.safeParse({ ...VALID, content: "hi" }).success).toBe(false);
    expect(auditEventInput.safeParse({ ...VALID, prompt: "secret text" }).success).toBe(false);
  });

  it("refuses a negative duration or count and a missing tenant", () => {
    expect(auditEventInput.safeParse({ ...VALID, durationMs: -1 }).success).toBe(false);
    expect(auditEventInput.safeParse({ ...VALID, itemCount: -1 }).success).toBe(false);
    expect(auditEventInput.safeParse({ ...VALID, tenantId: "" }).success).toBe(false);
  });
});

describe("reportAuditEvent", () => {
  it("hands a valid event to the installed writer and drops an invalid one with a warning", () => {
    const seen: unknown[] = [];
    installAuditWriter((event) => seen.push(event));
    try {
      reportAuditEvent(VALID);
      reportAuditEvent({ ...VALID, event: "not.an.event" });
      expect(seen).toHaveLength(1);
      expect((seen[0] as { event: string }).event).toBe("tool.call");
    } finally {
      installAuditWriter(null);
    }
  });

  it("is a no-op before the host installs a writer", () => {
    installAuditWriter(null);
    // Nothing may throw where there is no sink: emitters never know whether a desk audits.
    expect(() => reportAuditEvent(VALID)).not.toThrow();
  });
});
