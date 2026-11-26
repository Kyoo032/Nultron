/**
 * The OPC role gate (F8a), one policy table for `dispatch` and the `role-matrix` test.
 *
 * What each role may do, enforced here rather than inside ~170 handlers so a route added later
 * takes the safe default — a mutation nobody classified is refused to an auditor, and a read is
 * refused to one unless it is named below:
 *
 * - **owner** — everything, no extra step.
 * - **admin** — everything but the audit-only surface (`canAdminister`).
 * - **member** — reads and agent runs; never `administer` or `audit`.
 * - **auditor** — the Activity Log and Usage, never content, never an agent run
 *   (`canAudit` reads; `canUseAgents` refuses). The role's whole read surface is the allowlist
 *   below: sign-in housekeeping, the desk list the shell needs, and Usage.
 *
 * Every check runs on the membership role `getTenant(request)` resolved server-side — the
 * portal's word, refreshed on the next token after an operator changes it.
 */
import { canAdminister, canAudit, canUseAgents, type MembershipRole } from "@agentforge/core";

/**
 * The gate a route needs. Classified by `routeGate`:
 * - `audit`: `canAudit` — owner and auditor (admin does not audit; the Activity Log and audit
 *   export land here when F2 ships them).
 * - `administer`: `canAdminister` — owner and admin.
 * - `agents`: `canUseAgents` — everyone but the auditor. The default for every mutation that is
 *   not administer: an agent run, an upload, content a worker creates.
 * - `read`: any signed-in role except the auditor — reads of content (threads, artifacts,
 *   knowledge, media), which the auditor must never see.
 * - `auditor-read`: the auditor's narrow read surface, open to every role.
 */
export type RouteGate = "audit" | "administer" | "agents" | "read" | "auditor-read";

/**
 * The auditor's whole surface, `METHOD path` exactly as `routeRegistrations()` prints it.
 * Sign-in housekeeping, the desks and orgs the shell lists, and Usage. Nothing else — a path
 * added elsewhere is refused to the auditor by default.
 */
export const AUDITOR_READ_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/ping",
  "GET /api/v1/auth/session",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/refresh",
  "GET /api/v1/usage",
  "GET /api/v1/storage/usage",
  "GET /api/v1/workspaces",
  "GET /api/v1/organizations",
  "GET /api/v1/settings",
  "GET /api/v1/billing/plan",
  "GET /api/v1/billing/plans",
  "GET /api/v1/health",
]);

/**
 * Routes that change agents, data sources, keys, channels or settings: `canAdminister`.
 * Reads of the same resources stay `read` — a member sees the state, only an admin changes it.
 */
export const ADMINISTER_ROUTES: ReadonlySet<string> = new Set([
  // Settings and keys.
  // The settings mutations are `agents`, not administer: `handlePostSettings` keeps the role split
  // itself — a member still saves what is theirs (`locale`, the guide and key-later records, the
  // gateway probe) and every shared field is refused for a non-admin in server mode
  // (`SETTINGS_KEY_FORBIDDEN` / operator-only in handlers/settings.ts).
  // settings/reset keeps its own refusal (`tenant_reset_forbidden`, handlers/settings.ts): the gate
  // lets member and builder reach it so that code is the answer, and the auditor never gets there
  // because the route is a mutation — `agents`.
  // Billing and components.
  "POST /api/v1/billing/top-up",
  "POST /api/v1/components/install/stream",
  // Desks and the agents on them. Selecting a desk is the person's own preference, not administer.
  "POST /api/v1/workspaces",
  "PATCH /api/v1/workspaces/:workspaceId",
  "DELETE /api/v1/workspaces/:workspaceId",
  "POST /api/v1/workspaces/:workspaceId/agents",
  "POST /api/v1/agents/:agentId/tools",
  "POST /api/v1/agents/:agentId/soul",
  "POST /api/v1/agents/:agentId/publish",
  "POST /api/v1/agents/:agentId/share",
  "POST /api/v1/agents/:agentId/product-modes",
  "POST /api/v1/agents/:agentId/generate-defaults",
  // Team membership: hire/release enforce their own ownership rule (a builder manages the bot it
  // created, `requireOwned` in handlers/team.ts), so they are `agents` — the auditor is refused
  // anyway and a member who does not own the bot gets the handler's 403, not this gate's.
  // MCP connectors.
  "POST /api/v1/mcp/connectors/:connectorId",
  "DELETE /api/v1/mcp/connectors/:connectorId",
  "POST /api/v1/mcp/connectors/:connectorId/test",
  // Channels and customers (data sources).
  "POST /api/v1/channels/telegram/bot",
  "DELETE /api/v1/channels/telegram/bot",
  "POST /api/v1/channels/telegram/poll",
  "POST /api/v1/channels",
  "DELETE /api/v1/channels/:channelId",
  "POST /api/v1/channels/:channelId/send",
  "POST /api/v1/customers/whatsapp",
  "DELETE /api/v1/customers/whatsapp",
  // Datasets (data sources).
  "POST /api/v1/datasets",
  "DELETE /api/v1/datasets/:datasetId",
  // Knowledge: the backend/model configuration is administer. Content operations (sources,
  // memories, map, reindex) are `agents` — a member works its own desk's knowledge, and the
  // handler's privacy rules (a colleague's hidden card is answered as absent) stay intact.
  "PUT /api/v1/knowledge/backend",
  "POST /api/v1/knowledge/backend/reindex",
  "POST /api/v1/knowledge/verify",
  "PUT /api/v1/knowledge/models",
  // Registered models.
  "POST /api/v1/models",
]);

/** The audit-only surface. Empty until the Activity Log and audit export routes land (F2). */
export const AUDIT_ROUTES: ReadonlySet<string> = new Set([]);

/**
 * The gate one registered route needs, keyed by the same `method`/`route.path` the route table
 * carries (`/api/v1/threads/:threadId`, never a concrete path).
 */
export function routeGate(method: string, routePath: string): RouteGate {
  const key = `${method.toUpperCase()} ${routePath}`;
  if (AUDIT_ROUTES.has(key)) {
    return "audit";
  }
  if (ADMINISTER_ROUTES.has(key)) {
    return "administer";
  }
  if (AUDITOR_READ_ROUTES.has(key)) {
    return "auditor-read";
  }
  // A mutation nobody classified is an agent action — safe against the auditor by default.
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return "agents";
  }
  return "read";
}

/** What denying a route's gate costs the caller, when the membership role does not carry it. */
export function roleDenied(role: MembershipRole, gate: RouteGate): string | null {
  switch (gate) {
    case "audit":
      return canAudit(role) ? null : "Your role cannot read the audit surface.";
    case "administer":
      return canAdminister(role) ? null : "Only an owner or an admin can change this.";
    case "agents":
      return canUseAgents(role) ? null : "An auditor cannot run agents.";
    case "read":
      return role === "auditor" ? "An auditor sees the Activity Log and Usage, not content." : null;
    case "auditor-read":
      return null;
  }
}
