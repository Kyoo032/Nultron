import { isServerMode } from "@agentforge/core";
import { resolvedShell } from "../shell-setting";

export function mediaApprovalOn(): boolean {
  return isServerMode() && resolvedShell() === "enterprise";
}
