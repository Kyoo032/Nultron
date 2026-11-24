import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_PRODUCT_NAME, GATEWAY_BASE_URL, GATEWAY_NAME } from "@agentforge/core/gateway";
import { pingOnce } from "@/lib/host-ping";

export type ProductBrand = {
  productName: string;
  gatewayName: string;
  gatewayBaseUrl: string;
  logoSrc: string;
  /**
   * Tester code: the brand's character, which is the name of the default virtual agent. Absent means
   * the brand names none, and the character carries the product's name (`assistantNameOf`).
   */
  assistantName?: string;
};

/**
 * The default virtual agent's name (owner, 2026-10-09): the brand's own character. A brand that
 * names its character says so in its settings (the host answers `assistantName` on `/api/v1/ping`);
 * one that does not gets the product's name. No character is named in this code.
 */
export function assistantNameOf(brand: Pick<ProductBrand, "productName" | "assistantName">): string {
  return brand.assistantName?.trim() || brand.productName;
}

export const DEFAULT_PRODUCT_BRAND: ProductBrand = {
  productName: DEFAULT_PRODUCT_NAME,
  gatewayName: GATEWAY_NAME,
  gatewayBaseUrl: GATEWAY_BASE_URL,
  logoSrc: "",
};

/**
 * The Nultron logo tile at 256 px, served from `apps/web/public/brand/`.
 *
 * The MARK is the only thing the hosted web adds to the brand. The NAME is
 * `DEFAULT_PRODUCT_NAME` -- the same constant `/api/v1/ping` answers `productName` with -- so the
 * shell, the renderer and the host cannot disagree about what the product is called. There used to
 * be a `WEB_PRODUCT_NAME` here saying something else, and `mergePingBrand` spent a branch keeping
 * the two apart; deleting the second name deletes the drift rather than managing it.
 */
export const WEB_LOGO_SRC = "/brand/logo.png";

export function usesBundledMark(brand: ProductBrand): boolean {
  return brand.logoSrc === WEB_LOGO_SRC || brand.productName === DEFAULT_PRODUCT_NAME;
}

export function usesNultronWordmark(brand: ProductBrand): boolean {
  return brand.productName === DEFAULT_PRODUCT_NAME;
}

const BrandContext = createContext<ProductBrand>(DEFAULT_PRODUCT_BRAND);

export function useProductBrand(): ProductBrand {
  return useContext(BrandContext);
}

export function gatewayHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function brandFromUnknown(payload: unknown, fallback: ProductBrand): ProductBrand {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const productName =
    typeof record.productName === "string" && record.productName.trim()
      ? record.productName.trim()
      : fallback.productName;
  const gatewayName =
    typeof record.gatewayName === "string" && record.gatewayName.trim()
      ? record.gatewayName.trim()
      : fallback.gatewayName;
  const gatewayBaseUrl =
    typeof record.gatewayBaseUrl === "string" && record.gatewayBaseUrl.trim()
      ? record.gatewayBaseUrl.trim()
      : fallback.gatewayBaseUrl;
  const assistantName =
    typeof record.assistantName === "string" && record.assistantName.trim()
      ? record.assistantName.trim()
      : fallback.assistantName;
  return {
    ...fallback,
    productName,
    gatewayName,
    gatewayBaseUrl,
    ...(assistantName ? { assistantName } : {}),
  };
}

export function mergePingBrand(current: ProductBrand, payload: unknown): ProductBrand {
  const next = brandFromUnknown(payload, current);
  const keepPreloadName =
    current.productName !== DEFAULT_PRODUCT_BRAND.productName &&
    next.productName === DEFAULT_PRODUCT_BRAND.productName;
  const keepPreloadGateway =
    current.gatewayName !== DEFAULT_PRODUCT_BRAND.gatewayName &&
    next.gatewayName === DEFAULT_PRODUCT_BRAND.gatewayName;
  const { assistantName: pingAssistant, ...rest } = next;
  const assistantName = keepPreloadName ? current.assistantName : pingAssistant;
  return {
    ...rest,
    ...(assistantName ? { assistantName } : {}),
    productName: keepPreloadName ? current.productName : next.productName,
    gatewayName: keepPreloadGateway ? current.gatewayName : next.gatewayName,
    gatewayBaseUrl: keepPreloadName ? current.gatewayBaseUrl : next.gatewayBaseUrl,
    logoSrc: current.logoSrc || next.logoSrc,
  };
}

function preloadBrand(): ProductBrand {
  return { ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC };
}

export function ProductBrandProvider({ children }: { children: ReactNode }) {
  const [brand, setBrand] = useState(preloadBrand);

  useEffect(() => {
    document.title = brand.productName;
  }, [brand.productName]);

  useEffect(() => {
    void pingOnce().then((payload) => {
      if (payload !== null) {
        setBrand((current) => mergePingBrand(current, payload));
      }
    });
  }, []);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
