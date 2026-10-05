import { describe, expect, it } from "vitest";
import {
  PORTAL_ROLES,
  canAdminister,
  canBuild,
  membershipRoleForPortal,
  parsePortalRole,
  requireTenant,
  type TenantContext,
} from "./types";

describe("requireTenant", () => {
  it("returns the tenant when present", () => {
    const tenant: TenantContext = {
      tenantId: "local-tenant",
      organizationId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "builder",
    };
    expect(requireTenant(tenant)).toEqual(tenant);
  });

  it("throws when tenant is missing", () => {
    expect(() => requireTenant(null)).toThrow("tenant_required");
    expect(() => requireTenant(undefined)).toThrow("tenant_required");
  });
});

describe("canBuild", () => {
  it("allows owner admin and builder", () => {
    expect(canBuild("owner")).toBe(true);
    expect(canBuild("admin")).toBe(true);
    expect(canBuild("builder")).toBe(true);
    expect(canBuild("member")).toBe(false);
  });
});

describe("the portal's role claim", () => {
  it("is exactly owner, admin or member", () => {
    expect([...PORTAL_ROLES]).toEqual(["owner", "admin", "member"]);
    for (const role of PORTAL_ROLES) {
      expect(parsePortalRole(role)).toBe(role);
    }
  });

  it("reads anything else as no role, never as a privilege", () => {
    const notRoles: unknown[] = [
      undefined,
      null,
      "",
      " owner",
      "Owner",
      "OWNER",
      "owner ",
      "builder",
      "superuser",
      "root",
      "admin,owner",
      0,
      1,
      true,
      ["owner"],
      { role: "owner" },
    ];
    for (const value of notRoles) {
      expect(parsePortalRole(value)).toBeNull();
    }
  });

  it("maps no role to the least privilege, and each portal role to itself", () => {
    expect(membershipRoleForPortal(null)).toBe("member");
    expect(membershipRoleForPortal("owner")).toBe("owner");
    expect(membershipRoleForPortal("admin")).toBe("admin");
    expect(membershipRoleForPortal("member")).toBe("member");
    expect(canAdminister(membershipRoleForPortal(null))).toBe(false);
  });
});
