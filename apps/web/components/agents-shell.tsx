"use client";

import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Link, usePathname } from "@/lib/nav";

export type AgentsTab = {
  readonly id: "agents" | "team";
  readonly href: string;
  readonly labelKey: string;
  readonly testId: string;
};

export const AGENTS_TABS: readonly AgentsTab[] = [
  { id: "agents", href: "/workspaces", labelKey: "agents.tabs.agents", testId: "agents-tab-agents" },
  { id: "team", href: "/team", labelKey: "agents.tabs.team", testId: "agents-tab-team" },
];

export const AGENTS_HUB_PATHS: readonly string[] = AGENTS_TABS.map((tab) => tab.href);

/** True when `pathname` belongs to any section hosted inside the Agents hub. */
export function isAgentsHubPath(pathname: string): boolean {
  return AGENTS_HUB_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AgentsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-full w-full flex-col text-[var(--text)]" data-testid="agents-shell">
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--surface)]/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[var(--content-wide)] flex-col gap-3 px-6 pt-5">
          <div className="flex items-center justify-between gap-4">
            <h1 className="font-heading text-lg font-semibold tracking-[var(--track)] text-[var(--text)]">
              {t("rail.agents")}
            </h1>
          </div>
          <nav
            className="-mb-px flex items-center gap-1 overflow-x-auto"
            aria-label={t("agents.tabs.aria")}
            data-testid="agents-tabs"
          >
            {AGENTS_TABS.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  data-testid={tab.testId}
                  className={
                    active
                      ? "relative shrink-0 border-b-2 border-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-[var(--text)]"
                      : "relative shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-[var(--text-3)] hover:text-[var(--text)]"
                  }
                >
                  {t(tab.labelKey)}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
