import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppLocale } from "@agentforge/core/locale";
import { getLocale, LOCALE_RESTART_EVENT, subscribeLocale } from "@/lib/i18n";

export const LocaleContext = createContext<AppLocale | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): AppLocale {
  return useContext(LocaleContext) ?? getLocale();
}

export function useLocaleEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const onRestart = () => setEpoch((current) => current + 1);
    window.addEventListener(LOCALE_RESTART_EVENT, onRestart);
    return () => window.removeEventListener(LOCALE_RESTART_EVENT, onRestart);
  }, []);
  return epoch;
}
