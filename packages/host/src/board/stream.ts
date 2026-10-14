/**
 * `GET /api/v1/board/events` (team-board-spec.md sections 8.1 and 8.2).
 *
 * The bus only says "something new"; the stream then reads `card_events` after the last id it sent.
 * That one read path serves replay, live delivery and catch-up after a burst, so the stream cannot
 * skip or repeat an id.
 *
 * Everything the generator needs is captured when the stream opens: the adapter drains `events` after
 * `dispatch` has returned, so the router's request scope (and `getTenant()` with it) is gone by then.
 *
 * Access is re-checked against the database before events are sent: once per read batch, again before an
 * event when more than a second has passed since the last check, and at every heartbeat. The check is that
 * the session is still live, the person is still a member of the company, the desk is still theirs. The
 * first failure closes the stream with `event: closed`.
 */
import { db, resolvePortalTenant } from "@agentforge/db";
import { hostSessionStore } from "../auth";
import { verifySession } from "../auth/session";
import type { SessionStore } from "../auth/session-store";
import { boardBus } from "./bus";
import * as store from "./store";
import type { BoardScope } from "./store";
import type { BoardEventRow } from "./types";

/** The person a stream belongs to, captured from the gate's session and the resolved tenant. */
export type StreamViewer = BoardScope & { readonly sessionId: string };

type StreamConfig = {
  readonly heartbeatMs: number;
  /** A stream is closed (and the browser reconnects with Last-Event-ID) after this long. */
  readonly maxLifetimeMs: number;
  readonly perPersonCap: number;
  readonly perProcessCap: number;
  readonly replayLimit: number;
  readonly sessionStore: () => SessionStore;
  readonly now: () => number;
};

const DEFAULTS: StreamConfig = {
  heartbeatMs: 15_000,
  maxLifetimeMs: 15 * 60_000,
  perPersonCap: 5,
  perProcessCap: 500,
  replayLimit: 1_000,
  sessionStore: hostSessionStore,
  now: Date.now,
};

let config: StreamConfig = DEFAULTS;

/** Test seam: shorter timers, an in-memory session store. Returns the function that restores the defaults. */
export function configureBoardStreams(over: Partial<StreamConfig>): () => void {
  config = { ...DEFAULTS, ...over };
  return () => {
    config = DEFAULTS;
  };
}

/** Events the stream sends even when their card is archived: they are how viewers learn of the change. */
const ALWAYS_DELIVERED = new Set(["card.archived", "column.changed"]);

const READ_BATCH = 200;

/** Inside one read batch, access is checked again before an event only when this much time has passed. */
const ACCESS_RECHECK_MS = 1_000;

type OpenStream = { readonly person: string; readonly close: () => void };

const open = new Map<symbol, OpenStream>();

/** Open streams, in total and for one person (`tenantId:userId`). Metrics and tests read these. */
export function openBoardStreams(person?: string): number {
  if (!person) {
    return open.size;
  }
  let count = 0;
  for (const stream of open.values()) {
    if (stream.person === person) {
      count += 1;
    }
  }
  return count;
}

function oldest(person?: string): OpenStream | undefined {
  for (const stream of open.values()) {
    if (!person || stream.person === person) {
      return stream;
    }
  }
  return undefined;
}

/** Register a stream, closing the oldest one when a cap is reached (spec section 8.2). */
function register(person: string, close: () => void): symbol {
  if (openBoardStreams(person) >= config.perPersonCap) {
    oldest(person)?.close();
  }
  if (open.size >= config.perProcessCap) {
    oldest()?.close();
  }
  const key = Symbol(person);
  open.set(key, { person, close });
  return key;
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function stillAllowed(viewer: StreamViewer): Promise<boolean> {
  const session = await config.sessionStore().find(viewer.sessionId);
  const verdict = verifySession(session, config.now());
  if (!verdict.ok || verdict.session.userId !== viewer.userId || verdict.session.orgId !== viewer.organizationId) {
    return false;
  }
  const resolution = await resolvePortalTenant(
    db,
    { tenantId: viewer.tenantId, orgId: viewer.organizationId, userId: viewer.userId },
    viewer.workspaceId,
  );
  return resolution.ok && resolution.tenant.workspaceId === viewer.workspaceId;
}

function deliverable(viewer: StreamViewer, row: BoardEventRow): boolean {
  return ALWAYS_DELIVERED.has(row.type) || row.cardId === null || store.cardIsLive(viewer, row.cardId);
}

/**
 * The stream itself. `after` is the browser's Last-Event-ID; null starts at the newest event. More than
 * `replayLimit` events behind, an id past the desk's newest, or NaN (a header that was not an id) sends
 * `event: reset` and carries on from now; the browser reloads the board.
 */
export async function* boardEventStream(
  viewer: StreamViewer,
  after: number | null,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const state: { closed: "aborted" | "replaced" | null } = { closed: null };
  let pending = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const key = register(`${viewer.tenantId}:${viewer.userId}`, () => {
    state.closed ??= "replaced";
    nudge();
  });
  const unsubscribe = boardBus().subscribe(viewer.tenantId, viewer.workspaceId, () => {
    pending = true;
    nudge();
  });
  const onAbort = () => {
    state.closed ??= "aborted";
    nudge();
  };
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) {
    state.closed = "aborted";
  }
  const deadline = config.now() + config.maxLifetimeMs;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // When access was last checked. The check runs once per read batch, again before an event only when more
  // than `ACCESS_RECHECK_MS` has passed (so it still precedes what is sent), and at every heartbeat.
  let checkedAt = Number.NEGATIVE_INFINITY;
  const allowedNow = async () => {
    checkedAt = config.now();
    return stillAllowed(viewer);
  };

  try {
    const latest = store.latestEventId(viewer);
    let cursor = after ?? latest;
    // An id that is not a number, or one past the desk's newest event, is not a place this desk can resume
    // from: the browser reloads the board instead (security review of K0, L2).
    const unusable = after !== null && (!Number.isSafeInteger(after) || after > latest);
    if (
      unusable ||
      (after !== null && store.countEventsAfter(viewer, after, config.replayLimit + 1) > config.replayLimit)
    ) {
      yield frame("reset", {});
      cursor = store.latestEventId(viewer);
    }
    yield ": open\n\n";

    while (!state.closed) {
      // Checked here, not only after a quiet wait, so a desk busy enough never to wait still closes on time.
      if (config.now() >= deadline) {
        yield frame("closed", { reason: "lifetime" });
        return;
      }
      pending = false;
      const rows = store.eventsAfter(viewer, cursor, READ_BATCH);
      if (rows.length > 0 && !(await allowedNow())) {
        yield frame("closed", { reason: "access" });
        return;
      }
      for (const row of rows) {
        if (state.closed) {
          break;
        }
        if (config.now() - checkedAt > ACCESS_RECHECK_MS && !(await allowedNow())) {
          yield frame("closed", { reason: "access" });
          return;
        }
        if (deliverable(viewer, row)) {
          yield frame(row.type, { cardId: row.cardId, ...row.payload }, row.id);
        }
        cursor = row.id;
      }
      if (state.closed || rows.length === READ_BATCH || pending) {
        continue;
      }
      const waitMs = Math.max(0, Math.min(config.heartbeatMs, deadline - config.now()));
      const beat = await new Promise<boolean>((resolve) => {
        wake = () => resolve(false);
        timer = setTimeout(() => {
          wake = null;
          resolve(true);
        }, waitMs);
      });
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (state.closed || !beat) {
        continue;
      }
      if (config.now() >= deadline) {
        yield frame("closed", { reason: "lifetime" });
        return;
      }
      if (!(await allowedNow())) {
        yield frame("closed", { reason: "access" });
        return;
      }
      yield ": hb\n\n";
    }
    if (state.closed === "replaced") {
      yield frame("closed", { reason: "replaced" });
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    unsubscribe();
    open.delete(key);
    signal?.removeEventListener("abort", onAbort);
  }
}
