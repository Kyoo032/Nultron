"use client";

import type { ReactNode } from "react";
import { Link, usePathname } from "@/lib/nav";
import { t } from "@/lib/i18n";

export type SettingsTab = {
  readonly id: "general" | "users" | "channels" | "customers" | "activity" | "mcp" | "data-sources";
  readonly href: string;
  readonly labelKey: string;
  readonly testId: string;
};

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", href: "/settings", labelKey: "settings.tabs.general", testId: "settings-tab-general" },
  { id: "users", href: "/users", labelKey: "settings.tabs.users", testId: "settings-tab-users" },
  { id: "channels", href: "/channels", labelKey: "settings.tabs.channels", testId: "settings-tab-channels" },
  { id: "customers", href: "/customers", labelKey: "settings.tabs.customers", testId: "settings-tab-customers" },
  { id: "activity", href: "/activity", labelKey: "settings.tabs.activity", testId: "settings-tab-activity" },
  { id: "mcp", href: "/mcp", labelKey: "settings.tabs.mcp", testId: "settings-tab-mcp" },
  {
    id: "data-sources",
    href: "/data-sources",
    labelKey: "settings.tabs.dataSources",
    testId: "settings-tab-data-sources",
  },
];

export const SETTINGS_HUB_PATHS: readonly string[] = SETTINGS_TABS.map((tab) => tab.href);

/** True when `pathname` belongs to any section hosted inside the unified Settings hub. */
export function isSettingsHubPath(pathname: string): boolean {
  return SETTINGS_HUB_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-full w-full flex-col text-[var(--text)]" data-testid="settings-shell">
      <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--surface)]/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-[var(--content-wide)] flex-col gap-3 px-6 pt-5">
          <div className="flex items-center justify-between gap-4">
            <h1 className="font-heading text-lg font-semibold tracking-[var(--track)] text-[var(--text)]">
              {t("settings.title")}
            </h1>
          </div>
          <nav
            className="-mb-px flex items-center gap-1 overflow-x-auto"
            aria-label={t("settings.tabs.aria")}
            data-testid="settings-tabs"
          >
            {SETTINGS_TABS.map((tab) => {
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
