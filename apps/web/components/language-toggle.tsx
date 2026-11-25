"use client";

import { useState } from "react";
import type { AppLocale } from "@agentforge/core/locale";
import { t } from "@/lib/i18n";
import { useLocale } from "@/lib/locale-context";
import { switchAppLocale } from "@/lib/switch-locale";

export function LanguageToggle({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const current: AppLocale = useLocale();
  const next: AppLocale = current === "en" ? "id" : "en";
  const label = current === "en" ? t("common.languageToggle.toIndonesian") : t("common.languageToggle.toEnglish");

  async function onToggle() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await switchAppLocale(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onToggle()}
      disabled={busy}
      className={
        className ??
        "btn btn-ghost btn-icon h-8 w-8 shrink-0 rounded-md text-[11px] font-semibold tracking-wide text-[var(--rail-text-2)] hover:bg-[var(--rail-hover)] hover:text-[var(--rail-active-text)]"
      }
      aria-label={label}
      title={label}
      data-testid="language-toggle"
      data-locale={current}
    >
      {current.toUpperCase()}
    </button>
  );
}
