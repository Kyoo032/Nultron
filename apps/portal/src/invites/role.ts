/**
 * Changing the role of a member who is already in: `pnpm --filter @agentforge/portal invite --role`
 * run for an address that is an active member.
 *
 * An invite carries a role (`issue.ts`) and redeeming it sets the member's. This is the one other
 * place a role changes, and it is the operator's alone: there is no portal endpoint, form or token
 * that can promote anyone, so "who may change a role" is "whoever may run this against the portal's
 * own database". It leaves the member's sessions standing; the new role reaches the host in the next
 * access token (the portal reads it from the member's row at every mint and every refresh).
 *
 * One rule, the same one issuing an invite keeps: a tenant is never left without an owner. Demoting
 * the last owner who is not disabled is refused.
 */
import { normaliseEmail } from "../crypto";
import type { PortalStore, UserRole } from "../store/types";

export interface ChangeRoleInput {
  readonly tenantSlug: string;
  readonly email: string;
  readonly role: UserRole;
}

export type ChangeRoleRefusal =
  | "unknown_tenant"
  /** No such member, or an address that is not in this tenant. */
  | "not_a_member"
  /** Still `invited`: the role is the invite's, so re-invite instead. */
  | "not_active"
  | "user_disabled"
  | "same_role"
  | "last_owner";

export type ChangeRoleResult =
  | {
      readonly ok: true;
      readonly email: string;
      readonly tenantSlug: string;
      readonly userId: string;
      readonly from: UserRole;
      readonly to: UserRole;
    }
  | { readonly ok: false; readonly reason: ChangeRoleRefusal };

export async function changeMemberRole(store: PortalStore, input: ChangeRoleInput): Promise<ChangeRoleResult> {
  const email = normaliseEmail(input.email);
  const tenantId = await store.resolve.bySlug(input.tenantSlug);
  if (!tenantId) {
    return { ok: false, reason: "unknown_tenant" };
  }

  return store.tx(tenantId, async (ops) => {
    const member = await ops.users.findByEmail(tenantId, email);
    if (!member) {
      return { ok: false as const, reason: "not_a_member" as const };
    }
    if (member.status === "disabled") {
      return { ok: false as const, reason: "user_disabled" as const };
    }
    if (member.status === "invited") {
      return { ok: false as const, reason: "not_active" as const };
    }
    if (member.role === input.role) {
      return { ok: false as const, reason: "same_role" as const };
    }
    if (member.role === "owner" && (await ops.users.lockOwners(tenantId)) <= 1) {
      return { ok: false as const, reason: "last_owner" as const };
    }

    await ops.users.setRole(member.id, input.role);
    await ops.audit.append({
      tenantId,
      orgId: member.orgId,
      actorKind: "support",
      action: "member.role_changed",
      targetKind: "user",
      targetId: member.id,
      before: { role: member.role },
      after: { role: input.role },
    });
    return {
      ok: true as const,
      email,
      tenantSlug: input.tenantSlug,
      userId: member.id,
      from: member.role,
      to: input.role,
    };
  });
}

/** What the CLI prints when it changed a role. */
export function formatRoleReport(result: Extract<ChangeRoleResult, { readonly ok: true }>): string {
  return [
    `address    ${result.email}`,
    `tenant     ${result.tenantSlug}`,
    `role       ${result.from} -> ${result.to}`,
    "",
    "No invite was sent: this address is already an active member. The new role reaches the host in",
    "the person's next access token, which is minted at sign-in and on every refresh.",
    "",
  ].join("\n");
}
