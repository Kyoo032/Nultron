import { z } from "zod";

/**
 * The F2 audit event vocabulary (spec R2.2). Every name is metadata: what happened, who did it,
 * how it ended — never what was said. Later features add their names here; the `.strict()` input
 * schema below is the S2 guard, so a payload that smuggles content in an unknown field (a `prompt`,
 * `args` or `output` key) fails to parse and nothing is ever written.
 */
export const AUDIT_EVENTS = [
  "auth.sign_in",
  "auth.sign_out",
  "role.change",
  "delegation.change",
  "api_key.create",
  "api_key.revoke",
  "data_source.add",
  "data_source.change",
  "data_source.access",
  "tool.call",
  "approval.decision",
  "guardrail.decision",
  "limit.hit",
  "channel.trigger",
  "settings.change",
  "audit.read",
  "audit.export",
  "audit.purge",
] as const;
export type AuditEventName = (typeof AUDIT_EVENTS)[number];

export const AUDIT_ACTOR_KINDS = ["user", "api_key", "system", "operator"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_OUTCOMES = ["ok", "denied", "failed"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * One event as an emitter hands it to the sink. `.strict()` is the whole point: a field nobody
 * named — the place a prompt, a tool argument or a file body would hide — rejects the event.
 * `at` is optional so a test can stamp one; the store stamps `Date.now()` otherwise.
 */
export const auditEventInput = z
  .object({
    tenantId: z.string().min(1),
    event: z.enum(AUDIT_EVENTS),
    actorKind: z.enum(AUDIT_ACTOR_KINDS),
    actorId: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    targetKind: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    outcome: z.enum(AUDIT_OUTCOMES).nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    itemCount: z.number().int().nonnegative().nullable().optional(),
    /** Hashes only — e.g. a settings change's `sha256(before)/sha256(after)`. Never a value. */
    refHash: z.string().nullable().optional(),
    channel: z.string().nullable().optional(),
    /** A guardrail decision's rule id, never the text it matched on. */
    rule: z.string().nullable().optional(),
    at: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AuditEventInput = z.infer<typeof auditEventInput>;
