import { isServerMode, type StoredSecrets } from "@agentforge/core";

const bypassed = new Set<string>();

function slot(tenantId: string, workspaceId: string): string {
  return JSON.stringify([tenantId, workspaceId]);
}

export function setInjectionGuardBypass(tenantId: string, workspaceId: string, on: boolean): void {
  if (on && !isServerMode()) {
    bypassed.add(slot(tenantId, workspaceId));
    return;
  }
  bypassed.delete(slot(tenantId, workspaceId));
}

export function withInjectionGuardBypass(secrets: StoredSecrets, tenantId: string, workspaceId: string): StoredSecrets {
  return !isServerMode() && bypassed.has(slot(tenantId, workspaceId))
    ? { ...secrets, injectionGuardBypass: true }
    : secrets;
}

export function carriesStoredBypass(workspaces: Record<string, unknown>): boolean {
  return Object.values(workspaces).some(
    (slice) => slice !== null && typeof slice === "object" && "injectionGuardBypass" in slice,
  );
}
