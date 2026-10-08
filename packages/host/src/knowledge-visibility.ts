import { sql } from "@agentforge/db";
import { isServerMode, type TenantContext } from "@agentforge/core";

/**
 * Who may see a Knowledge Base source on a desk several people share.
 *
 * **The rule (owner, 2026-10-06): what a person does in Chat is private to that person, even from the
 * company's owner and admins.** The card a Chat thread leaves in the Knowledge Base
 * (`origin_kind = 'thread'`, `origin_id = <thread id>`) therefore belongs to the person who owns the
 * thread, and to nobody else. There is no role override: an owner or an admin is a person like any
 * other here, because the thread is not theirs.
 *
 * Every other source (a pasted note, a file, a URL, a Research or Finance or Images card) is the
 * company's, as it always was. Nothing here makes a person's own Knowledge Base private; that is
 * designed and not built (`docs/internal/security-register.md`, SR-155 and above).
 *
 * **Hosted only.** The rule applies when `isServerMode()` is true, read on every call and never at
 * import. Off server mode (the desktop app and webdev: one person per desk) every function here
 * answers "no restriction" with an empty SQL fragment, so the statements the callers build are
 * byte-for-byte the ones they built before this module existed. `knowledge-team-privacy.test.ts` and
 * `knowledge-visibility.test.ts` pin both halves.
 *
 * **It is enforced in SQL, by the host.** The renderer never filters anything: every read path that
 * can return a source's name, text, chunk, graph node or map entry builds its query with one of the
 * fragments below. A fragment is a correlated lookup (the source by its primary key, and for a Chat
 * card the thread by its primary key), never a long `NOT IN (?, ?, ...)` list and never a list rebuilt
 * from every source or thread on the desk, so its cost grows with the rows a query returns and not
 * with how many cards the colleagues have.
 *
 * A thread card whose thread is gone (the orphan sweep removes it, but not yet) is visible to
 * nobody: no thread of the person's has its id, so the ownership lookup finds nothing. That is the
 * safe side of every edge: a card with `origin_kind = 'thread'` and no `origin_id` is hidden too.
 */

/** A piece of SQL plus the values for its `?` placeholders, in order. Empty when there is nothing to add. */
export type SqlFragment = { readonly sql: string; readonly params: readonly string[] };

const NO_RESTRICTION: SqlFragment = Object.freeze({ sql: "", params: Object.freeze([]) as readonly string[] });

export type VisibilityOptions = {
  /** Injected by a test; the host reads `isServerMode()` on every call. */
  readonly serverMode?: boolean;
};

/** Whether Chat cards are private on this process: the hosted server, not the desktop or webdev. */
export function chatCardsArePrivate(options: VisibilityOptions = {}): boolean {
  return options.serverMode ?? isServerMode();
}

/** The table the fragments qualify their columns with when the caller did not alias it. */
const SOURCES_TABLE = "knowledge_sources";

function ownThreadParams(tenant: TenantContext): string[] {
  return [tenant.organizationId, tenant.workspaceId, tenant.userId];
}

/**
 * True when `threadIdRef` names a thread this person owns on this desk. Three placeholders:
 * organization, desk, person. A lookup by the thread's primary key, one per row it is asked about, so
 * it costs nothing for the rows a query never reaches. (An `IN (SELECT id FROM threads ...)` list was
 * measured first: it is rebuilt on every statement, from every thread the person has, and cost 94 ms
 * against 4 ms on a 20,000-source desk for a query that matches 400 chunks.)
 */
function ownsThread(threadIdRef: string): string {
  return `EXISTS (SELECT 1 FROM threads t WHERE t.id = ${threadIdRef} AND t.organization_id = ? AND t.workspace_id = ? AND t.user_id = ?)`;
}

/**
 * True for a `knowledge_sources` row this person may see: anything that is not a Chat card, and a Chat
 * card whose thread this person owns. Three placeholders (`ownsThread`). A Chat card with no
 * `origin_id`, or whose thread is gone, is not visible to anyone.
 */
function visibleExpression(alias: string): string {
  return `(${alias}.origin_kind IS NULL OR ${alias}.origin_kind <> 'thread' OR ${ownsThread(`${alias}.origin_id`)})`;
}

/**
 * `AND <may see this source row>` over a `knowledge_sources` table. For a query that already selects
 * from `knowledge_sources` (the Sources list, the reindex sweep, a name lookup). `alias` is the name
 * the query gave the table, when it gave one.
 */
export function andVisibleSource(
  tenant: TenantContext,
  alias: string = SOURCES_TABLE,
  options: VisibilityOptions = {},
): SqlFragment {
  if (!chatCardsArePrivate(options)) {
    return NO_RESTRICTION;
  }
  return { sql: ` AND ${visibleExpression(alias)}`, params: ownThreadParams(tenant) };
}

/**
 * `AND <the source named by idColumn is one this person may see>`, for a query over a table that only
 * holds source ids (the full-text chunk index). `idColumn` is qualified with its table, because the
 * check is a lookup of that row's source by primary key.
 */
export function andVisibleSourceId(
  tenant: TenantContext,
  idColumn: string,
  options: VisibilityOptions = {},
): SqlFragment {
  if (!chatCardsArePrivate(options)) {
    return NO_RESTRICTION;
  }
  return {
    sql: ` AND EXISTS (SELECT 1 FROM knowledge_sources vs WHERE vs.id = ${idColumn} AND vs.workspace_id = ? AND ${visibleExpression("vs")})`,
    params: [tenant.workspaceId, ...ownThreadParams(tenant)],
  };
}

/**
 * `AND <not a Chat card>`: the sources a desk-wide artifact may be built from. The knowledge map is
 * one saved row per desk, shown to everybody, so it cannot hold anybody's Chat. Every person's card is
 * left out of it here, the one making the map included.
 */
export function andSharedSource(alias: string = SOURCES_TABLE, options: VisibilityOptions = {}): SqlFragment {
  if (!chatCardsArePrivate(options)) {
    return NO_RESTRICTION;
  }
  return { sql: ` AND (${alias}.origin_kind IS NULL OR ${alias}.origin_kind <> 'thread')`, params: [] };
}

/** True when the source exists on this desk and this person may not see it. */
export function sourceIsHidden(tenant: TenantContext, sourceId: string, options: VisibilityOptions = {}): boolean {
  if (!chatCardsArePrivate(options)) {
    return false;
  }
  const exists = sql
    .prepare("SELECT 1 AS ok FROM knowledge_sources WHERE workspace_id = ? AND id = ?")
    .get(tenant.workspaceId, sourceId);
  return Boolean(exists) && !sourceIsVisible(tenant, sourceId, options);
}

/**
 * True when this person may see the source. Off server mode that is always true, whether or not a
 * row exists (the callers' own "missing" handling is unchanged); hosted it is true only for a row the
 * visibility rule lets through.
 */
export function sourceIsVisible(tenant: TenantContext, sourceId: string, options: VisibilityOptions = {}): boolean {
  if (!chatCardsArePrivate(options)) {
    return true;
  }
  const where = andVisibleSource(tenant, undefined, options);
  const row = sql
    .prepare(`SELECT 1 AS ok FROM knowledge_sources WHERE workspace_id = ? AND id = ?${where.sql}`)
    .get(tenant.workspaceId, sourceId, ...where.params);
  return Boolean(row);
}

/**
 * The graph nodes this person may see, as a `WITH visible(id) AS (...)` prefix, or null when nothing
 * is restricted. A `source` node is visible when its source is, a `thread` node when the thread is the
 * person's own, and a `topic` node when every source it `covers` is visible: a topic that covers a
 * colleague's Chat card was named from it. An edge is visible when both of its ends are.
 *
 * The prefix carries 13 placeholders; `params` is in their order.
 */
export function visibleGraphNodes(
  tenant: TenantContext,
  options: VisibilityOptions = {},
): { readonly with: string; readonly params: readonly string[] } | null {
  if (!chatCardsArePrivate(options)) {
    return null;
  }
  const own = ownThreadParams(tenant);
  const sourceVisible = (alias: string, idRef: string): string =>
    `EXISTS (SELECT 1 FROM knowledge_sources ${alias} WHERE ${alias}.id = ${idRef} AND ${alias}.workspace_id = ? AND ${visibleExpression(alias)})`;
  return {
    with: `WITH visible(id) AS (
      SELECT n.id FROM knowledge_graph_nodes n
      WHERE n.workspace_id = ?
        AND (
          (n.kind = 'source' AND ${sourceVisible("vs", "n.id")})
          OR (n.kind = 'thread' AND ${ownsThread("n.id")})
          OR (n.kind = 'topic' AND NOT EXISTS (
            SELECT 1 FROM knowledge_graph_edges ce
            WHERE ce.workspace_id = ? AND ce.from_id = n.id AND ce.kind = 'covers'
              AND NOT ${sourceVisible("hs", "ce.to_id")}
          ))
        )
    )`,
    params: [tenant.workspaceId, tenant.workspaceId, ...own, ...own, tenant.workspaceId, tenant.workspaceId, ...own],
  };
}

/**
 * The marker a hosted map is saved with. A map written before this lane may name a colleague's Chat
 * (its topics and its overview text were written from every card), so on the hosted server a saved map
 * without the marker is read as no map at all, and the desk makes one more. The cost is one re-map per
 * hosted desk; no hosted desk held real customer data when this was decided (2026-10-07, in the lane
 * that built this). Off server mode nothing is stamped and nothing is checked.
 */
export const MAP_SCOPE_KEY = "privacyScope";
export const SHARED_MAP_SCOPE = "shared-v1";
