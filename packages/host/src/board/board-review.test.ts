/**
 * The K0 security review's fixes (team-board-spec.md sections 8.1, 8.2, 13 and 17a), each proved on a real
 * database with real sessions. Companies are separate per finding, so one finding's cards never count toward
 * another's caps.
 *
 *   M1  position keys never grow past `MAX_POSITION_KEY`; the column is rebalanced instead.
 *   M2  per-desk volume caps answer 409 with their own code.
 *   M4  only the creator, the assignee or an owner or admin may archive; only an owner or admin may restore.
 *   L1  the stream's lifetime is checked on every loop turn, even while it is replaying.
 *   L2  a Last-Event-ID that is not an id, or is past the desk's newest event, gets `event: reset`.
 *   L4  access is re-checked once per read batch, not once per event.
 *
 * `AGENTFORGE_SERVER` is set in the environment: the board's handlers read `isServerMode()`, and without it
 * every route would answer 404 and every refusal below would pass for the wrong reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-board-review-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "5c1e9a3f7b2d4c6e8a0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { SESSION_COOKIE_SECURE, createSession } from "../auth/session";
import { type SessionStore, createMemorySessionStore } from "../auth/session-store";
import type { HostJsonResult } from "../types";

const { dispatch } = await import("../router");
const service = await import("./service");
const store = await import("./store");
const { boardEventStream, configureBoardStreams } = await import("./stream");
const { MAX_POSITION_KEY, BOARD_VOLUME } = await import("./types");

const PARTNER = "board-review-partner";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

async function json<T = Record<string, unknown>>(
  person: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const result = await dispatch(
    {
      method,
      path,
      query: {},
      params: {},
      headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
      ...(body === undefined ? {} : { body }),
    },
    { serverMode: true, sessionStore },
  );
  if (result.type !== "json") {
    throw new Error(`expected json from ${method} ${path}, got ${result.type}`);
  }
  return { status: result.status, body: (result as HostJsonResult).body as T };
}

type Card = { id: string; version: number; columnId: string; position: string };
type Refusal = { error: { code: string } };

async function newCard(person: Person, title: string, extra: Record<string, unknown> = {}): Promise<Card> {
  const answer = await json<{ card: Card }>(person, "POST", "/api/v1/board/cards", { title, ...extra });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.card;
}

/** A column's cards in board order (a plain `<` compare, as the renderer sorts them). */
function columnOrder(scope: TenantContext, columnId: string): Card[] {
  return store
    .listCards(scope)
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

function rebalances(scope: TenantContext): number {
  return store
    .eventsAfter(scope, 0, 1_000_000)
    .filter((row) => row.type === "column.changed" && row.payload.rebalanced === true).length;
}

function moveAbove(scope: TenantContext, cardId: string, beforeId: string): void {
  const current = store.findCard(scope, cardId);
  if (!current) {
    throw new Error(`card ${cardId} is gone`);
  }
  service.updateCard(scope, cardId, { version: current.version, move: { columnId: current.columnId, beforeId } });
}

beforeAll(async () => {
  sessionStore = createMemorySessionStore();
}, ROUTER_IMPORT_BUDGET_MS);

afterAll(async () => {
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("M1: position keys stay short under adversarial moves", () => {
  it("alternates two cards into one gap 2,000 times without a long key or a throw", async () => {
    const owner = await provision("review-m1-gap", "review-m1-gap-owner", "owner");
    const scope = owner.tenant;
    const a = service.createCard(scope, { title: "a", description: "", assignee: null, columnId: null });
    const b = service.createCard(scope, { title: "b", description: "", assignee: null, columnId: null });
    const target = service.createCard(scope, { title: "target", description: "", assignee: null, columnId: null });

    let longest = 0;
    for (let move = 0; move < 2_000; move += 1) {
      moveAbove(scope, move % 2 === 0 ? a.id : b.id, target.id);
      for (const card of columnOrder(scope, target.columnId)) {
        longest = Math.max(longest, card.position.length);
      }
    }

    expect(longest).toBeLessThanOrEqual(MAX_POSITION_KEY);
    expect(columnOrder(scope, target.columnId).map((card) => card.id)).toEqual([a.id, b.id, target.id]);
    expect(rebalances(scope)).toBeGreaterThan(0);
  }, 120_000);

  it("inserts above the same card 2,000 times and keeps every card in order", async () => {
    const owner = await provision("review-m1-above", "review-m1-above-owner", "owner");
    const scope = owner.tenant;
    const target = service.createCard(scope, { title: "target", description: "", assignee: null, columnId: null });
    const inserted: string[] = [];
    for (let at = 0; at < 2_000; at += 1) {
      const card = service.createCard(scope, { title: `c${at}`, description: "", assignee: null, columnId: null });
      moveAbove(scope, card.id, target.id);
      inserted.push(card.id);
    }

    const order = columnOrder(scope, target.columnId);
    expect(order.map((card) => card.id)).toEqual([...inserted, target.id]);
    expect(Math.max(...order.map((card) => card.position.length))).toBeLessThanOrEqual(MAX_POSITION_KEY);
    expect(new Set(order.map((card) => card.position)).size).toBe(order.length);
    expect(rebalances(scope)).toBeGreaterThan(0);
  }, 120_000);
});

describe("M2: volume caps", () => {
  let restoreVolume: () => void = () => undefined;
  afterEach(() => restoreVolume());

  it("keeps the real caps at 5,000 cards, 500 comments per card and 50 columns", () => {
    expect(BOARD_VOLUME).toEqual({ cards: 5_000, commentsPerCard: 500, columns: 50 });
  });

  it("answers 409 card_limit at the desk's card cap, and counts only live cards", async () => {
    const owner = await provision("review-m2-cards", "review-m2-cards-owner", "owner");
    restoreVolume = service.configureBoardVolume({ cards: 2 });
    const first = await newCard(owner, "one");
    await newCard(owner, "two");
    const third = await json<Refusal>(owner, "POST", "/api/v1/board/cards", { title: "three" });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("card_limit");

    await json(owner, "POST", `/api/v1/board/cards/${first.id}/archive`, { version: first.version });
    await newCard(owner, "three, after an archive");
  });

  it("answers 409 comment_limit at the per-card comment cap", async () => {
    const owner = await provision("review-m2-comments", "review-m2-comments-owner", "owner");
    restoreVolume = service.configureBoardVolume({ commentsPerCard: 2 });
    const card = await newCard(owner, "talkative");
    for (const body of ["first", "second"]) {
      expect((await json(owner, "POST", `/api/v1/board/cards/${card.id}/comments`, { body })).status).toBe(201);
    }
    const third = await json<Refusal>(owner, "POST", `/api/v1/board/cards/${card.id}/comments`, { body: "third" });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("comment_limit");
  });

  it("answers 409 column_limit at the desk's column cap, the five built-in columns included", async () => {
    const owner = await provision("review-m2-columns", "review-m2-columns-owner", "owner");
    restoreVolume = service.configureBoardVolume({ columns: 6 });
    expect((await json(owner, "POST", "/api/v1/board/columns", { name: "Review" })).status).toBe(201);
    const fifth = await json<Refusal>(owner, "POST", "/api/v1/board/columns", { name: "Later" });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error.code).toBe("column_limit");
  });
});

describe("M4: who may archive and restore", () => {
  let owner: Person;
  let member: Person;
  let colleague: Person;
  let outsider: Person;

  beforeAll(async () => {
    owner = await provision("review-m4", "review-m4-owner", "owner");
    member = await provision("review-m4", "review-m4-member", "member");
    colleague = await provision("review-m4", "review-m4-colleague", "member");
    outsider = await provision("review-m4-other", "review-m4-outsider", "owner");
  });

  async function archive(person: Person, card: Card) {
    return json<Refusal>(person, "POST", `/api/v1/board/cards/${card.id}/archive`, { version: card.version });
  }

  it("refuses a member who neither created nor holds the card with 403 not_allowed", async () => {
    const card = await newCard(owner, "the owner's card");
    const answer = await archive(member, card);
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe("not_allowed");
    expect(store.findCard(owner.tenant, card.id)).not.toBeNull();
  });

  it("lets the creator, the assignee and an owner archive", async () => {
    const byCreator = await newCard(member, "mine");
    expect((await archive(member, byCreator)).status).toBe(200);

    const assigned = await newCard(owner, "assigned to the colleague", {
      assignee: { kind: "person", userId: "review-m4-colleague" },
    });
    expect((await archive(colleague, assigned)).status).toBe(200);

    const anyCard = await newCard(member, "the owner may archive this");
    expect((await archive(owner, anyCard)).status).toBe(200);
  });

  it("answers another company with 404, never 403, so a card id reveals nothing", async () => {
    const card = await newCard(owner, "private to this company");
    const answer = await archive(outsider, card);
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe("card_not_found");
  });

  it("restores an archived card for an owner, with an audit row and a card.restored event", async () => {
    const { sql } = await import("@agentforge/db");
    const card = await newCard(member, "brought back");
    expect((await archive(member, card)).status).toBe(200);
    const archived = store.findArchivedCard(owner.tenant, card.id);
    expect(archived).not.toBeNull();

    const byMember = await json<Refusal>(member, "POST", `/api/v1/board/cards/${card.id}/restore`, {
      version: archived?.version,
    });
    expect(byMember.status).toBe(403);
    expect(byMember.body.error.code).toBe("admin_only");

    const byOutsider = await json<Refusal>(outsider, "POST", `/api/v1/board/cards/${card.id}/restore`, {
      version: archived?.version,
    });
    expect(byOutsider.status).toBe(404);

    const stale = await json<Refusal>(owner, "POST", `/api/v1/board/cards/${card.id}/restore`, { version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("card_conflict");

    const cursor = store.latestEventId(owner.tenant);
    const restored = await json<{ card: Card }>(owner, "POST", `/api/v1/board/cards/${card.id}/restore`, {
      version: archived?.version,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.card.columnId).toBe(card.columnId);
    expect(store.cardIsLive(owner.tenant, card.id)).toBe(true);
    expect(store.eventsAfter(owner.tenant, cursor, 10).map((row) => [row.type, row.cardId])).toContainEqual([
      "card.restored",
      card.id,
    ]);
    const audit = sql
      .prepare("SELECT actor_user_id AS actor FROM board_audit WHERE action = 'card.restore' AND target = ?")
      .all(card.id) as Array<{ actor: string }>;
    expect(audit).toEqual([{ actor: "review-m4-owner" }]);
  });

  it("restores into To do when the card's column has been archived", async () => {
    const column = await json<{ column: { id: string } }>(owner, "POST", "/api/v1/board/columns", { name: "Gone" });
    const card = await newCard(owner, "orphan", { columnId: column.body.column.id });
    expect((await archive(owner, card)).status).toBe(200);
    expect(
      (await json(owner, "PATCH", `/api/v1/board/columns/${column.body.column.id}`, { archived: true })).status,
    ).toBe(200);

    const archived = store.findArchivedCard(owner.tenant, card.id);
    const restored = await json<{ card: Card }>(owner, "POST", `/api/v1/board/cards/${card.id}/restore`, {
      version: archived?.version,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.card.columnId).toBe(store.columnOfKind(owner.tenant, "todo")?.id);
  });
});

describe("the event stream (L1, L2, L4)", () => {
  let owner: Person;
  let finds = 0;
  let restoreStreams: () => void = () => undefined;

  function countingStore(): SessionStore {
    return {
      ...sessionStore,
      find: async (id: string) => {
        finds += 1;
        return sessionStore.find(id);
      },
    };
  }

  beforeAll(async () => {
    owner = await provision("review-stream", "review-stream-owner", "owner");
  });

  afterEach(() => restoreStreams());

  function viewer() {
    return { ...owner.tenant, sessionId: owner.sessionId };
  }

  function addCards(count: number): void {
    for (let at = 0; at < count; at += 1) {
      service.createCard(owner.tenant, { title: `s${at}`, description: "", assignee: null, columnId: null });
    }
  }

  /** Reads frames until `stop` says so or the stream ends, then aborts it. */
  async function read(after: number | null, stop: (frames: string[]) => boolean): Promise<string[]> {
    const controller = new AbortController();
    const frames: string[] = [];
    for await (const chunk of boardEventStream(viewer(), after, controller.signal)) {
      frames.push(chunk);
      if (stop(frames)) {
        controller.abort();
        break;
      }
    }
    return frames;
  }

  const eventNames = (frames: string[]) =>
    frames.flatMap((chunk) => chunk.match(/^event: (.+)$/m)?.[1] ?? []).filter((name) => name !== "reset");

  it("L1: closes on time while replaying, before the backlog is sent", async () => {
    const from = store.latestEventId(owner.tenant);
    addCards(300);
    restoreStreams = configureBoardStreams({ maxLifetimeMs: 0, sessionStore: () => sessionStore });
    const frames = await read(from, () => false);
    expect(frames.at(-1)).toContain('"reason":"lifetime"');
    expect(eventNames(frames)).toEqual(["closed"]);
  });

  it("L2: answers a Last-Event-ID that is not an id with event: reset", async () => {
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, sessionStore: () => sessionStore });
    const frames = await read(Number.NaN, (seen) => seen.some((chunk) => chunk.startsWith(": open")));
    expect(frames[0]).toBe("event: reset\ndata: {}\n\n");
  });

  it("L2: answers a Last-Event-ID past the desk's newest event with event: reset", async () => {
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, sessionStore: () => sessionStore });
    const ahead = store.latestEventId(owner.tenant) + 1_000;
    const frames = await read(ahead, (seen) => seen.some((chunk) => chunk.startsWith(": open")));
    expect(frames[0]).toBe("event: reset\ndata: {}\n\n");
  });

  it("L2: resumes a valid Last-Event-ID without a reset", async () => {
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, sessionStore: () => sessionStore });
    const from = store.latestEventId(owner.tenant);
    addCards(1);
    const frames = await read(from, (seen) => seen.some((chunk) => chunk.includes("event: card.created")));
    expect(frames.some((chunk) => chunk.startsWith("event: reset"))).toBe(false);
  });

  it("L4: re-checks access once per read batch, not once per event", async () => {
    const from = store.latestEventId(owner.tenant);
    addCards(250);
    finds = 0;
    const frozen = Date.now();
    restoreStreams = configureBoardStreams({ heartbeatMs: 60_000, sessionStore: countingStore, now: () => frozen });
    const frames = await read(from, (seen) => eventNames(seen).length >= 250);
    expect(eventNames(frames)).toHaveLength(250);
    // Two read batches (200 + 50): two checks, where a per-event check would make 250.
    expect(finds).toBe(2);
  });

  it("L4: checks again inside a batch once more than a second has passed", async () => {
    const from = store.latestEventId(owner.tenant);
    addCards(5);
    finds = 0;
    let clock = Date.now();
    restoreStreams = configureBoardStreams({
      heartbeatMs: 60_000,
      sessionStore: countingStore,
      now: () => {
        clock += 600;
        return clock;
      },
    });
    const frames = await read(from, (seen) => eventNames(seen).length >= 5);
    expect(eventNames(frames)).toHaveLength(5);
    expect(finds).toBeGreaterThan(1);
  });
});
