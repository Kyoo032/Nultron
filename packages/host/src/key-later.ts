/**
 * "Add the key later" (Nultron Enterprise, owner decision 2026-10-01): a signed-in tenant who has no
 * gateway key yet may start without one, and the host remembers that they said so.
 *
 * The record is a statement about what the SCREEN should show. It says nothing about what the host
 * allows, and nothing reads it as permission: `deriveGatewayGate` and `requireGatewayAllowed` never
 * look at it, so a person who chose to wait is still refused by every gateway-calling route until a
 * key the gateway accepts is saved. It is kept per person beside the language and the first-run
 * guide's record (`settings-store.ts`), for the same reasons: one envelope, one save, one wipe.
 */
export type KeyLaterRecord = {
  /** Epoch milliseconds the choice was recorded. Always the host's clock, never the caller's. */
  readonly at: number;
};

/** What `GET /api/v1/settings` carries as `keyLater`, hosted only. `chosen` is all the renderer reads. */
export type KeyLaterPayload = {
  readonly chosen: boolean;
  readonly at: number | null;
};

/** Anything unreadable is "not chosen": a welcome shown once too often costs a click, never data. */
export function parseKeyLaterRecord(value: unknown): KeyLaterRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { at } = value as { at?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) {
    return null;
  }
  return { at };
}

export function keyLaterPayload(record: KeyLaterRecord | null): KeyLaterPayload {
  return record ? { chosen: true, at: record.at } : { chosen: false, at: null };
}
