import type { ReactNode } from "react";
import { SHELL_LAYOUT, type ProductMode } from "@agentforge/core/product-modes";
import { AgentRail } from "@/components/agent-rail";
import { AppRail } from "@/components/app-rail";
import { DeskBuddyReactions } from "@/components/desk-buddy-reactions";
import { DeskBackdrop } from "@/components/desk-backdrop";
import { ModeRedirect } from "@/components/mode-redirect";
import { buddyAllowedAt } from "@/lib/buddy-routes";
import { usePathname } from "@/lib/nav";
import { modeRedirectAllowed, type ShellModesSource } from "@/lib/shell-modes";

type Props = {
  workspaceName: string;
  visibleModes: ProductMode[];
  /** Where `visibleModes` came from (`lib/shell-modes.ts`); the host's answer is the default. */
  modesSource?: ShellModesSource;
  children: ReactNode;
};

export function productMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "A";
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  }
  return trimmed.slice(0, 1).toUpperCase();
}

export function AppShell({ workspaceName, visibleModes, modesSource = "host", children }: Props) {
  const pathname = usePathname();
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-app text-inkbase">
      {/* A remembered or unknown list is only good for the first frame: nobody is redirected on it. */}
      <ModeRedirect visibleModes={visibleModes} settled={modeRedirectAllowed(modesSource)} />
      {SHELL_LAYOUT === "chat-first" ? (
        <AgentRail visibleModes={visibleModes} modesSource={modesSource} />
      ) : (
        <AppRail workspaceName={workspaceName} visibleModes={visibleModes} modesSource={modesSource} />
      )}
      {/* The buddy stands in the rail; this draws nothing and only gives it its shell-level reactions. */}
      {!buddyAllowedAt(pathname) ? null : <DeskBuddyReactions />}
      <div className="desk-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="app-main-panel">
        <DeskBackdrop />
        {/* Not a scroller, and not keyed on the route. Each desk page owns one
            scrollport (`DeskPane`). Keying this slot remounted every page on
            navigation, which dropped scroll position and the kept-alive modes. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
