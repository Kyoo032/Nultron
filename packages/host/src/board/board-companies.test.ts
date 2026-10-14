/**
 * The team board, phase K0, through the real router with real sessions and a real database
 * (team-board-spec.md section 17, K0 proof).
 *
 * Two companies under ONE tenant id (the SR-163 shape: a white-label partner holds many companies).
 * Company A has an owner (Alice) and a member (Ann); company B has an owner (Bob). Every refusal B gets
 * is paired with A reading the same thing successfully, so a server that refused everybody fails here.
 *
 * `AGENTFORGE_SERVER` is set in the environment, not only passed to `dispatch`: the board's own handlers
 * read `isServerMode()`, and without it every route would 404 and every isolation assertion would pass
 * for the wrong reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@agentforge/core";
import { ROUTER_IMPORT_BUDGET_MS } from "../__fixtures__/test-budgets";

const dataDir = mkdtempSync(join(tmpdir(), "agentforge-board-companies-"));
process.env.AGENTFORGE_DATA_DIR = dataDir;
process.env.MEDIA_ROOT = join(dataDir, "media");
process.env.AGENTFORGE_SECRETS_KEY = "3f9a1c7e5b2d4608a1c3e5f7092b4d6f8a0c2e4f6b8d0a2c4e6f8b0d2f4a6c8e";
process.env.AGENTFORGE_SERVER = "1";
delete process.env.AGENTFORGE_RUNTIME;
delete process.env.AGENTFORGE_SETTINGS_PATH;
delete process.env.DATABASE_URL;

import { createSession, SESSION_COOKIE_SECURE } from "../auth/session";
import { createMemorySessionStore } from "../auth/session-store";
import type { HostJsonResult, HostRequest, HostResult, HostStreamResult } from "../types";

const { dispatch } = await import("../router");
const { configureBoardStreams, openBoardStreams } = await import("./stream");
const { boardBus } = await import("./bus");

const PARTNER = "board-partner";

type Person = { readonly tenant: TenantContext; readonly sessionId: string };

let sessionStore: ReturnType<typeof createMemorySessionStore>;
let alice: Person;
let ann: Person;
let bob: Person;
let restoreStreams: () => void = () => undefined;

async function provision(orgId: string, userId: string, role: "owner" | "member"): Promise<Person> {
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  const tenant = await ensurePortalOwner(db, { tenantId: PARTNER, orgId, userId, role });
  const session = createSession({ tenantId: PARTNER, orgId, userId, now: Date.now() });
  await sessionStore.create(session);
  return { tenant, sessionId: session.id };
}

function request(person: Person, method: string, path: string, over: Partial<HostRequest> = {}): HostRequest {
  return {
    method,
    path,
    query: {},
    params: {},
    headers: { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` },
    ...over,
  };
}

async function call(
  person: Person,
  method: string,
  path: string,
  over: Partial<HostRequest> = {},
): Promise<HostResult> {
  return dispatch(request(person, method, path, over), { serverMode: true, sessionStore });
}

async function json<T = Record<string, unknown>>(
  person: Person,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const result = await call(person, method, path, body === undefined ? {} : { body });
  if (result.type !== "json") {
    throw new Error(`expected json from ${method} ${path}, got ${result.type}`);
  }
  return { status: result.status, body: (result as HostJsonResult).body as T };
}

type Card = { id: string; title: string; version: number; columnId: string; position: string; description?: string };
type Board = {
  cursor: number;
  columns: Array<{ id: string; kind: string }>;
  cards: Card[];
  people: Array<{ userId: string }>;
};

async function board(person: Person): Promise<Board> {
  const answer = await json<{ board: Board }>(person, "GET", "/api/v1/board");
  expect(answer.status).toBe(200);
  return answer.body.board;
}

async function newCard(person: Person, title: string, extra: Record<string, unknown> = {}): Promise<Card> {
  const answer = await json<{ card: Card }>(person, "POST", "/api/v1/board/cards", { title, ...extra });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.card;
}

type Frame = { id: number | null; event: string | null; data: Record<string, unknown> | null; comment: boolean };

function parseFrame(raw: string): Frame {
  const lines = raw.trim().split("\n");
  const value = (name: string) =>
    lines
      .find((line) => line.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? null;
  const id = value("id");
  const data = value("data");
  return {
    id: id === null ? null : Number(id),
    event: value("event"),
    data: data === null ? null : (JSON.parse(data) as Record<string, unknown>),
    comment: lines.every((line) => line.startsWith(":")),
  };
}

type Tap = {
  readonly frames: Frame[];
  readonly abort: () => void;
  readonly done: () => boolean;
  readonly result: HostStreamResult;
};

/** Open a stream and pump it in the background, the way the HTTP adapter drains one. */
async function tap(person: Person, lastEventId?: number): Promise<Tap> {
  const controller = new AbortController();
  const headers: Record<string, string | undefined> = { cookie: `${SESSION_COOKIE_SECURE}=${person.sessionId}` };
  if (lastEventId !== undefined) {
    headers["last-event-id"] = String(lastEventId);
  }
  const result = await call(person, "GET", "/api/v1/board/events", { headers, abortSignal: controller.signal });
  expect(result.type, JSON.stringify((result as HostJsonResult).body ?? null)).toBe("stream");
  const stream = result as HostStreamResult;
  const frames: Frame[] = [];
  let finished = false;
  void (async () => {
    for await (const chunk of stream.events) {
      frames.push(parseFrame(chunk));
    }
    finished = true;
  })();
  return { frames, abort: () => controller.abort(), done: () => finished, result: stream };
}

async function until(condition: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const events = (t: Tap) => t.frames.filter((frame) => frame.event !== null);

beforeAll(async () => {
  sessionStore = createMemorySessionStore();
  alice = await provision("board-org-a", "board-alice", "owner");
  ann = await provision("board-org-a", "board-ann", "member");
  bob = await provision("board-org-b", "board-bob", "owner");
  restoreStreams = configureBoardStreams({ heartbeatMs: 40, sessionStore: () => sessionStore });
}, ROUTER_IMPORT_BUDGET_MS);

afterEach(() => {
  restoreStreams();
  restoreStreams = configureBoardStreams({ heartbeatMs: 40, sessionStore: () => sessionStore });
});

afterAll(async () => {
  restoreStreams();
  const { sql } = await import("@agentforge/db");
  sql.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("team board K0: two companies under one partner", () => {
  it("puts both companies' people on separate desks of the same partner", () => {
    expect(alice.tenant.tenantId).toBe(PARTNER);
    expect(bob.tenant.tenantId).toBe(PARTNER);
    expect(alice.tenant.workspaceId).toBe(ann.tenant.workspaceId);
    expect(alice.tenant.workspaceId).not.toBe(bob.tenant.workspaceId);
  });

  it("shows a card to a colleague and to nobody in the other company", async () => {
    const card = await newCard(alice, "Quarterly plan", { description: "the confidential plan text" });

    const seenByAnn = await json<{ card: Card }>(ann, "GET", `/api/v1/board/cards/${card.id}`);
    expect(seenByAnn.status).toBe(200);
    expect(seenByAnn.body.card.title).toBe("Quarterly plan");
    expect(seenByAnn.body.card.description).toBe("the confidential plan text");
    expect((await board(ann)).cards.map((c) => c.id)).toContain(card.id);

    const bobsBoard = await board(bob);
    expect(bobsBoard.cards).toEqual([]);
    expect(JSON.stringify(bobsBoard)).not.toContain("Quarterly plan");
    expect(bobsBoard.people.map((p) => p.userId)).toEqual(["board-bob"]);

    const ghost = "00000000-0000-7000-8000-000000000000";
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["PATCH", "", { version: 1, title: "taken over" }],
      ["POST", "/archive", { version: 1 }],
      ["POST", "/comments", { body: "hello from B" }],
    ] as const) {
      const foreign = await json<{ error: { code: string } }>(
        bob,
        method,
        `/api/v1/board/cards/${card.id}${suffix}`,
        body,
      );
      const nobody = await json<{ error: { code: string } }>(
        bob,
        method,
        `/api/v1/board/cards/${ghost}${suffix}`,
        body,
      );
      expect(foreign.status, `${method} ${suffix}`).toBe(404);
      expect(foreign.body.error.code).toBe("card_not_found");
      expect(foreign.body).toEqual(nobody.body);
    }

    const after = await json<{ card: Card }>(alice, "GET", `/api/v1/board/cards/${card.id}`);
    expect(after.body.card.title).toBe("Quarterly plan");
    expect(after.body.card.version).toBe(1);
  });

  it("refuses another company's column, and a person outside the company as assignee", async () => {
    const aliceColumns = (await board(alice)).columns;
    const todo = aliceColumns.find((c) => c.kind === "todo");
    expect(todo).toBeDefined();
    const foreign = await json<{ error: { code: string } }>(bob, "PATCH", `/api/v1/board/columns/${todo?.id}`, {
      name: "Mine",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("column_not_found");

    const intoForeignColumn = await json<{ error: { code: string } }>(bob, "POST", "/api/v1/board/cards", {
      title: "sneaky",
      columnId: todo?.id,
    });
    expect(intoForeignColumn.status).toBe(400);
    expect(JSON.stringify(await board(alice))).not.toContain("sneaky");

    const toBob = await json<{ error: { code: string } }>(alice, "POST", "/api/v1/board/cards", {
      title: "for bob",
      assignee: { kind: "person", userId: "board-bob" },
    });
    expect(toBob.status).toBe(400);
    const toAnn = await newCard(alice, "for ann", { assignee: { kind: "person", userId: "board-ann" } });
    expect((toAnn as unknown as { assignee: unknown }).assignee).toEqual({ kind: "person", userId: "board-ann" });
  });

  it("seals the description and every comment at rest", async () => {
    const card = await newCard(alice, "Sealed", { description: "plaintext-description-marker" });
    const comment = await json<{ comment: { body: string } }>(ann, "POST", `/api/v1/board/cards/${card.id}/comments`, {
      body: "plaintext-comment-marker",
    });
    expect(comment.status).toBe(201);
    expect(comment.body.comment.body).toBe("plaintext-comment-marker");

    const { sql } = await import("@agentforge/db");
    const stored = sql.prepare("SELECT description FROM cards WHERE id = ?").get(card.id) as { description: string };
    const storedComment = sql.prepare("SELECT body FROM card_comments WHERE card_id = ?").get(card.id) as {
      body: string;
    };
    expect(stored.description).not.toContain("plaintext-description-marker");
    expect(storedComment.body).not.toContain("plaintext-comment-marker");
    expect(JSON.parse(stored.description)).toMatchObject({ v: 1, alg: "aes-256-gcm" });
    const events = sql.prepare("SELECT payload FROM card_events WHERE card_id = ?").all(card.id) as Array<{
      payload: string;
    }>;
    expect(events.map((e) => e.payload).join("")).not.toContain("plaintext");
  });

  it("answers a stale edit with 409 and the card as it is now", async () => {
    const card = await newCard(alice, "Draft");
    const first = await json<{ card: Card }>(alice, "PATCH", `/api/v1/board/cards/${card.id}`, {
      version: 1,
      title: "Final",
    });
    expect(first.status).toBe(200);
    expect(first.body.card.version).toBe(2);

    const stale = await json<{ error: { code: string }; card: Card }>(ann, "PATCH", `/api/v1/board/cards/${card.id}`, {
      version: 1,
      description: "my late edit",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("card_conflict");
    expect(stale.body.card.title).toBe("Final");
    expect(stale.body.card.version).toBe(2);
    expect(stale.body.card.description).toBe("");
  });

  it("moves a card above another by rewriting only its own position", async () => {
    const { columns } = await board(alice);
    const doing = columns.find((c) => c.kind === "doing");
    const first = await newCard(alice, "one", { columnId: doing?.id });
    const second = await newCard(alice, "two", { columnId: doing?.id });
    const third = await newCard(alice, "three", { columnId: doing?.id });

    const moved = await json<{ card: Card }>(ann, "PATCH", `/api/v1/board/cards/${third.id}`, {
      version: 1,
      columnId: doing?.id,
      beforeId: first.id,
    });
    expect(moved.status).toBe(200);
    const order = (await board(alice)).cards.filter((c) => c.columnId === doing?.id).map((c) => c.title);
    expect(order).toEqual(["three", "one", "two"]);
    const untouched = await json<{ card: Card }>(alice, "GET", `/api/v1/board/cards/${second.id}`);
    expect(untouched.body.card.version).toBe(1);
  });

  it("lets only an owner or admin change columns, and keeps built-in ones", async () => {
    const denied = await json<{ error: { code: string } }>(ann, "POST", "/api/v1/board/columns", { name: "QA" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("admin_only");

    const created = await json<{ column: { id: string; name: string; kind: string } }>(
      alice,
      "POST",
      "/api/v1/board/columns",
      {
        name: "QA",
        position: 1,
      },
    );
    expect(created.status).toBe(201);
    const columns = (await board(alice)).columns;
    expect(columns.map((c) => c.kind)).toEqual(["todo", "custom", "doing", "review", "blocked", "done"]);

    const done = columns.find((c) => c.kind === "done");
    const builtin = await json<{ error: { code: string } }>(alice, "PATCH", `/api/v1/board/columns/${done?.id}`, {
      archived: true,
    });
    expect(builtin.status).toBe(409);
    expect(builtin.body.error.code).toBe("builtin_column");

    const card = await newCard(alice, "in QA", { columnId: created.body.column.id });
    const busy = await json<{ error: { code: string } }>(
      alice,
      "PATCH",
      `/api/v1/board/columns/${created.body.column.id}`,
      {
        archived: true,
      },
    );
    expect(busy.body.error.code).toBe("column_not_empty");
    await json(alice, "POST", `/api/v1/board/cards/${card.id}/archive`, { version: 1 });
    const archived = await json(alice, "PATCH", `/api/v1/board/columns/${created.body.column.id}`, { archived: true });
    expect(archived.status).toBe(200);
    expect((await board(alice)).columns.map((c) => c.kind)).toEqual(["todo", "doing", "review", "blocked", "done"]);

    const { sql } = await import("@agentforge/db");
    const audit = sql
      .prepare("SELECT action FROM board_audit WHERE workspace_id = ? ORDER BY created_at")
      .all(alice.tenant.workspaceId) as Array<{ action: string }>;
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["column.create", "card.archive", "column.archive"]),
    );
  });

  it("writes no event and publishes nothing when a change is refused", async () => {
    const { sql } = await import("@agentforge/db");
    const count = () => (sql.prepare("SELECT count(*) AS n FROM card_events").get() as { n: number }).n;
    const before = count();
    const published: number[] = [];
    const unsubscribe = boardBus().subscribe(PARTNER, alice.tenant.workspaceId, (id) => published.push(id));
    const refused = await json(alice, "POST", "/api/v1/board/cards", { title: "x", columnId: "no-such-column" });
    expect(refused.status).toBe(400);
    unsubscribe();
    expect(count()).toBe(before);
    expect(published).toEqual([]);
  });
});

describe("team board K0: the live stream", () => {
  it("sends the stream with no-store and the SSE content type", async () => {
    const stream = await tap(alice);
    expect(stream.result.status).toBe(200);
    expect(stream.result.headers).toEqual({ "Cache-Control": "no-store, no-transform" });
    stream.abort();
    await until(stream.done, "stream closed after abort");
  });

  it("delivers a colleague's change to both viewers of the desk and nothing to the other company", async () => {
    const cursor = (await board(alice)).cursor;
    const aliceStream = await tap(alice, cursor);
    const annStream = await tap(ann, cursor);
    const bobStream = await tap(bob);
    await until(() => [aliceStream, annStream, bobStream].every((t) => t.frames.length > 0), "streams open");

    const card = await newCard(ann, "Live card");
    await json(alice, "PATCH", `/api/v1/board/cards/${card.id}`, { version: 1, title: "Live card, edited" });

    for (const viewer of [aliceStream, annStream]) {
      await until(() => events(viewer).length >= 2, "two events");
      expect(events(viewer).map((f) => [f.event, f.data?.cardId])).toEqual([
        ["card.created", card.id],
        ["card.edited", card.id],
      ]);
    }
    await until(() => bobStream.frames.filter((f) => f.comment).length >= 3, "bob's heartbeats");
    expect(events(bobStream)).toEqual([]);

    for (const t of [aliceStream, annStream, bobStream]) {
      t.abort();
    }
    await until(() => [aliceStream, annStream, bobStream].every((t) => t.done()), "all closed");
  });

  it("resumes a dropped stream from Last-Event-ID with no gap and no repeat", async () => {
    const first = await tap(alice, (await board(alice)).cursor);
    await until(() => first.frames.length > 0, "open");
    const a = await newCard(alice, "before the drop");
    await until(() => events(first).length === 1, "first event");
    const lastSeen = events(first)[0].id ?? 0;
    first.abort();
    await until(first.done, "dropped");

    const missed = [await newCard(ann, "missed 1"), await newCard(ann, "missed 2"), await newCard(ann, "missed 3")];
    const resumed = await tap(alice, lastSeen);
    await until(() => events(resumed).length === 3, "three replayed");
    expect(events(resumed).map((f) => f.data?.cardId)).toEqual(missed.map((c) => c.id));
    const ids = events(resumed).map((f) => f.id ?? 0);
    expect(ids[0]).toBeGreaterThan(lastSeen);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    expect(events(resumed).some((f) => f.data?.cardId === a.id)).toBe(false);

    const live = await newCard(ann, "after the resume");
    await until(() => events(resumed).length === 4, "live after replay");
    expect(events(resumed)[3].data?.cardId).toBe(live.id);
    resumed.abort();
    await until(resumed.done, "closed");
  });

  it("sends reset when the browser is more events behind than the replay limit", async () => {
    restoreStreams();
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, replayLimit: 2, sessionStore: () => sessionStore });
    const behind = (await board(alice)).cursor;
    await newCard(alice, "r1");
    await newCard(alice, "r2");
    await newCard(alice, "r3");
    const stream = await tap(alice, behind);
    await until(() => events(stream).length >= 1, "reset");
    expect(events(stream)[0].event).toBe("reset");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events(stream).map((f) => f.event)).toEqual(["reset"]);
    stream.abort();
    await until(stream.done, "closed");
  });

  it("still tells viewers a card was archived, and replays nothing else about it", async () => {
    const before = (await board(alice)).cursor;
    const card = await newCard(alice, "short-lived");
    await json(alice, "POST", `/api/v1/board/cards/${card.id}/archive`, { version: 1 });
    const stream = await tap(ann, before);
    await until(() => events(stream).length >= 1, "archive event");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events(stream).map((f) => [f.event, f.data?.cardId])).toEqual([["card.archived", card.id]]);
    stream.abort();
    await until(stream.done, "closed");
  });

  it("closes the stream of a person removed from the company at the next event", async () => {
    const extra = await provision("board-org-a", "board-leaver", "member");
    const leaver = await tap(extra);
    const stayer = await tap(alice);
    await until(() => leaver.frames.length > 0 && stayer.frames.length > 0, "open");

    const { sql } = await import("@agentforge/db");
    sql.prepare("DELETE FROM organization_members WHERE user_id = 'board-leaver'").run();
    const card = await newCard(alice, "after the leaver");

    await until(leaver.done, "leaver's stream ended");
    expect(events(leaver).map((f) => [f.event, f.data])).toEqual([["closed", { reason: "access" }]]);
    await until(() => events(stayer).length >= 1, "stayer still served");
    expect(events(stayer)[0].data?.cardId).toBe(card.id);
    stayer.abort();
    await until(stayer.done, "closed");
  });

  it("closes the stream of a signed-out session at the next heartbeat", async () => {
    const person = await provision("board-org-a", "board-signout", "member");
    const stream = await tap(person);
    await until(() => stream.frames.length > 0, "open");
    const record = await sessionStore.find(person.sessionId);
    if (!record) {
      throw new Error("session vanished");
    }
    await sessionStore.save({ ...record, revokedAt: Date.now() });
    await until(stream.done, "stream ended after sign-out");
    expect(events(stream).map((f) => f.data)).toEqual([{ reason: "access" }]);
  });

  it("caps open streams per person, closing the oldest, and leaves nothing behind", async () => {
    restoreStreams();
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, perPersonCap: 2, sessionStore: () => sessionStore });
    const workspace = alice.tenant.workspaceId;
    const baseline = boardBus().listenerCount(PARTNER, workspace);
    const one = await tap(alice);
    await until(() => one.frames.length > 0, "one open");
    const two = await tap(alice);
    await until(() => two.frames.length > 0, "two open");
    const three = await tap(alice);
    await until(() => three.frames.length > 0, "three open");

    await until(one.done, "oldest closed");
    expect(events(one).map((f) => f.data)).toEqual([{ reason: "replaced" }]);
    expect(openBoardStreams(`${PARTNER}:board-alice`)).toBe(2);

    two.abort();
    three.abort();
    await until(() => two.done() && three.done(), "aborted streams finished");
    expect(openBoardStreams(`${PARTNER}:board-alice`)).toBe(0);
    expect(boardBus().listenerCount(PARTNER, workspace)).toBe(baseline);
  });

  it("caps open streams for the whole process, closing the oldest whoever owns it", async () => {
    restoreStreams();
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, perProcessCap: 2, sessionStore: () => sessionStore });
    expect(openBoardStreams()).toBe(0);
    const first = await tap(alice);
    await until(() => first.frames.length > 0, "alice open");
    const second = await tap(ann);
    await until(() => second.frames.length > 0, "ann open");
    const third = await tap(bob);
    await until(() => third.frames.length > 0, "bob open");

    await until(first.done, "the oldest stream, another person's, closed");
    expect(events(first).map((f) => f.data)).toEqual([{ reason: "replaced" }]);
    expect(openBoardStreams()).toBe(2);
    second.abort();
    third.abort();
    await until(() => second.done() && third.done(), "closed");
    expect(openBoardStreams()).toBe(0);
  });

  it("ends a stream at its lifetime so the browser reconnects from its last id", async () => {
    restoreStreams();
    restoreStreams = configureBoardStreams({ heartbeatMs: 40, maxLifetimeMs: 60, sessionStore: () => sessionStore });
    const stream = await tap(alice);
    await until(stream.done, "lifetime reached");
    expect(events(stream).map((f) => [f.event, f.data])).toEqual([["closed", { reason: "lifetime" }]]);
    expect(openBoardStreams()).toBe(0);
  });
});

describe("team board K0 on Personal", () => {
  it("answers every board route with the router's own 404", async () => {
    const saved = process.env.AGENTFORGE_SERVER;
    delete process.env.AGENTFORGE_SERVER;
    try {
      const unknown = await dispatch(
        { method: "GET", path: "/api/v1/no-such-route", query: {}, params: {}, headers: {} },
        { serverMode: false },
      );
      const { boardRoutes } = await import("../handlers/board");
      for (const [method, path] of boardRoutes()) {
        const concrete = path.replace(/:[A-Za-z]+/g, "00000000-0000-7000-8000-000000000000");
        const result = await dispatch(
          {
            method,
            path: concrete,
            query: {},
            params: {},
            headers: {},
            body: { title: "x", version: 1, name: "x", body: "x" },
          },
          { serverMode: false },
        );
        expect(result.type, `${method} ${path}`).toBe("json");
        expect(result.status, `${method} ${path}`).toBe(404);
        expect((result as HostJsonResult).body, `${method} ${path}`).toEqual((unknown as HostJsonResult).body);
      }
    } finally {
      process.env.AGENTFORGE_SERVER = saved;
    }
  });
});
