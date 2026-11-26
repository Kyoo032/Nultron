import type { MembershipRole } from "@agentforge/core";

export const universityLabels: Record<MembershipRole, string> = {
  owner: "Campus admin",
  admin: "Faculty admin",
  builder: "Builder",
  member: "Student",
  auditor: "Auditor",
};

export const universityPack = {
  id: "university" as const,
  organizationName: "Harbor State University",
  organizationSlug: "harbor-state",
  workspaceName: "General Studies",
  workspaceSlug: "general-studies",
  labels: universityLabels,
};
