import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppLocale } from "@agentforge/core/locale";
import { getLocale, LOCALE_RESTART_EVENT } from "@/lib/i18n";

export const LocaleContext = createContext<AppLocale | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  useLocaleEpoch();
  return <LocaleContext.Provider value={getLocale()}>{children}</LocaleContext.Provider>;
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
