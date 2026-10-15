import type { TenantContext } from "@agentforge/core";
import { ENTERPRISE_FIRST_DESK_MODES, HOSTED_FIRST_DESK_MODES } from "@agentforge/core/product-modes";
import type { PortalProvisioning } from "@agentforge/db";
import { resolvedShell } from "./shell-setting";

export async function provisionPortalDesk(identity: PortalProvisioning): Promise<TenantContext> {
  const firstDeskModes = resolvedShell() === "enterprise" ? ENTERPRISE_FIRST_DESK_MODES : HOSTED_FIRST_DESK_MODES;
  const { db, ensurePortalOwner } = await import("@agentforge/db");
  return ensurePortalOwner(db, identity, { firstDeskModes });
}
