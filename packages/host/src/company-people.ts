import { sql } from "@agentforge/db";
import type { TenantContext } from "@agentforge/core";

export type CompanyScope = Pick<TenantContext, "tenantId" | "organizationId">;

export type CompanyPerson = { readonly userId: string; readonly name: string };

export function listCompanyPeople(scope: CompanyScope): CompanyPerson[] {
  return sql
    .prepare(
      `SELECT u.id AS userId, u.name AS name
         FROM organization_members om
         JOIN organizations o ON o.id = om.organization_id
         JOIN user u ON u.id = om.user_id
        WHERE om.organization_id = ? AND o.tenant_id = ?
        ORDER BY u.name, u.id`,
    )
    .all(scope.organizationId, scope.tenantId) as CompanyPerson[];
}

export function isCompanyMember(scope: CompanyScope, userId: string): boolean {
  return (
    sql
      .prepare(
        `SELECT 1 AS ok FROM organization_members om JOIN organizations o ON o.id = om.organization_id
          WHERE om.organization_id = ? AND o.tenant_id = ? AND om.user_id = ?`,
      )
      .get(scope.organizationId, scope.tenantId, userId) !== undefined
  );
}
