export const MEMBERSHIP_ROLES = ["owner", "admin", "builder", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * The role claim the hosted portal sends beside `tenant_id` in every token body
 * (`apps/portal/src/flows/token.ts`): exactly these three strings. It is the portal's fact about
 * the person, read from the member's row at every mint and refresh. `MembershipRole` is the wider
 * set the host's own tables may hold (`builder` is the host's, not the portal's).
 */
export const PORTAL_ROLES = ["owner", "admin", "member"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

/**
 * A claim read as a role, or `null`. Exact match only: `"Owner"`, `" owner"` and `"builder"` are not
 * roles. A missing or unknown claim is "no role" — least privilege — and never an owner.
 */
export function parsePortalRole(value: unknown): PortalRole | null {
  return typeof value === "string" && (PORTAL_ROLES as readonly string[]).includes(value)
    ? (value as PortalRole)
    : null;
}

/**
 * The role the host writes for what the portal said. No role is `member`: the host grants `owner` or
 * `admin` only when the portal says so, so every first-time sign-in is never an owner by default.
 */
export function membershipRoleForPortal(role: PortalRole | null): MembershipRole {
  return role ?? "member";
}

export const INDUSTRY_PACKS = ["university", "generic"] as const;
export type IndustryPack = (typeof INDUSTRY_PACKS)[number];

export const VISIBILITIES = ["private", "workspace"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const INPUT_MODALITIES = ["text", "image", "video"] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];

export type TenantContext = {
  /** The whitelabel partner the row belongs to. `LOCAL_TENANT_ID` on desktop and webdev. */
  tenantId: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  role: MembershipRole;
};

export function requireTenant(tenant: TenantContext | null | undefined): TenantContext {
  if (!tenant) {
    throw new Error("tenant_required");
  }
  return tenant;
}

export function canBuild(role: MembershipRole): boolean {
  return role === "owner" || role === "admin" || role === "builder";
}

export function canAdminister(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}
