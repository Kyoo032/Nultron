/**
 * Which gateway models a given key can actually use, as data.
 *
 * Two different questions were being answered by one list. `GET /v1/models` says what the key is
 * *allowed to name*; it does not say a call will work. Measured on 2026-11-11 with a prepaid agent
 * key, the list carried `grok-imagine-video`, `kling-v3` and `veo_3_1-fast`, and every one of them
 * was refused when called (a prepaid account cannot run per-token async jobs, a supply pool had no
 * channel, an upstream rejected the body). The picker offered all three.
 *
 * So the catalog and the availability are kept apart:
 *
 * - The **catalog** (`gateway-catalog.ts`) is every model the gateway offers, with its kind and wire.
 *   It is filled from the key's model list, the gateway's public price list and a built-in seed, and
 *   it is kept even for a model this key cannot use, so a wider key finds the extra models by itself.
 * - The **availability** (this file) is a per-key record of what a real call was told. Records hold a
 *   status, a reason and a time. They are learned from refusals and successes of calls the person
 *   asked for; a paid call is never started to find out.
 *
 * No Node imports: the Settings card in the renderer loads this module for its types and copy keys.
 */

import { ApiError } from "../errors";

export const MODEL_STATUSES = [
  "available",
  "not_on_key",
  "no_channel",
  "account_blocked",
  "upstream_rejected",
  "unknown",
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** A model is offered in a picker when a call worked, or when nothing has said it will not. */
export function isOfferedStatus(status: ModelStatus): boolean {
  return status === "available" || status === "unknown";
}

/** What a refusal teaches. `available` is learned from a success and clears an earlier refusal. */
export type LearnedStatus = Exclude<ModelStatus, "unknown">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How long each lesson holds before the model is offered again.
 *
 * - `account_blocked` and `not_on_key` are facts about the account, so they stay a day.
 * - `no_channel` is a supply pool that was empty at that moment; an hour.
 * - `upstream_rejected` is one upstream refusing one body, the most likely to pass; a quarter hour.
 * - `available` is only a memory that a call worked; a day, then the model is simply `unknown` again.
 */
export const STATUS_TTL_MS: Readonly<Record<LearnedStatus, number>> = Object.freeze({
  available: 24 * HOUR,
  not_on_key: 24 * HOUR,
  account_blocked: 24 * HOUR,
  no_channel: HOUR,
  upstream_rejected: 15 * MINUTE,
});

/** One model's learned outcome on one key. The key itself is never part of it. */
export type AvailabilityRecord = {
  status: LearnedStatus;
  /** A short machine-readable cause (the gateway's own error code when it gave one). Never a body. */
  reason: string;
  /** ISO time the outcome was seen. */
  checkedAt: string;
};

export function recordIsLive(record: AvailabilityRecord, nowMs: number): boolean {
  const seen = Date.parse(record.checkedAt);
  if (!Number.isFinite(seen)) {
    return false;
  }
  return nowMs - seen < STATUS_TTL_MS[record.status];
}

/** The status a record still stands for: its own while it is live, `unknown` once it has expired. */
export function effectiveRecordStatus(record: AvailabilityRecord | undefined, nowMs: number): ModelStatus {
  if (!record || !recordIsLive(record, nowMs)) {
    return "unknown";
  }
  return record.status;
}

// ---------------------------------------------------------------------------------- classifier

/** What a gateway call was told, as the wire functions saw it. */
export type GatewayRefusal = {
  /** The HTTP status of the call that was refused (the poll's, for a job the gateway accepted first). */
  status: number;
  /** The gateway's own code (`model_not_found`, `prepaid_async_requires_fixed_price`, ...), when it sent one. */
  code?: string;
  /** The gateway's own words, before any copy of ours was added. */
  message: string;
};

/**
 * An `ApiError` that kept what the gateway said. The message is the sentence for the person; the
 * `refusal` is what the classifier reads. It rides on the error so the status and code survive the
 * tools' `catch` blocks, which only ever kept the message.
 */
export class GatewayRefusalError extends ApiError {
  readonly refusal: GatewayRefusal;

  constructor(code: string, message: string, httpStatus: number, refusal: GatewayRefusal) {
    super(code, message, httpStatus);
    this.name = "GatewayRefusalError";
    this.refusal = refusal;
  }
}

/** A prepaid proxy account cannot submit a job that is billed by tokens after it finishes. */
const PREPAID_ASYNC = /prepaid_async_requires_fixed_price|按次价格|预付账户|prepaid/i;
/** A supply pool with no live channel for the model. */
const NO_CHANNEL =
  /no available (?:configurable )?(?:resource )?channel|无可用渠道|get_channel_failed|supply pool unavailable/i;
/** The model is not enabled for this token. */
const NOT_ON_KEY =
  /model_not_found|not available (?:for|on|to) this (?:key|token)|not enabled for this (?:key|token)|no access to (?:this )?model|无权使用模型|该令牌无权/i;
/** The gateway accepted the call and its upstream provider then refused it. */
const UPSTREAM_REJECTED =
  /bad_response_status_code|service_unavailable|上游拒绝|upstream (?:rejected|refused|unavailable)/i;

/**
 * Turn one refusal into a lesson, or `null` when it teaches nothing about the *model*.
 *
 * Only the four refusals measured on 2026-11-11 are read. Everything else (a bad key, a rate limit,
 * a timeout, a content refusal, a malformed body of ours) says nothing about whether the model is
 * usable on this key, and learning it would hide a model that works.
 *
 * Order matters. NewAPI answers "no channel for this model" with status 503 *and* the code
 * `model_not_found`, so the code alone cannot separate "this key may not use the model" from "the
 * pool is empty right now"; the status and the words do.
 */
export function classifyGatewayRefusal(
  refusal: GatewayRefusal,
): { status: Exclude<LearnedStatus, "available">; reason: string } | null {
  const text = `${refusal.code ?? ""} ${refusal.message}`;
  const code = (refusal.code ?? "").trim() || shortReason(refusal.message);
  if (PREPAID_ASYNC.test(text)) {
    return { status: "account_blocked", reason: code };
  }
  if (NO_CHANNEL.test(text) || (refusal.status === 503 && /model_not_found/i.test(text))) {
    return { status: "no_channel", reason: code };
  }
  if (NOT_ON_KEY.test(text) && refusal.status !== 503) {
    return { status: "not_on_key", reason: code };
  }
  if (UPSTREAM_REJECTED.test(text)) {
    return { status: "upstream_rejected", reason: code };
  }
  return null;
}

/** Up to 80 characters of the gateway's words, for a reason when it sent no code. Never a body. */
function shortReason(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The refusal an error carries, or one rebuilt from its status and message (an `ApiError` thrown elsewhere). */
export function refusalOfError(error: unknown): GatewayRefusal | null {
  if (error instanceof GatewayRefusalError) {
    return error.refusal;
  }
  if (error instanceof ApiError) {
    return { status: error.status, message: error.message };
  }
  return null;
}

// -------------------------------------------------------------------------------------- store

/**
 * What a desk remembers: one salt, and for each key (by its salted id, never the key) the outcomes
 * learned for it. A desk that has held several keys keeps a few, so switching back is not a cold
 * start, and no key's refusals are read for another.
 */
export type AvailabilityStore = {
  /** Random per install. The key id is an HMAC under it, so an id cannot be matched across installs. */
  salt: string;
  keys: Record<string, KeyAvailability>;
};

export type KeyAvailability = {
  /** When this key last wrote anything, for dropping the oldest when too many are held. */
  touchedAt: string;
  models: Record<string, AvailabilityRecord>;
};

export const MAX_KEYS_HELD = 4;
export const MAX_MODELS_PER_KEY = 400;

export function emptyStore(salt: string): AvailabilityStore {
  return { salt, keys: {} };
}

/** Normalise an id so `Seedance-2.0` and `seedance-2.0` are one model. */
export function modelKey(id: string): string {
  return id.trim().toLowerCase();
}

export function recordsFor(
  store: AvailabilityStore | undefined,
  keyId: string | null,
): Record<string, AvailabilityRecord> {
  if (!store || !keyId) {
    return {};
  }
  return store.keys[keyId]?.models ?? {};
}

/** A copy of the store with one outcome written under one key. Pure. */
export function withOutcome(
  store: AvailabilityStore,
  keyId: string,
  model: string,
  outcome: { status: LearnedStatus; reason: string },
  nowMs: number,
): AvailabilityStore {
  const now = new Date(nowMs).toISOString();
  const held = store.keys[keyId] ?? { touchedAt: now, models: {} };
  const models = { ...held.models, [modelKey(model)]: { ...outcome, checkedAt: now } };
  // Drop the dead before counting, then the oldest if one key somehow learned a lot.
  const live = Object.entries(models).filter(([, record]) => recordIsLive(record, nowMs));
  const kept =
    live.length > MAX_MODELS_PER_KEY
      ? live.sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt)).slice(0, MAX_MODELS_PER_KEY)
      : live;
  const keys = { ...store.keys, [keyId]: { touchedAt: now, models: Object.fromEntries(kept) } };
  const ids = Object.keys(keys);
  if (ids.length > MAX_KEYS_HELD) {
    ids.sort((a, b) => Date.parse(keys[b].touchedAt) - Date.parse(keys[a].touchedAt));
    for (const drop of ids.slice(MAX_KEYS_HELD)) {
      delete keys[drop];
    }
  }
  return { salt: store.salt, keys };
}

/** A copy of the store with everything learned for one key forgotten (the Refresh button). */
export function withoutLessons(store: AvailabilityStore, keyId: string | null): AvailabilityStore {
  if (!keyId || !store.keys[keyId]) {
    return store;
  }
  const keys = { ...store.keys };
  delete keys[keyId];
  return { salt: store.salt, keys };
}

/** Read a stored value back as a store, dropping anything of the wrong shape. Never throws. */
export function parseAvailabilityStore(value: unknown): AvailabilityStore | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const raw = value as { salt?: unknown; keys?: unknown };
  if (typeof raw.salt !== "string" || raw.salt.length < 8 || typeof raw.keys !== "object" || raw.keys === null) {
    return undefined;
  }
  const keys: Record<string, KeyAvailability> = {};
  for (const [keyId, held] of Object.entries(raw.keys as Record<string, unknown>)) {
    if (typeof held !== "object" || held === null) {
      continue;
    }
    const { touchedAt, models } = held as { touchedAt?: unknown; models?: unknown };
    if (typeof touchedAt !== "string" || typeof models !== "object" || models === null) {
      continue;
    }
    const clean: Record<string, AvailabilityRecord> = {};
    for (const [id, record] of Object.entries(models as Record<string, unknown>)) {
      const entry = record as Partial<AvailabilityRecord> | null;
      if (
        entry &&
        typeof entry.status === "string" &&
        (entry.status as string) in STATUS_TTL_MS &&
        typeof entry.checkedAt === "string"
      ) {
        clean[id] = {
          status: entry.status as LearnedStatus,
          reason: typeof entry.reason === "string" ? entry.reason.slice(0, 120) : "",
          checkedAt: entry.checkedAt,
        };
      }
    }
    keys[keyId] = { touchedAt, models: clean };
  }
  return { salt: raw.salt, keys };
}
