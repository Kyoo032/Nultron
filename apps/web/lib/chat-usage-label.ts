import { t } from "./i18n";

export function remainingUsageLabel(
  remainingUsd: number | null | undefined,
  format: (usd: number) => string,
): string | null {
  return remainingUsd == null ? null : t("chat.usage.remaining", { left: format(remainingUsd) });
}
