import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_ROLES,
  canAdminister,
  canAudit,
  canBuild,
  canUseAgents,
  membershipRoleForPortal,
  parsePortalRole,
} from "./types";

/**
 * F8a — the OPC Auditor seat: a read-only delegation that sees the Activity Log and Usage, never
 * content, and cannot run agents. The Owner is Admin + Auditor with no flag and no extra step.
 */

describe("the auditor role", () => {
  it("is a portal role and a membership role", () => {
    expect(parsePortalRole("auditor")).toBe("auditor");
    expect(membershipRoleForPortal("auditor")).toBe("auditor");
    expect(MEMBERSHIP_ROLES).toContain("auditor");
  });

  it("is refused in every near-miss spelling, like every role claim", () => {
    for (const value of ["Auditor", " auditor", "auditor ", "AUDITOR"]) {
      expect(parsePortalRole(value)).toBeNull();
      expect(membershipRoleForPortal(parsePortalRole(value))).toBe("member");
    }
  });
});

describe("canAudit", () => {
  it("is true for owner and auditor only", () => {
    expect(canAudit("owner")).toBe(true);
    expect(canAudit("auditor")).toBe(true);
    expect(canAudit("admin")).toBe(false);
    expect(canAudit("builder")).toBe(false);
    expect(canAudit("member")).toBe(false);
  });
});

describe("canUseAgents", () => {
  it("is false for the auditor alone", () => {
    expect(canUseAgents("auditor")).toBe(false);
    expect(canUseAgents("owner")).toBe(true);
    expect(canUseAgents("admin")).toBe(true);
    expect(canUseAgents("builder")).toBe(true);
    expect(canUseAgents("member")).toBe(true);
  });
});

describe("the auditor against the existing bars", () => {
  it("cannot build and cannot administer", () => {
    expect(canBuild("auditor")).toBe(false);
    expect(canAdminister("auditor")).toBe(false);
  });

  it("leaves the owner with every right and no extra step", () => {
    for (const role of ["owner", "admin", "builder", "member"] as const) {
      expect(canUseAgents(role)).toBe(true);
    }
    expect(canAudit("owner")).toBe(true);
    expect(canAdminister("owner")).toBe(true);
    expect(canBuild("owner")).toBe(true);
  });
});
