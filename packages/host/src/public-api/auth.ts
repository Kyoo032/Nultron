/**
 * F5a — `Authorization: Bearer nk_live_…` to a service identity.
 *
 * Resolved **before** the session gate in `router.ts` and only under the public prefix:
 * a key never opens a session-only route (`session-routes-refuse-keys.test.ts` walks the
 * whole route table to keep it that way), and a session cookie never opens the public
 * table. The two audiences are disjoint by construction.
 *
 * The identity a key resolves to is a **service identity** — `userId` is `apikey-<id>`,
 * role `member`, never an owner identity — so a run it starts cannot approve F3 actions
 * and the audit trail names `actor_kind: 'api_key'` with the key id, per spec S-rules.
 */
import { ApiError, type TenantContext } from "@agentforge/core";
import { db, getTenantById, organizations, workspaces } from "@agentforge/db";
import { and, eq } from "drizzle-orm";
import { resolveApiKey, touchApiKey, type ApiKeyRow } from "./keys";

export const PUBLIC_API_PREFIX = "/api/public/v1";
/** The OpenAI-compatible facade is one endpoint group; it is also reachable at the bare path. */
export const OPENAI_FACADE_PATH = "/v1/chat/completions";
export const PUBLIC_API_ENV = "AGENTFORGE_PUBLIC_API";

export function isPublicApiPath(path: string): boolean {
  return path === OPENAI_FACADE_PATH || path === PUBLIC_API_PREFIX || path.startsWith(`${PUBLIC_API_PREFIX}/`);
}

/**
 * `on`, `true` or `1`; unset and anything else is off. Off until QA passes — the flag is
 * read per request so a process can be switched without a restart.
 */
export function publicApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PUBLIC_API_ENV]?.trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export type ServiceIdentity = {
  readonly key: ApiKeyRow;
  readonly tenant: TenantContext;
};

function bearerToken(request: { headers: Record<string, string | undefined> }): string | null {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header || !/^Bearer\s+/i.test(header)) {
    return null;
  }
  return header.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Bearer → `{ key, tenant }`. The tenant is resolved straight from the key's `tenant_id`
 * (its org and home desk), NOT through `getTenant`'s session path: there is no session on
 * a public call and there must not be a synthetic one.
 */
export async function authenticatePublic(request: {
  headers: Record<string, string | undefined>;
}): Promise<ServiceIdentity> {
  const key = resolveApiKey(bearerToken(request));
  const tenant = await getTenantById(db, key.tenant_id);
  if (tenant?.status !== "active") {
    throw new ApiError("tenant_inactive", "Your provider's account is not active. Contact support.", 403);
  }
  const [org] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.tenantId, tenant.id)))
    .limit(1);
  if (!org) {
    throw new ApiError("org_inactive", "Your organisation is not active.", 403);
  }
  const desks = await db.select().from(workspaces).where(eq(workspaces.organizationId, org.id));
  if (desks.length === 0) {
    throw new ApiError("workspace_not_found", "Workspace not found", 404);
  }
  const home = desks.find((desk) => desk.slug === "home") ?? desks[0];
  touchApiKey(key.id);
  return {
    key,
    tenant: {
      tenantId: tenant.id,
      organizationId: org.id,
      workspaceId: home.id,
      userId: `apikey-${key.id}`,
      role: "member",
    },
  };
}
