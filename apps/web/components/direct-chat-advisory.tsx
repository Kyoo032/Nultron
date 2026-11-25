"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";

/**
 * Non-blocking advisory shown when the owner opens a direct chat with a specialist or team bot.
 * Encourages using the single primary Chat orchestrator so all team knowledge stays unified, while
 * preserving the privilege to message this bot directly.
 */
const DISMISS_STORAGE_KEY = "nultron-direct-chat-advisory-dismissed";

function isAdvisoryDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function DirectChatAdvisory({ agentName, brandName }: { agentName: string; brandName: string }) {
  const [dismissed, setDismissed] = useState(isAdvisoryDismissed);
  if (dismissed) {
    return null;
  }
  function onDismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, "1");
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }
  return (
    <div
      role="status"
      data-testid="direct-chat-advisory"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--surface-2,var(--surface))] px-4 py-2 text-xs text-[var(--text-2)]"
    >
      <p className="min-w-0 flex-1">
        {t("agents.directAdvisory.body", { name: agentName, brand: brandName })}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/chat"
          className="font-medium text-[var(--accent)] hover:underline"
          data-testid="direct-chat-back-main"
        >
          {t("agents.directAdvisory.backToMain", { brand: brandName })}
        </Link>
        <button
          type="button"
          className="text-[var(--text-3)] hover:text-[var(--text)]"
          aria-label={t("agents.directAdvisory.dismiss")}
          onClick={onDismiss}
          data-testid="direct-chat-dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
