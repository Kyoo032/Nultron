import type { AppLocale } from "@agentforge/core/locale";
import { apiFetch } from "@/lib/api-client";
import { applyLocale, LOCALE_RESTART_EVENT } from "@/lib/i18n";

export type SwitchLocaleResult = { ok: true; locale: AppLocale } | { ok: false; message: string };

export async function switchAppLocale(
  next: AppLocale,
  fetchFn: typeof apiFetch = apiFetch,
): Promise<SwitchLocaleResult> {
  try {
    const saveRes = await fetchFn("/api/v1/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    if (!saveRes.ok) {
      return { ok: false, message: `HTTP ${saveRes.status}` };
    }
    const applyRes = await fetchFn("/api/v1/settings/apply-locale", { method: "POST" });
    if (!applyRes.ok) {
      return { ok: false, message: `HTTP ${applyRes.status}` };
    }
    const applied = applyLocale(next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(LOCALE_RESTART_EVENT));
    }
    return { ok: true, locale: applied };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to switch language" };
  }
}
