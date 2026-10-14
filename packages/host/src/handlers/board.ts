/**
 * The team board's routes, phase K0 (team-board-spec.md section 13). Server mode only: on Personal
 * every one answers the router's own `404 not_found`, so the board does not exist there at all.
 *
 * CSRF and the request rate limit are the HTTP adapter's, applied to every write before dispatch
 * (`http-adapter.ts`). The session gate is the router's. Identity is `getTenant(request)` and nothing
 * the request body says.
 */
import { isServerMode } from "@agentforge/core";
import {
  parseComment,
  parseCreateCard,
  parseCreateColumn,
  parseUpdateCard,
  parseUpdateColumn,
  parseVersion,
} from "../board/input";
import {
  CardConflictError,
  addComment,
  archiveCard,
  createCard,
  createColumn,
  getBoard,
  getCard,
  restoreCard,
  updateCard,
  updateColumn,
} from "../board/service";
import { boardEventStream } from "../board/stream";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import type { HostRequest, HostResult } from "../types";

const NOT_FOUND: HostResult = {
  type: "json",
  status: 404,
  body: { error: { code: "not_found", message: "Not found" } },
};

const LAST_EVENT_ID = /^\d{1,15}$/;

function failure(error: unknown): HostResult {
  if (error instanceof CardConflictError) {
    return jsonOk({ error: { code: error.code, message: error.message }, card: error.card }, 409);
  }
  return jsonError(error);
}

/** Server mode, then the caller's tenant, then the work. Any refusal is the same envelope as elsewhere. */
function boardRoute(work: (request: HostRequest) => Promise<HostResult> | HostResult) {
  return async (request: HostRequest): Promise<HostResult> => {
    if (!isServerMode()) {
      return NOT_FOUND;
    }
    try {
      return await work(request);
    } catch (error) {
      return failure(error);
    }
  };
}

export const handleGetBoard = boardRoute(async (request) => jsonOk({ board: getBoard(await getTenant(request)) }));

export const handleGetBoardCard = boardRoute(async (request) =>
  jsonOk(getCard(await getTenant(request), request.params.cardId ?? "")),
);

export const handlePostBoardCard = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ card: createCard(scope, parseCreateCard(request.body)) }, 201);
});

export const handlePatchBoardCard = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ card: updateCard(scope, request.params.cardId ?? "", parseUpdateCard(request.body)) });
});

export const handleArchiveBoardCard = boardRoute(async (request) => {
  const scope = await getTenant(request);
  archiveCard(scope, request.params.cardId ?? "", parseVersion(request.body));
  return jsonOk({ ok: true });
});

export const handleRestoreBoardCard = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ card: restoreCard(scope, request.params.cardId ?? "", parseVersion(request.body)) });
});

export const handlePostBoardComment = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ comment: addComment(scope, request.params.cardId ?? "", parseComment(request.body)) }, 201);
});

export const handlePostBoardColumn = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ column: createColumn(scope, parseCreateColumn(request.body)) }, 201);
});

export const handlePatchBoardColumn = boardRoute(async (request) => {
  const scope = await getTenant(request);
  return jsonOk({ column: updateColumn(scope, request.params.columnId ?? "", parseUpdateColumn(request.body)) });
});

/**
 * The K0 route table. `router.ts` compiles it with one line, so a merge from `main` meets one line of
 * tester code there rather than ten. Every by-id route here has its row in `tenancy-harness.test.ts`.
 */
export function boardRoutes(): ReadonlyArray<readonly [string, string, (request: HostRequest) => Promise<HostResult>]> {
  return [
    ["GET", "/api/v1/board", handleGetBoard],
    ["GET", "/api/v1/board/events", handleBoardEvents],
    ["POST", "/api/v1/board/cards", handlePostBoardCard],
    ["GET", "/api/v1/board/cards/:cardId", handleGetBoardCard],
    ["PATCH", "/api/v1/board/cards/:cardId", handlePatchBoardCard],
    ["POST", "/api/v1/board/cards/:cardId/archive", handleArchiveBoardCard],
    ["POST", "/api/v1/board/cards/:cardId/restore", handleRestoreBoardCard],
    ["POST", "/api/v1/board/cards/:cardId/comments", handlePostBoardComment],
    ["POST", "/api/v1/board/columns", handlePostBoardColumn],
    ["PATCH", "/api/v1/board/columns/:columnId", handlePatchBoardColumn],
  ];
}

export const handleBoardEvents = boardRoute(async (request) => {
  const scope = await getTenant(request);
  const session = request.session;
  if (!session) {
    return jsonError(new Error("tenant_required"));
  }
  // No header: start at the newest event. A header that is not an id the host could have sent becomes NaN,
  // and the stream answers it with `event: reset` (spec section 8.1) instead of silently starting at the newest.
  const raw = request.headers["last-event-id"]?.trim();
  const after = raw === undefined || raw === "" ? null : LAST_EVENT_ID.test(raw) ? Number(raw) : Number.NaN;
  return {
    type: "stream",
    status: 200,
    headers: { "Cache-Control": "no-store, no-transform" },
    events: boardEventStream({ ...scope, sessionId: session.id }, after, request.abortSignal),
  };
});
