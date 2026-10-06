/**
 * What Chat remembers about the person's tier (Daily, Fastest or Reasoning), and what the pane reads off one.
 *
 * Tester code, chat-first plan track M1. The person chooses a tier and the host turns it into a model, so
 * nothing here names a model. Three jobs:
 * - memory: the last choice and one per thread, in the browser's storage (`chat-model-pref.ts` did the
 *   same for model ids, and this follows its shape);
 * - reading the catalog the host sends (`tiers` and `defaultTier` on `GET /api/v1/chat` and
 *   `GET /api/v1/models`);
 * - two facts the pane derives from a tier: whether the reply's Thinking row shows, and how long the
 *   stream may stay quiet.
 */
import { DEFAULT_MODEL_TIER, MODEL_TIERS, isModelTierId, type ModelTierId } from "@agentforge/core/tiers";
import { STREAM_REASONING_IDLE_MS, STREAM_REASONING_TTFB_MS } from "@agentforge/core/stream-watchdog";

/** The last choice, written whenever the person picks a tier. */
export const CHAT_TIER_LAST_KEY = "agentforge-chat-tier";
/** One choice per thread: `{ [threadId]: tier }`. */
export const CHAT_TIER_THREAD_KEY = "agentforge-chat-thread-tiers";
/** Threads remembered. The oldest write is forgotten first. */
export const CHAT_TIER_THREAD_MAX = 80;

type MemoryStore = Pick<Storage, "getItem" | "setItem">;
type Modality = "text" | "image" | "video";

/** One tier as the host reports it. No model id, no provider: the host never sends them. */
export type ChatTierInfo = Readonly<{
  id: ModelTierId;
  /** Whether any model that can answer this tier is live right now. */
  available: boolean;
  /** What the model that would answer accepts. Always includes text. */
  inputModalities: readonly Modality[];
  /** The context window of that model, or null when the host does not say. */
  contextLength: number | null;
}>;

export type ChatTierCatalog = Readonly<{
  tiers: readonly ChatTierInfo[];
  defaultTier: ModelTierId;
}>;

function browserStore(): MemoryStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readRaw(storage: MemoryStore | undefined, key: string): string | null {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: MemoryStore | undefined, key: string, value: string): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    // private mode
  }
}

/**
 * The stored threads, oldest first, with every entry that is not a tier id left out. Never throws.
 * They are entries rather than an object so that a thread called `__proto__` is an ordinary key: an
 * assignment to that name on a plain object is silently ignored.
 */
function readThreadEntries(storage: MemoryStore | undefined): Array<readonly [string, ModelTierId]> {
  const raw = readRaw(storage, CHAT_TIER_THREAD_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return Object.entries(parsed).flatMap(([key, value]) => (isModelTierId(value) ? [[key, value] as const] : []));
  } catch {
    return [];
  }
}

/** The tier the person last chose, or "" when there is none or the stored value is not a tier id. */
export function readLastChatTier(storage: MemoryStore | undefined = browserStore()): ModelTierId | "" {
  const value = readRaw(storage, CHAT_TIER_LAST_KEY)?.trim();
  return isModelTierId(value) ? value : "";
}

export function writeLastChatTier(tier: ModelTierId, storage: MemoryStore | undefined = browserStore()): void {
  if (!isModelTierId(tier)) {
    return;
  }
  writeRaw(storage, CHAT_TIER_LAST_KEY, tier);
}

export function readThreadChatTier(
  threadId: string,
  storage: MemoryStore | undefined = browserStore(),
): ModelTierId | "" {
  const id = threadId.trim();
  if (!id) {
    return "";
  }
  return readThreadEntries(storage).find(([key]) => key === id)?.[1] ?? "";
}

/**
 * Remember a thread's tier. A write is the newest use of that thread, so it moves to the end of the map,
 * and once the map is over `CHAT_TIER_THREAD_MAX` the oldest ones are dropped.
 */
export function writeThreadChatTier(
  threadId: string,
  tier: ModelTierId,
  storage: MemoryStore | undefined = browserStore(),
): void {
  const id = threadId.trim();
  if (!id || !isModelTierId(tier)) {
    return;
  }
  const others = readThreadEntries(storage).filter(([key]) => key !== id);
  const entries = [...others, [id, tier] as const];
  const kept = entries.slice(Math.max(0, entries.length - CHAT_TIER_THREAD_MAX));
  writeRaw(storage, CHAT_TIER_THREAD_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/**
 * The tier to show before the catalog has arrived: the open thread's own, else the last the person
 * chose, else Daily. Availability is not known yet; `pickChatTier` checks it once the catalog is in. The
 * pane starts from this rather than from Daily because `pickChatTier` ranks the tier on screen above the
 * last choice, so a pane that began on Daily would never read the last choice at all.
 */
export function initialChatTier(threadId?: string, storage: MemoryStore | undefined = browserStore()): ModelTierId {
  const thread = threadId ? readThreadChatTier(threadId, storage) : "";
  return thread || readLastChatTier(storage) || DEFAULT_MODEL_TIER;
}

/**
 * Which tier the picker starts on: the thread's own, then the one on screen, then the last the person
 * chose, then the host's default. Each has to be a tier id the host reports as available; a stored value
 * that is not (a retired name, a hand-edited string) is skipped. With nothing usable it answers the
 * default, so a send names a tier and the host can say why it cannot answer, instead of the pane
 * guessing a different tier than the one the person was shown.
 */
export function pickChatTier(input: {
  tiers: readonly { id: string; available: boolean }[];
  current?: string;
  threadTier?: string;
  lastTier?: string;
  defaultTier?: string;
}): ModelTierId {
  const fallback = isModelTierId(input.defaultTier) ? input.defaultTier : DEFAULT_MODEL_TIER;
  const live = new Set(input.tiers.filter((tier) => tier.available).map((tier) => tier.id));
  for (const candidate of [input.threadTier, input.current, input.lastTier, fallback]) {
    if (isModelTierId(candidate) && live.has(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

function readModalities(value: unknown): Modality[] {
  const given = Array.isArray(value) ? value : [];
  return (["text", "image", "video"] as const).filter((modality) => modality === "text" || given.includes(modality));
}

function readContextLength(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The tiers and the default out of a catalog payload (`GET /api/v1/chat`, `GET /api/v1/models`). Anything
 * the wire does not promise is read as the safe value: an unknown id is dropped, a repeated one keeps its
 * first entry, a missing `available` means not available, a missing modality list means text only. A
 * payload with no `tiers` yields an empty list, which the picker shows disabled; the send still names
 * the default tier.
 */
export function readTierCatalog(payload: unknown): ChatTierCatalog {
  const source = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const defaultTier = isModelTierId(source.defaultTier) ? source.defaultTier : DEFAULT_MODEL_TIER;
  const listed = Array.isArray(source.tiers) ? source.tiers : [];
  const byId = new Map<ModelTierId, ChatTierInfo>();
  for (const entry of listed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (!isModelTierId(item.id) || byId.has(item.id)) {
      continue;
    }
    byId.set(item.id, {
      id: item.id,
      available: item.available === true,
      inputModalities: readModalities(item.inputModalities),
      contextLength: readContextLength(item.contextLength),
    });
  }
  const tiers = MODEL_TIERS.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
  return { tiers, defaultTier };
}

/**
 * Does the reply show its Thinking row? Fastest runs with Thinking off, so it does not; Daily and
 * Reasoning do, because both can think (model tiers spec, section 1).
 */
export function tierThinkingEnabled(tier: ModelTierId): boolean {
  return tier !== "fast";
}

/**
 * How long the client lets the stream stay quiet, as an override for `armStreamWatchdog`. The watchdog
 * used to read the model's id to pick its budget, but the renderer never learns the id now. So Daily and
 * Reasoning get the long budget a model that thinks quietly needs, because the model behind a Daily
 * run can be one (the walk falls through a list that includes such models), and an early abort would
 * cut a working run. Fastest keeps the short default. An override can only lengthen a limit.
 */
export function tierStreamLimits(tier: ModelTierId): { ttfbMs: number; idleMs: number } | undefined {
  return tier === "fast" ? undefined : { ttfbMs: STREAM_REASONING_TTFB_MS, idleMs: STREAM_REASONING_IDLE_MS };
}
