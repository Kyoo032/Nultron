import { DEFAULT_PRODUCT_NAME } from "@agentforge/core/gateway";
import { t } from "@/lib/i18n";

export function enterpriseBrandName(productName: string): string {
  const name = productName.trim();
  return name && name !== DEFAULT_PRODUCT_NAME ? name : t("agents.rail.enterpriseFallbackName");
}
